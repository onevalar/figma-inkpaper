import fs from 'node:fs';
const escape=s=>s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let html=fs.readFileSync('test/harness.html','utf8');
html=html.replace('src="../dist/ui.html"',`srcdoc="${escape(fs.readFileSync('dist/ui.html','utf8'))}"`);
html=html.replace("const response = new URLSearchParams(location.search).has('no-icc') ? new Response(null, { status: 404 }) : await fetch('fixtures/JapanColor2001Coated.icc');","const response = new Response(null, { status: 404 }); // Private ICC profiles are never embedded in the shared preview.");
for(const [name,mime]of [['test.pdf','application/pdf'],['test-raster.png','image/png']]) html=html.replaceAll(`fetch('fixtures/${name}')`,`fetch('data:${mime};base64,${fs.readFileSync('test/fixtures/'+name).toString('base64')}')`);
fs.writeFileSync('release/preview.html',html);
console.log('Prepared standalone preview (simulated fixtures, no private ICC).');
