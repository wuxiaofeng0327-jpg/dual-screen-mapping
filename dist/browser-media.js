import {Input,BlobSource,ALL_FORMATS,Output,Mp4OutputFormat,BufferTarget,StreamTarget,
  Conversion,Quality,CanvasSink} from './vendor/mediabunny.mjs';
import {PixelRenderer} from './pixel-renderer.js';

const openInput=file=>new Input({source:new BlobSource(file),formats:ALL_FORMATS});
const labels={wrap:'环幕展开',roof:'天幕平面',combined:'双幕拼接',warp:'原画幅变形'};
const canceled=()=>new DOMException('已取消','AbortError');
const assertRunning=signal=>{if(signal?.aborted)throw canceled();};
function strictConversion(conversion){
  const dropped=conversion.discardedTracks.filter(d=>d.track.isVideoTrack()||d.track.isAudioTrack());
  if(!conversion.isValid||dropped.length)throw Error('浏览器不支持此视频或音频的完整编解码，未降低尺寸或丢弃声音。请使用 H.264 + AAC 素材，或在本地版导出。');
}
export async function importMedia(file){
  const s={id:crypto.randomUUID(),name:file.name,file,url:URL.createObjectURL(file),pixelFormat:'',kind:'video'};
  try{
    if(file.type.startsWith('image/')||/\.(png|jpe?g|webp|bmp)$/i.test(file.name)){
      const image=new Image();image.src=s.url;await image.decode();
      return {...s,kind:'image',width:image.naturalWidth,height:image.naturalHeight,fps:0,duration:0,frames:1};
    }
    const input=openInput(file);
    try{
      const track=await input.getPrimaryVideoTrack();
      if(!track||!await track.canDecode())throw Error('浏览器不能解码这个视频，请使用 H.264 MP4，或在本地版打开。');
      const [width,height,duration,stats,codec]=await Promise.all([
        track.getDisplayWidth(),track.getDisplayHeight(),input.computeDuration(),track.computePacketStats(120),track.getCodec()]);
      if(!Number.isFinite(duration)||duration<=0)throw Error('无法读取视频时长');
      const fps=stats.averagePacketRate||30;
      return {...s,width,height,duration,fps,frames:Math.max(1,Math.round(duration*fps)),codec};
    }finally{input.dispose();}
  }catch(error){URL.revokeObjectURL(s.url);throw error;}
}
export async function compatiblePreview(source,signal,onProgress){
  const input=openInput(source.file),output=new Output({format:new Mp4OutputFormat(),target:new BufferTarget()});
  let c;
  const abort=()=>c?.cancel().catch(()=>{});
  try{
    assertRunning(signal);
    c=await Conversion.init({input,output,tracks:'primary',video:{codec:'avc',width:Math.min(1920,source.width),quality:new Quality({bitrate:8e6})},audio:{codec:'aac'},showWarnings:false});
    strictConversion(c);c.onProgress=onProgress;signal.addEventListener('abort',abort,{once:true});assertRunning(signal);
    await c.execute();return URL.createObjectURL(new Blob([output.target.buffer],{type:'video/mp4'}));
  }finally{signal.removeEventListener('abort',abort);input.dispose();}
}
function prepareMap(request,signal,onProgress){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./export-worker.js',import.meta.url),{type:'module'});
    const done=()=>{worker.terminate();signal.removeEventListener('abort',abort);};
    const abort=()=>{done();reject(canceled());};
    signal.addEventListener('abort',abort,{once:true});
    worker.onmessage=({data})=>{
      if(data.map){done();resolve(data.map);}
      else if(data.error){done();reject(Error(data.error));}
      else onProgress(data.progress);
    };
    worker.onerror=e=>{done();reject(Error(e.message||'映射计算失败'));};
    if(signal.aborted){abort();return;}
    worker.postMessage(request);
  });
}
// All four variants use independent output files, the same frozen mapping
// snapshot, and the original source file. Processing is sequential to bound RAM.
export async function exportMedia({source,model,state,kinds,width,bitrate,image,start,dimensions,directory,signal,onProgress,onFile}){
  if(!Number.isInteger(width)||width<16||width>16384)throw Error('输出宽度须为 16–16384 的整数');
  if(!image&&(!Number.isFinite(bitrate)||bitrate<1||bitrate>200))throw Error('码率须为 1–200 Mbps');
  if(!image&&width%2)width++;
  if(!directory&&!image&&source.duration*(bitrate*1e6+192e3)/8*kinds.length>500*1024**2)
    throw Error('本次输出较大，请勾选“保存到文件夹”直接写入磁盘。当前浏览器如无此功能，请使用桌面 Chrome 或 Edge。');
  const input=source.kind==='video'?openInput(source.file):null;
  let originalImage;
  try{
    if(!input){originalImage=new Image();originalImage.src=source.url;await originalImage.decode();}
    const track=input?await input.getPrimaryVideoTrack():null;
    for(let i=0;i<kinds.length;i++){
      assertRunning(signal);
      const kind=kinds[i],[w,h]=dimensions(kind,width),stage=labels[kind];
      onProgress(i/kinds.length,`${stage} · 计算映射`);
      const map=await prepareMap({kind,width:w,height:h,source:{width:source.width,height:source.height},model,state},signal,
        p=>onProgress((i+p*.12)/kinds.length,`${stage} · 计算映射 ${Math.round(p*100)}%`));
      assertRunning(signal);
      const renderer=new PixelRenderer(w,h,map,source);
      const name=`${stage}_${w}x${h}_${new Date().toISOString().replace(/[:.]/g,'-')}_${crypto.randomUUID().slice(0,6)}.${image?'png':'mp4'}`;
      let conversion,output,handle,writable;
      const abort=()=>conversion?.cancel().catch(()=>{});
      try{
        let blob;
        if(image){
          if(originalImage)renderer.draw(originalImage);
          else{
            const frame=await new CanvasSink(track,{poolSize:1}).getCanvas(start);
            if(!frame)throw Error('未能读取当前视频帧');renderer.draw(frame.canvas);
          }
          blob=await new Promise((resolve,reject)=>renderer.canvas.toBlob(b=>b?resolve(b):reject(Error('PNG 输出失败')),'image/png'));
          assertRunning(signal);
          if(directory){handle=await directory.getFileHandle(name,{create:true});writable=await handle.createWritable();await writable.write(blob);await writable.close();blob=null;}
        }else{
          if(typeof VideoEncoder==='undefined')throw Error('视频导出需要支持 WebCodecs 的桌面浏览器（Chrome / Edge）');
          if(directory){handle=await directory.getFileHandle(name,{create:true});writable=await handle.createWritable();}
          output=new Output({format:new Mp4OutputFormat({fastStart:directory?false:'in-memory'}),
            target:writable?new StreamTarget(writable,{chunked:true}):new BufferTarget()});
          conversion=await Conversion.init({input,output,tracks:'primary',tags:{},
            video:{codec:'avc',quality:new Quality({bitrate:bitrate*1e6,bitrateMode:'constant'}),
              processedWidth:w,processedHeight:h,forceTranscode:true,allowTransformationMetadata:false,
              process:sample=>{assertRunning(signal);return renderer.drawSample(sample);}},
            audio:{codec:'aac',quality:new Quality({bitrate:192000})},showWarnings:false});
          strictConversion(conversion);
          conversion.onProgress=p=>onProgress((i+.12+p*.88)/kinds.length,`${stage} · H.264 ${bitrate} Mbps · ${Math.round(p*100)}%`);
          signal.addEventListener('abort',abort,{once:true});assertRunning(signal);
          await conversion.execute();
          if(!directory)blob=new Blob([output.target.buffer],{type:'video/mp4'});
        }
        onFile({name,url:blob?URL.createObjectURL(blob):null,saved:!!directory});
      }catch(error){
        await conversion?.cancel().catch(()=>{});
        await output?.cancel().catch(()=>{});
        await writable?.abort().catch(()=>{});
        if(handle)await directory.removeEntry(name).catch(()=>{});
        throw error;
      }finally{signal.removeEventListener('abort',abort);renderer.dispose();}
    }
    onProgress(1,'导出完成');
  }finally{input?.dispose();}
}
