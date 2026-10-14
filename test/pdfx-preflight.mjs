import assert from 'node:assert/strict';
import fs from 'node:fs';
import {build} from 'esbuild';
import {PDFDocument,PDFName,StandardFonts} from 'pdf-lib';
await build({entryPoints:['src/pdf/preflight.ts'],outfile:'test/dist/preflight.mjs',bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'warning'});
const {preflightPdfX}=await import('./dist/preflight.mjs');
const load=async name=>PDFDocument.load(fs.readFileSync(`test/out/${name}.pdf`));
const report={scope:'Targeted local checks, not independent PDF/X certification',valid:[],rejected:[]};
for(const [file,flavor] of [['presskit-test','x4'],['x1a','x1a'],['x3','x3']]){
 const d=await load(file);const issues=preflightPdfX(d,flavor);assert.deepEqual(issues,[],file);report.valid.push({file,flavor});
}
async function reject(name,code,mutate,flavor='x4'){
 const d=await load(flavor==='x4'?'presskit-test':'x1a');await mutate(d);
 const issues=preflightPdfX(d,flavor);assert(issues.some(i=>i.code===code),`${name}: ${JSON.stringify(issues)}`);report.rejected.push({name,code});
}
await reject('missing output intent','output-intent',d=>d.catalog.delete(PDFName.of('OutputIntents')));
await reject('wrong ICC channel count','icc',d=>{const a=d.context.lookup(d.catalog.get(PDFName.of('OutputIntents')));const i=d.context.lookup(a.get(0));const p=d.context.lookup(i.get(PDFName.of('DestOutputProfile')));p.dict.set(PDFName.of('N'),d.context.obj(3));});
await reject('ambiguous trim and art boxes','page-boxes',d=>d.getPage(0).setArtBox(0,0,10,10));
await reject('trim outside bleed','page-boxes',d=>d.getPage(0).setTrimBox(-100,-100,99999,99999));
await reject('missing XMP','xmp',d=>d.catalog.delete(PDFName.of('Metadata')));
await reject('unembedded font','font-embedding',async d=>{const f=await d.embedFont(StandardFonts.Helvetica);d.getPage(0).drawText('not embedded',{font:f});await d.flush();});
await reject('PDF/X-1a transparency','transparency',d=>d.context.register(d.context.obj({Type:'ExtGState',ca:.5})),'x1a');
await reject('PDF/X-1a RGB content','rgb',d=>d.getPage(0).node.addContentStream(d.context.register(d.context.stream('1 0 0 rg\n0 0 10 10 re f'))),'x1a');
await reject('scripted content','unsupported-content',d=>d.context.register(d.context.obj({JS:'alert(1)'})));
await reject('encryption','encryption',d=>{d.context.trailerInfo.Encrypt=d.context.register(d.context.obj({Filter:'Standard'}));});
fs.writeFileSync('release/checks/pdfx-local-preflight.json',JSON.stringify(report,null,2)+'\n');
console.log(`PASS ${report.valid.length} output flavors and ${report.rejected.length} invalid PDF/X cases (targeted checks only).`);
