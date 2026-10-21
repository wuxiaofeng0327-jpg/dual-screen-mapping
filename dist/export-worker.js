import {buildUVMap} from './export-map.js';
self.onmessage=({data})=>{
  try{
    const map=buildUVMap(data,progress=>self.postMessage({progress}));
    self.postMessage({map},[map.buffer]);
  }catch(error){self.postMessage({error:error.message});}
};
