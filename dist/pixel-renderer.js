export class PixelRenderer {
  constructor(width,height,map,source){
    this.canvas=document.createElement('canvas');this.canvas.width=width;this.canvas.height=height;
    const gl=this.gl=this.canvas.getContext('webgl2',{alpha:false,antialias:false,premultipliedAlpha:false,preserveDrawingBuffer:true});
    if(!gl)throw Error('此浏览器不支持 WebGL 2，请使用桌面版 Chrome 或 Edge');
    const max=gl.getParameter(gl.MAX_TEXTURE_SIZE),vp=gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    if(Math.max(width,height,source.width,source.height)>max||width>vp[0]||height>vp[1]){
      this.dispose();throw Error(`当前显卡不能处理此分辨率（纹理上限 ${max} px），未缩小画面`);
    }
    const shader=(type,code)=>{
      const s=gl.createShader(type);gl.shaderSource(s,code);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));
      return s;
    };
    const vs=shader(gl.VERTEX_SHADER,`#version 300 es
      void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}`);
    const fs=shader(gl.FRAGMENT_SHADER,`#version 300 es
      precision highp float;uniform sampler2D uvMap,frame;uniform int outputHeight;out vec4 color;
      void main(){vec2 uv=texelFetch(uvMap,ivec2(int(gl_FragCoord.x),outputHeight-1-int(gl_FragCoord.y)),0).rg;
      vec4 c=texture(frame,clamp(uv,0.,1.));color=uv.x< -1.?vec4(0.,0.,0.,1.):vec4(c.rgb*c.a,1.);}`);
    const program=this.program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
    gl.deleteShader(vs);gl.deleteShader(fs);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);gl.uniform1i(gl.getUniformLocation(program,'outputHeight'),height);
    gl.uniform1i(gl.getUniformLocation(program,'uvMap'),0);gl.uniform1i(gl.getUniformLocation(program,'frame'),1);
    const texture=(unit,filter)=>{
      gl.activeTexture(gl.TEXTURE0+unit);const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return t;
    };
    this.mapTexture=texture(0,gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RG32F,width,height,0,gl.RG,gl.FLOAT,map);
    this.inputTexture=texture(1,gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    gl.viewport(0,0,width,height);
    this.sourceCanvas=document.createElement('canvas');this.sourceCanvas.width=source.width;this.sourceCanvas.height=source.height;
    this.sourceContext=this.sourceCanvas.getContext('2d',{alpha:false});
  }
  draw(input){
    const gl=this.gl;if(gl.isContextLost())throw Error('显卡上下文已丢失，请关闭其他占用显存的程序后重试');
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,this.inputTexture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,input);
    gl.drawArrays(gl.TRIANGLES,0,3);
    if(gl.getError()!==gl.NO_ERROR)throw Error('显卡无法完成原分辨率输出，未缩小画面');
    return this.canvas;
  }
  drawSample(sample){
    const c=this.sourceCanvas;this.sourceContext.fillStyle='#000';this.sourceContext.fillRect(0,0,c.width,c.height);
    sample.draw(this.sourceContext,0,0,c.width,c.height);
    return this.draw(c);
  }
  dispose(){
    const gl=this.gl;if(!gl)return;
    gl.deleteTexture(this.mapTexture);gl.deleteTexture(this.inputTexture);gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.width=this.canvas.height=1;
    if(this.sourceCanvas)this.sourceCanvas.width=this.sourceCanvas.height=1;
  }
}
