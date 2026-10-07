import { build } from 'esbuild';
import fs from 'fs';
await build({ entryPoints: ['src/pdf/pipeline.ts', 'src/pdf/color.ts'], outdir: 'test/dist', bundle: true, format: 'esm', platform: 'node', packages: 'external', outExtension: { '.js': '.mjs' }, logLevel: 'warning' });
const { runExport, setJpegDecoder, setPngDecoder, uniform } = await import('./dist/pipeline.mjs');
const { loadLcms, defaultColorSettings } = await import('./dist/color.mjs');
const { decodeJpegNode, decodePngNode } = await import('./jpeg-node.mjs');
setJpegDecoder(decodeJpegNode); setPngDecoder(decodePngNode);
const lcms = await loadLcms();
const profile = new Uint8Array(fs.readFileSync('test/fixtures/JapanColor2001Coated.icc'));
const pdf = new Uint8Array(fs.readFileSync('test/fixtures/test.pdf'));
const png = new Uint8Array(fs.readFileSync('test/fixtures/test-raster.png'));
const mm = 72 / 25.4;
const job = (n, extra = {}) => ({ name: 'p' + n, pdf, trimW: 200 * mm, trimH: 287 * mm, srcBleed: 5 * mm, rasterPng: png, rasterDpi: 150, ...extra });
const base = { color: defaultColorSettings(), maxPpi: 0, minStrokePt: 0, output: 'merged',
  compose: { bleed: 3 * mm, cropMarks: true, regMarks: true, colorBars: false, markWeight: 0.25, pdfx: 'none', keepLinks: false, bookmarks: true, author: '设计部', subject: '测试', keywords: '海报, 印刷' } };
const run = async (title, extra, jobs = [job(1)]) => {
  const r = await runExport(lcms, profile, jobs, { ...base, title, ...extra, compose: { ...base.compose, ...(extra.compose || {}) } });
  r.files.forEach((f) => fs.writeFileSync('test/out/' + f.name, f.bytes));
  console.log(title, r.files.map((f) => f.name).join(','), r.reports.map((x) => (x.flattened ? 'FLAT ' : '') + x.leftovers.join(';')).join(' | '));
};
await run('x1a', { compose: { pdfx: 'x1a' } });
await run('x3', { compose: { pdfx: 'x3' } });
await run('perside', { compose: { bleed: { t: 3 * mm, r: 0, b: 3 * mm, l: 5 * mm }, trimLine: true } });
await run('booklet', { compose: { imposition: { kind: 'booklet', rtl: false } } }, [1, 2, 3, 4, 5, 6].map((n) => job(n)));
const card = { name: 'card', pdf, trimW: 90 * mm, trimH: 54 * mm, srcBleed: 3 * mm };
await run('nup', { compose: { imposition: { kind: 'nup', sheetW: 297 * mm, sheetH: 420 * mm, rows: 0, cols: 0, gutter: 6 * mm, repeat: true, copies: 20 } } }, [card]);
await run('duplex', { compose: { imposition: { kind: 'duplex', sheetW: 297 * mm, sheetH: 210 * mm, rows: 0, cols: 0, gutter: 6 * mm, copies: 3 } } }, [card, { ...card, name: 'back' }]);
await run('scaled', {}, [job(1, { scale: 10 })]);
