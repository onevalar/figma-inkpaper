import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
const at = argv.indexOf('--plugin-id');
if (at !== -1 && (!argv[at + 1] || !/^\d+$/.test(argv[at + 1]))) throw new Error('Provide the actual numeric ID assigned by Figma.');
for (const command of [[process.execPath,'build.mjs'], [process.execPath,'node_modules/typescript/bin/tsc','--noEmit'], [process.execPath,'test/export-cleanup.mjs'], [process.execPath,'test/migration.mjs']]) {
  const r = spawnSync(command[0],command.slice(1),{stdio:'inherit'});
  if (r.status !== 0) process.exit(r.status || 1);
}
const manifest = JSON.parse(fs.readFileSync('manifest.json','utf8'));
if (at !== -1) manifest.id = argv[at + 1];
if (JSON.stringify(manifest.networkAccess.allowedDomains) !== '["none"]') throw new Error('Unexpected network access');
const formalIdProvided = /^\d+$/.test(manifest.id);
const version = JSON.parse(fs.readFileSync('package.json','utf8')).version;
const stage = 'release/package';
fs.rmSync(stage,{recursive:true,force:true}); fs.mkdirSync(`${stage}/dist`,{recursive:true});
fs.writeFileSync(`${stage}/manifest.json`,JSON.stringify(manifest,null,2)+'\n');
for (const f of ['dist/code.js','dist/ui.html','THIRD_PARTY_NOTICES.txt']) fs.copyFileSync(f,`${stage}/${f}`);
const files = ['manifest.json','dist/code.js','dist/ui.html','THIRD_PARTY_NOTICES.txt'];
const hashes = Object.fromEntries(files.map(f=>{const b=fs.readFileSync(`${stage}/${f}`);return [f,{bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}];}));
const report={preparedAt:new Date().toISOString(),version,pluginId:manifest.id,formalIdProvided,submitted:false,files:hashes,excluded:['ICC/ICM','test fixtures','source','node_modules','account data'],remaining:['Review final listing and updated screenshots in Figma','Human terms acceptance and explicit submission','Figma review decision'],validationEvidence:['checks/migration-evidence.json','checks/pdfx-local-preflight.json','checks/real-figma-pdfx.json','checks/components-locales.json','checks/runtime-audit-scope.json'],independentPdfXCertification:false};
fs.writeFileSync('release/package-report.json',JSON.stringify(report,null,2)+'\n');
const name=`inkpaper-${version}-${formalIdProvided?'release':'candidate'}.zip`;
const target=path.resolve('release',name);fs.rmSync(target,{force:true});
const r=spawnSync('/usr/bin/zip',['-q',target,...files],{cwd:stage,stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);
console.log(`Prepared ${target}`);
console.log(!formalIdProvided?'BLOCKED FOR SUBMISSION: local placeholder ID retained.':'Formal ID and runtime files staged. Review the final listing and terms before human submission.');
