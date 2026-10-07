import { build } from 'esbuild';
import fs from 'fs';
await build({ entryPoints: ['src/pdf/pipeline.ts', 'src/pdf/color.ts'], outdir: 'test/dist', bundle: true, format: 'esm', platform: 'node', packages: 'external', outExtension: { '.js': '.mjs' }, logLevel: 'warning' });
const { rasterExport, setPngDecoder } = await import('./dist/pipeline.mjs');
const { loadLcms, defaultColorSettings, ColorEngine } = await import('./dist/color.mjs');
const { decodePngNode } = await import('./jpeg-node.mjs');
setPngDecoder(decodePngNode);
const lcms = await loadLcms();
const profile = new Uint8Array(fs.readFileSync('test/fixtures/JapanColor2001Coated.icc'));
const png = new Uint8Array(fs.readFileSync('test/fixtures/test-raster.png'));
for (const [mode, fmt] of [['cmyk','tiff'],['cmyk','jpeg'],['rgb','tiff'],['rgb','jpeg'],['gray','tiff'],['rgb','png']]) {
  const eng = new ColorEngine(lcms, { ...defaultColorSettings(), mode });
  if (mode === 'cmyk') eng.setOutputProfile(profile);
  const out = await rasterExport(png, eng, profile, { format: fmt, dpi: 300, quality: 90 });
  const ext = fmt === 'jpeg' ? 'jpg' : fmt === 'tiff' ? 'tif' : 'png';
  fs.writeFileSync(`test/out/raster-${mode}.${ext}`, out);
}
console.log('ok');
