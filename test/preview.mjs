// Package the real UI and the browser harness into a self-contained review page.
// Usage: node build.mjs && node test/preview.mjs [output.html]
import fs from 'node:fs';
import path from 'node:path';

const output = process.argv[2] || 'test/dist/preview.html';
let html = fs.readFileSync('test/harness.html', 'utf8');
const ui = fs.readFileSync('dist/ui.html', 'utf8');
const escapeAttribute = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
html = html.replace('src="../dist/ui.html"', () => `srcdoc="${escapeAttribute(ui)}"`);
for (const [file, type] of [['test.pdf', 'application/pdf'], ['test-raster.png', 'image/png']]) {
  const data = fs.readFileSync('test/fixtures/' + file).toString('base64');
  html = html.replaceAll(`fixtures/${file}`, `data:${type};base64,${data}`);
}
// The portable review uses the honest no-ICC state. Do not redistribute proprietary profiles.
html = html.replace("await fetch('fixtures/JapanColor2001Coated.icc')", 'new Response(null, { status: 404 })');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html);
console.log(`Real UI review: ${output} (${Math.round(Buffer.byteLength(html) / 1024)} KB)`);
