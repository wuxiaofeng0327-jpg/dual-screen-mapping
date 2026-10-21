import {readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=new URL('./dist/',import.meta.url);
const names=readdirSync(root);
const html=readFileSync(new URL('index.html',root),'utf8'),ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
assert.equal(ids.length,new Set(ids).size,'Duplicate DOM IDs');
for(const name of names.filter(n=>n.endsWith('.js'))){
  const file=new URL(name,root),text=readFileSync(file,'utf8');
  const r=spawnSync(process.execPath,['--check',fileURLToPath(file)],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  for(const m of text.matchAll(/\$\('([^']+)'\)/g))assert(ids.includes(m[1]),`Missing ID ${m[1]} in ${name}`);
  assert(!text.includes('/api/'),'Local server dependency');
  assert(!text.includes('/media/'),'Local media endpoint');
}
const inspect=x=>{
  if(typeof x==='string')assert(!/[A-Za-z]:\\|Mywork2026|C:\/Users\//.test(x),'Private local path');
  if(x&&typeof x==='object')for(const [key,v] of Object.entries(x)){assert(!['blend','filepath'].includes(key));inspect(v);}
};
for(const name of names.filter(n=>n.endsWith('.json')))inspect(JSON.parse(readFileSync(new URL(name,root),'utf8')));
assert(!names.some(n=>/\.(mp4|mov|mkv|blend|png|jpe?g)$/i.test(n)),'Unexpected media asset');
assert.deepEqual(readdirSync(new URL('samples/',root)),['21-9-h264.mp4'],'Only the authorized sample may be published');
assert(!html.includes('settingsDialog'));
assert(html.includes('scene-layout'));
console.log('Syntax, DOM references, static assets and private-path checks passed.');
