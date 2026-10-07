// Node harness: runs the real export pipeline on a fixture PDF.
import { build } from 'esbuild';
import fs from 'fs';
await build({ entryPoints: ['src/pdf/pipeline.ts', 'src/pdf/color.ts'], outdir: 'test/dist', bundle: true, format: 'esm', platform: 'node', packages: 'external', outExtension: { '.js': '.mjs' } });
const { runExport, setJpegDecoder } = await import('./dist/pipeline.mjs');
const { decodeJpegNode } = await import('./jpeg-node.mjs');
setJpegDecoder(decodeJpegNode);
const { loadLcms, defaultColorSettings } = await import('./dist/color.mjs');
const lcms = await loadLcms();
const profile = new Uint8Array(fs.readFileSync('test/fixtures/JapanColor2001Coated.icc'));
const pdf = new Uint8Array(fs.readFileSync(process.argv[2] || 'test/fixtures/test.pdf'));
const color = defaultColorSettings();
color.richBlack = { c: 60, m: 40, y: 40, k: 100 };
color.overrides['#E30613'] = { hex: '#E30613', spot: { name: 'PANTONE 485 C', tint: 100, alt: { c: 0, m: 95, y: 100, k: 0 } } };
const mm = 72 / 25.4;
const t0 = Date.now();
const res = await runExport(lcms, profile, [{ name: 'A4 测试', pdf, trimW: 210 * mm, trimH: 297 * mm, srcBleed: 0 }], {
  color, maxPpi: 300, minStrokePt: 0.25, output: 'merged', title: 'presskit-test',
  compose: { bleed: 0, cropMarks: true, regMarks: true, colorBars: true, markWeight: 0.25, pdfx: 'x4', keepLinks: true },
}, (m) => console.log('·', m));
for (const f of res.files) fs.writeFileSync('test/out/' + f.name, f.bytes);
console.log(JSON.stringify(res.reports, null, 1));
console.log('ms', Date.now() - t0, Object.keys(res.usage).length, 'colors');
