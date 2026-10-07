// High-level export pipeline shared by the plugin UI and the Node test harness.

import { PDFDocument, PDFName } from 'pdf-lib';
import { ColorEngine, ColorSettings, SpotDef } from './color';
import { Converter, ConvertReport, VectorStroke, auditRgb } from './convert';
import { compose, ComposeOptions, PageSource, Sides, uniform } from './compose';
import { encryptDocument } from './encrypt';
import { decodePng, flattenOnWhite } from './images';
import { encodeJpeg } from './jpegenc';
export { setJpegDecoder, setPngDecoder } from './images';
export { uniform } from './compose';
export type { Sides, Imposition } from './compose';

export interface ExportJob {
  name: string;
  pdf: Uint8Array; // single-page PDF exported by Figma
  trimW: number; // pt (at design scale)
  trimH: number;
  srcBleed: number | Sides; // pt of bleed present around the trim in `pdf`
  scale?: number; // frame designed at 1:N
  sentinels?: { hex: string; spot: SpotDef }[]; // filled finishing layers (varnish, white, foil) recoloured for export
  vectorStrokes?: VectorStroke[]; // cut / fold / score / perforation lines, drawn as true centre-line strokes
  pageH?: number; // height of the Figma export page (pt) for the stroke coordinates
  hairlinesFixed?: number; // strokes thickened inside Figma before export
  rasterPng?: Uint8Array; // same page rendered to PNG (used to flatten transparency for PDF/X-1a / X-3)
  rasterDpi?: number;
}

export interface ExportSettings {
  color: ColorSettings;
  maxPpi: number;
  minStrokePt: number;
  imageCompression?: 'auto' | 'jpeg' | 'lossless';
  jpegQuality?: number;
  compose: Omit<ComposeOptions, 'mode' | 'title' | 'outputIntent' | 'bleed'> & { bleed: number | Sides; outputIdentifier?: string };
  output: 'merged' | 'separate';
  title: string;
  password?: string; // open password (not allowed with PDF/X)
  dielineFile?: 'inline' | 'separate' | 'both'; // cut lines in the artwork, in their own PDF, or both
}

export interface ExportResult {
  files: { name: string; bytes: Uint8Array }[];
  reports: (ConvertReport & { page: string; remainingRgb: number; flattened?: boolean })[];
  usage: Record<string, number>;
}

const sides = (b: number | Sides): Sides => (typeof b === 'number' ? uniform(b) : b);

