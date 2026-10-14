import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
const list=fs.readdirSync('test/out').filter(f=>f.endsWith('.pdf')).map(f=>'test/out/'+f);
list.push('release/checks/inkpaper-release-smoke.pdf');
const report=[];
for(const f of list){
  const q=spawnSync('qpdf',[...(f.endsWith('/locked.pdf') ? ['--password=印刷123'] : []),'--check',f],{encoding:'utf8'});
  const entry={file:f,syntaxExit:q.status,detail:(q.stdout||'')+(q.stderr||'')};
  if(q.status!==0){entry.note='Inspect warnings or password-protected output separately'; report.push(entry); continue;}
  if(f.endsWith('/locked.pdf')) { entry.note='AES-encrypted fixture verified with its public test password using qpdf; not parsed with pdf-lib.';report.push(entry);continue; }
  const d=await PDFDocument.load(fs.readFileSync(f));
  assert.ok(d.getPageCount()>0);
  entry.pages=d.getPageCount();entry.boxes=d.getPages().map(p=>({trim:p.getTrimBox(),bleed:p.getBleedBox(),media:p.getMediaBox()}));
  entry.outputIntents=!!d.catalog.get(PDFName.of('OutputIntents'));
  if(f.endsWith('inkpaper-release-smoke.pdf')){
    const p=d.getPage(0), mm=72/25.4;
    for(const [value,target] of [[p.getTrimBox().width,90*mm],[p.getTrimBox().height,54*mm],[p.getBleedBox().width,96*mm],[p.getBleedBox().height,60*mm]]) assert.ok(Math.abs(value-target)<0.02);
  }
  report.push(entry);
}
fs.writeFileSync('release/checks/pdf-structure.json',JSON.stringify(report,null,2));
console.log(`${report.filter(x=>x.syntaxExit===0).length}/${report.length} PDF syntax checks passed. Not a PDF/X compliance certification.`);
const failures=report.filter(x=>x.syntaxExit!==0);console.log(failures.map(x=>`${x.file}: ${x.syntaxExit}`).join('\n'));
