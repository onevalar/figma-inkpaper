import { build } from 'esbuild';
import fs from 'fs';
await build({ entryPoints: ['src/pdf/pipeline.ts', 'src/pdf/color.ts'], outdir: 'test/dist', bundle: true, format: 'esm', platform: 'node', packages: 'external', outExtension: { '.js': '.mjs' }, logLevel: 'warning' });
const { runExport, setJpegDecoder } = await import('./dist/pipeline.mjs');
const { loadLcms, defaultColorSettings } = await import('./dist/color.mjs');
const { decodeJpegNode } = await import('./jpeg-node.mjs');
setJpegDecoder(decodeJpegNode);
const lcms = await loadLcms();
const profile = new Uint8Array(fs.readFileSync('test/fixtures/JapanColor2001Coated.icc'));
const pdf = new Uint8Array(fs.readFileSync('test/fixtures/test.pdf'));
const mm = 72 / 25.4;
const job = (n) => ({ name: 'p' + n, pdf, trimW: 200 * mm, trimH: 287 * mm, srcBleed: 5 * mm });
const base = { color: defaultColorSettings(), maxPpi: 0, minStrokePt: 0, output: 'merged',
  compose: { bleed: 3 * mm, cropMarks: true, regMarks: false, colorBars: false, markWeight: 0.25, pdfx: 'none', keepLinks: true } };
const r1 = await runExport(lcms, profile, [job(1), job(2), job(3)], { ...base, title: 'spreads', compose: { ...base.compose, spreads: true, scale: 0.5 } });
fs.writeFileSync('test/out/spreads.pdf', r1.files[0].bytes);
const r2 = await runExport(lcms, profile, [job(1)], { ...base, title: 'locked', password: '印刷123' });
fs.writeFileSync('test/out/locked.pdf', r2.files[0].bytes);
console.log('done');
