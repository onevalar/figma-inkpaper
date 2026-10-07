import fs from 'fs';
const { runExport, setJpegDecoder } = await import('./dist/pipeline.mjs');
const { loadLcms, defaultColorSettings } = await import('./dist/color.mjs');
const { decodeJpegNode } = await import('./jpeg-node.mjs');
setJpegDecoder(decodeJpegNode);
const lcms = await loadLcms();
const profile = new Uint8Array(fs.readFileSync('test/fixtures/JapanColor2001Coated.icc'));
const pdf = new Uint8Array(fs.readFileSync('test/fixtures/test.pdf'));
const mm = 72 / 25.4;
const job = { name: 'v', pdf, trimW: 200 * mm, trimH: 287 * mm, srcBleed: 5 * mm };
for (const [label, mode, maxPpi, minStroke] of [['gray', 'gray', 0, 0], ['rgb', 'rgb', 0, 0], ['cmyk-down', 'cmyk', 100, 1.5]]) {
  const color = { ...defaultColorSettings(), mode };
  const r = await runExport(lcms, profile, [job], { color, maxPpi, minStrokePt: minStroke, output: 'merged', title: 'v-' + label,
    compose: { bleed: 3 * mm, cropMarks: true, regMarks: false, colorBars: true, markWeight: 0.25, pdfx: mode === 'cmyk' ? 'x4' : 'none', keepLinks: true } });
  fs.writeFileSync(`test/out/v-${label}.pdf`, r.files[0].bytes);
  const rp = r.reports[0];
  console.log(label, 'remainingRgb', rp.remainingRgb, 'hairlines', rp.hairlinesFixed, 'imgs', rp.images.map(i => `${i.w}x${i.h}@${i.ppi}${i.newW ? '→' + i.newW + 'x' + i.newH : ''}`).join(' '));
}