export async function runExport(
  lcms: any,
  profile: Uint8Array | null,
  jobs: ExportJob[],
  s: ExportSettings,
  onProgress?: (msg: string, frac: number) => void,
): Promise<ExportResult> {
  const reports: ExportResult['reports'] = [];
  const usage: Record<string, number> = {};
  const sources: PageSource[] = [];
  const knifeSources: PageSource[] = [];
  const pdfx = s.color.mode === 'rgb' ? 'none' : s.compose.pdfx;
  const flatOnly = pdfx === 'x1a' || pdfx === 'x3';
  const strokesInline = s.dielineFile !== 'separate';
  const knifeFile = s.dielineFile === 'separate' || s.dielineFile === 'both';
  let i = 0;
  for (const job of jobs) {
    onProgress?.(`转换颜色：${job.name}`, i / jobs.length);
    const overrides = { ...s.color.overrides };
    for (const st of job.sentinels || []) overrides[st.hex] = { hex: st.hex, spot: st.spot, overprint: true };
    const finishing = [...(job.sentinels || []).map((x) => x.spot.name), ...(job.vectorStrokes || []).map((x) => x.spot.name)];
    const settings: ColorSettings = { ...s.color, overrides, forceSpots: finishing };
    const eng = new ColorEngine(lcms, settings);
    if (profile && settings.mode === 'cmyk') eng.setOutputProfile(profile);
    let doc = await PDFDocument.load(job.pdf, { updateMetadata: false });
    let conv = new Converter(doc, eng, { maxPpi: s.maxPpi, minStrokePt: s.minStrokePt, imageCompression: s.imageCompression, jpegQuality: s.jpegQuality });
    const rep = await conv.run();
    let flattened = false;
    if (flatOnly) {
      await conv.dropOpaqueMasks();
      if (conv.hasTransparency()) {
        if (!job.rasterPng) throw new Error(`「${job.name}」含透明效果，PDF/X-1a / X-3 需要整页图像，但没有拿到图像数据`);
        // PDF/X-1a and X-3 forbid transparency: flatten this page to a CMYK image
        doc = await rasterPage(job.rasterPng, doc.getPage(0).getWidth(), doc.getPage(0).getHeight(), eng, s.jpegQuality ?? 92);
        conv = new Converter(doc, eng, { maxPpi: 0, minStrokePt: 0 });
        flattened = true;
        rep.leftovers.push(`此页有透明 / 混合 / 阴影效果，PDF/X-1a、X-3 不允许透明，已整页转为 ${job.rasterDpi || 300}dpi 图像（文字也变成图像）`);
      } else conv.stripTransparencyGroups();
    }
    if (job.vectorStrokes?.length && strokesInline) {
      conv.addVectorStrokes(job.vectorStrokes, job.pageH ?? doc.getPage(0).getHeight());
      rep.spotsUsed = [...new Set([...rep.spotsUsed, ...job.vectorStrokes.filter((v) => settings.mode === 'cmyk' && eng.keepSpot(v.spot.name)).map((v) => v.spot.name)])];
    }
    rep.hairlinesFixed += job.hairlinesFixed || 0;
    const audit = settings.mode === 'rgb' || flattened ? { rgbOps: 0, rgbImages: 0, rgbShadings: 0 } : auditRgb(doc);
    reports.push({ ...rep, page: job.name, remainingRgb: audit.rgbOps + audit.rgbImages + audit.rgbShadings, flattened });
    eng.usage.forEach((n, hex) => (usage[hex] = (usage[hex] || 0) + n));
    const src: PageSource = { doc, trimW: job.trimW, trimH: job.trimH, srcBleed: sides(job.srcBleed), name: job.name, scale: job.scale };
    sources.push(src);
    if (knifeFile && job.vectorStrokes?.length) {
      // dieline-only page with exactly the same geometry
      const kd = await PDFDocument.create({ updateMetadata: false });
      const size = doc.getPage(0).getSize();
      const kp = kd.addPage([size.width, size.height]);
      kp.node.set(PDFName.of('Resources'), kd.context.obj({}));
      kp.node.set(PDFName.of('Contents'), kd.context.register(kd.context.flateStream(new Uint8Array(0))));
      const kc = new Converter(kd, eng, { maxPpi: 0, minStrokePt: 0 });
      kc.addVectorStrokes(job.vectorStrokes, job.pageH ?? size.height);
      knifeSources.push({ ...src, doc: kd, name: job.name + ' 刀版' });
    }
    i++;
  }
  onProgress?.('合成印刷文件…', 0.9);
  const eng0 = profile && s.color.mode === 'cmyk' ? new ColorEngine(lcms, s.color) : null;
  if (eng0 && profile) eng0.setOutputProfile(profile);
  const copts: ComposeOptions = {
    ...s.compose,
    pdfx,
    bleed: sides(s.compose.bleed),
    mode: s.color.mode,
    title: s.title,
    outputIntent: profile && eng0 ? { bytes: profile, name: eng0.outProfileName, identifier: s.compose.outputIdentifier || eng0.outProfileName } : undefined,
  };
  const files: ExportResult['files'] = [];
  const save = async (srcs: PageSource[], title: string, opts: ComposeOptions) => {
    const out = await compose(srcs, { ...opts, title });
    if (s.password && opts.pdfx === 'none') await encryptDocument(out, s.password);
    files.push({ name: safeName(title) + '.pdf', bytes: finalize(await out.save({ useObjectStreams: false }), opts) });
  };
  const designSets = s.output === 'merged' ? [{ srcs: sources, title: s.title }] : sources.map((x) => ({ srcs: [x], title: x.name }));
  for (const d of designSets) await save(d.srcs, d.title, copts);
  if (knifeSources.length) {
    const kopts: ComposeOptions = { ...copts, colorBars: false };
    if (s.output === 'merged') await save(knifeSources, s.title + ' 刀版', kopts);
    else for (const k of knifeSources) await save([k], k.name, kopts);
  }
  onProgress?.('完成', 1);
  return { files, reports, usage };
}

/** Build a one-page PDF holding a CMYK (or gray / RGB) image of the page — used to flatten transparency. */
async function rasterPage(png: Uint8Array, w: number, h: number, eng: ColorEngine, quality: number): Promise<PDFDocument> {
  const rgba = await decodePng(png);
  const rgb = flattenOnWhite(rgba);
  const mode = eng.settings.mode;
  const px = mode === 'rgb' ? rgb.data : eng.convertPixels(rgb.data, rgb.w * rgb.h, undefined, true);
  const comps = mode === 'cmyk' ? 4 : mode === 'gray' ? 1 : 3;
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const img = ctx.register(
    ctx.stream(encodeJpeg(px, rgb.w, rgb.h, comps as 1 | 3 | 4, quality), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: rgb.w,
      Height: rgb.h,
      ColorSpace: comps === 4 ? 'DeviceCMYK' : comps === 1 ? 'DeviceGray' : 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: 'DCTDecode',
      ...(comps === 4 ? { Decode: [1, 0, 1, 0, 1, 0, 1, 0] } : {}),
    }),
  );
  const page = doc.addPage([w, h]);
  page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Im0: img } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(new TextEncoder().encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q\n`))));
  return doc;
}

export function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'print';
}

/** pdf-lib always writes a 1.7 header; PDF/X needs ≤ 1.6 (X-4) or 1.3 (X-1a / X-3). Same length, so offsets stay valid. */
function finalize(bytes: Uint8Array, o: ComposeOptions): Uint8Array {
  if (bytes[7] !== 0x37 || o.mode === 'rgb') return bytes;
  if (o.pdfx === 'x4') bytes[7] = 0x36;
  else if (o.pdfx === 'x1a' || o.pdfx === 'x3') bytes[7] = 0x33;
  return bytes;
}

export { rasterExport, applyExactOverrides, encodeTiff, pngWithDpi } from './raster';
export { flattenOnWhite, decodePng } from './images';
