// Fault injection against the actual Figma main-thread functions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from 'esbuild';
const source = fs.readFileSync('src/main/code.ts', 'utf8') + '\nexport { exportFrames, strokeGeometry };';
fs.mkdirSync('test/dist', { recursive: true });
await build({ stdin: { contents: source, resolveDir: 'src/main', loader: 'ts' }, outfile: 'test/dist/main-cleanup.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'warning' });
globalThis.__html__ = '';
const nodes = [];
const create = (type='FRAME') => {
  const n = { type, removed:false, width:100, height:100, x:0, y:0, name:'fixture', layoutMode:'NONE', fills:[], strokes:[],
    getPluginData:()=>'', findAll:()=>[], findAllWithCriteria:()=>[], remove(){this.removed=true;}, clone(){const c=create(type); nodes.push(c); return c;},
    resize(){ throw new Error('resize failed'); }, resizeWithoutConstraints(){ throw new Error('resize failed'); }, detachInstance(){throw new Error('detach failed');}, exportAsync:async()=>{throw new Error('export failed');} };
  return n;
};
let original = create();
globalThis.figma = { showUI(){}, on(){}, ui:{postMessage(){}}, getNodeByIdAsync:async()=>original,
  currentPage:{appendChild(){}, selection:[]}, createFrame(){const n=create();nodes.push(n);return n;}, flatten(){throw new Error('flatten failed');} };
const { exportFrames, strokeGeometry } = await import('./dist/main-cleanup.mjs');
const req = {frameIds:['1'], colorFinishing:{}, bleedMm:3, autoBleed:true, format:'PDF', dieline:{mode:'off'}, minStrokePt:0, textOutline:'live'};
for (const type of ['FRAME','GROUP','INSTANCE']) {
  nodes.length=0; original=create(type);
  await assert.rejects(exportFrames(req), type === 'INSTANCE' ? /detach failed/ : /resize failed/);
  assert.ok(nodes.length > 0 && nodes.every(n=>n.removed), `Temporary nodes leaked for ${type}`);
  assert.equal(original.removed,false);
  console.log(`PASS cleanup after ${type} failure; original preserved`);
}
nodes.length=0;
const leaf=create('RECTANGLE'); leaf.parent={appendChild(){},layoutMode:'NONE'};
assert.equal(strokeGeometry(leaf,create()),null);
assert.ok(nodes.every(n=>n.removed));
console.log('PASS cleanup after flatten failure');

nodes.length=0; original=create();
await assert.rejects(exportFrames({...req,autoBleed:false,dieline:{mode:'auto'}}), /export failed/);
assert.ok(nodes.every(n=>n.removed));
assert.equal(original.removed,false);
console.log('PASS cleanup after PDF export failure');
nodes.length=0; original=create();
original.clone=()=>{const c=create();c.exportAsync=async()=>new Uint8Array([1,2,3]);nodes.push(c);return c;};
const result=await exportFrames({...req,autoBleed:false,dieline:{mode:'auto'}});
assert.equal(result.length,1);assert.ok(nodes.every(n=>n.removed));assert.equal(original.x,0);assert.equal(original.removed,false);
console.log('PASS cleanup after successful PDF export; original preserved');

nodes.length=0; original=create(); let cutLayer;
original.clone=()=>{
  const c=create();
  cutLayer=create('RECTANGLE');cutLayer.name='Cut failure';cutLayer.visible=true;
  cutLayer.strokes=[{type:'SOLID',color:{r:1,g:0,b:1}}];cutLayer.strokeWeight=1;
  cutLayer.parent={appendChild(){},layoutMode:'NONE'};
  c.findAll=()=>[cutLayer];nodes.push(c);return c;
};
await assert.rejects(exportFrames({...req,autoBleed:false,dieline:{mode:'auto'}}), /无法提取/);
assert.equal(cutLayer.removed,false);
assert.ok(nodes.every(n=>n.removed));
console.log('PASS failed cutting-path extraction stops export instead of silently dropping the path');

nodes.length=0; original=create();
original.clone=()=>{const c=create();const t=create('TEXT');t.name='Outline failure';t.visible=true;c.findAllWithCriteria=(criteria)=>criteria.types.includes('TEXT')?[t]:[];nodes.push(c);return c;};
await assert.rejects(exportFrames({...req,autoBleed:false,textOutline:'all'}), /无法将/);
assert.ok(nodes.every(n=>n.removed));assert.equal(original.removed,false);
console.log('PASS failed text outlining stops export instead of silently retaining live text');
