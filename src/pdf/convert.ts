// Rewrites a PDF (as exported by Figma) into the target colour space:
// vector colours, images, gradients (shadings), transparency groups, Type3 glyphs.
// Also applies prepress fixes: overprint, rich black, hairline thickening, image downsampling,
// spot-colour separations (brand colours + dieline/finishing layers).

import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import { ColorEngine, Mapped, SpotDef, toHex } from './color';
import { Op, Tok, parseContent, serialize, bytesToLatin1, latin1ToBytes, num, name, mkOp, fmt } from './lexer';
import { decodeStream, lookupDict } from './streams';
import { buildFunction, makeSampledFunction } from './functions';
import { decodeImage, resample } from './images';
import { encodeJpeg } from './jpegenc';

export interface ConvertOptions {
  maxPpi: number; // downsample images above this effective resolution (0 = off)
  minStrokePt: number; // thicken strokes thinner than this (0 = off)
  imageCompression?: 'auto' | 'jpeg' | 'lossless'; // auto: JPEG for photos that were JPEG already
  jpegQuality?: number;
}

export interface VectorStroke {
  spot: SpotDef;
  weight: number; // pt
  dash: number[];
  paths: { d: string; m: number[] }[]; // SVG path data + 2x3 transform [a b c d e f] into page space (y-down)
}

export interface ImageInfo {
  ref: string;
  w: number;
  h: number;
  ppi: number; // effective ppi at largest placement
  newW?: number;
  newH?: number;
  converted: boolean;
}

export interface ConvertReport {
  images: ImageInfo[];
  hairlinesFixed: number;
  richBlackFills: number;
  overprintObjects: number;
  spotsUsed: string[];
  leftovers: string[]; // things that could not be converted
}

type CSKind = 'rgb' | 'gray' | 'cmyk' | 'pattern' | 'other';

interface GState {
  ctm: number[];
  fillCS: CSKind;
  strokeCS: CSKind;
  fillBlack: boolean; // current fill is (source) pure black
  fillMapped: Mapped | null;
  opFill: boolean;
  opStroke: boolean;
  lw: number;
  translucent: boolean; // constant alpha < 1 or soft mask active
}

const ID = [1, 0, 0, 1, 0, 0];
const mul = (a: number[], b: number[]) => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const scaleOf = (m: number[]) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

const PAINT_FILL = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const PAINT_STROKE = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const RICH_MIN_PT = 28; // rich black only for black areas at least ~1 cm in both directions

export class Converter {
  doc: PDFDocument;
  ctx: PDFContext;
  eng: ColorEngine;
  opts: ConvertOptions;
  report: ConvertReport = { images: [], hairlinesFixed: 0, richBlackFills: 0, overprintObjects: 0, spotsUsed: [], leftovers: [] };

  private seen = new Set<PDFObject | undefined>(); // processed streams / dicts
  private maskForms = new Set<PDFObject | undefined>();
  private imageUse = new Map<PDFRef, { ppi: number }>();
  private spotCS = new Map<string, PDFRef>();
  private gsCache = new Map<string, PDFRef>();
  private leftoverSet = new Set<string>();

  constructor(doc: PDFDocument, eng: ColorEngine, opts: ConvertOptions) {
    this.doc = doc;
    this.ctx = doc.context;
    this.eng = eng;
    this.opts = opts;
  }

  get mode() {
    return this.eng.settings.mode;
  }

  async run(): Promise<ConvertReport> {
    for (const page of this.doc.getPages()) {
      const node = page.node;
      const res = node.Resources() || this.ctx.obj({});
      if (!node.Resources()) node.set(PDFName.of('Resources'), res);
      this.prepareResources(res);
      const contents = node.Contents();
      let src = '';
      if (contents instanceof PDFArray) {
        for (const c of contents.asArray()) src += bytesToLatin1(decodeStream(this.ctx, this.ctx.lookup(c) as PDFRawStream)) + '\n';
      } else if (contents) {
        src = bytesToLatin1(decodeStream(this.ctx, contents as unknown as PDFRawStream));
      }
      const out = this.processContent(src, res, ID.slice());
      // drop the old content stream objects so nothing stale (RGB) remains in the file
      const rawContents = node.get(PDFName.of('Contents'));
      const oldRefs = rawContents instanceof PDFRef ? [rawContents] : [];
      const arr = rawContents && this.ctx.lookup(rawContents);
      if (arr instanceof PDFArray) arr.asArray().forEach((r) => r instanceof PDFRef && oldRefs.push(r));
      node.set(PDFName.of('Contents'), this.ctx.register(this.ctx.flateStream(latin1ToBytes(out))));
      oldRefs.forEach((r) => this.ctx.delete(r));
      // page transparency group blending space
      if (this.mode !== 'rgb') {
        const grp = lookupDict(this.ctx, node.get(PDFName.of('Group')));
        if (grp) grp.set(PDFName.of('CS'), PDFName.of(this.deviceCS()));
        else
          node.set(
            PDFName.of('Group'),
            this.ctx.obj({ Type: 'Group', S: 'Transparency', CS: this.deviceCS(), I: false, K: false }),
          );
      }
    }
    await this.convertImages();
    this.report.spotsUsed = [...this.spotCS.keys()];
    this.report.leftovers = [...this.leftoverSet];
    return this.report;
  }

  deviceCS() {
    return this.mode === 'gray' ? 'DeviceGray' : this.mode === 'rgb' ? 'DeviceRGB' : 'DeviceCMYK';
  }

  // ---------- resources ----------

  private sub(res: PDFDict, key: string): PDFDict | undefined {
    return lookupDict(this.ctx, res.get(PDFName.of(key)));
  }

  /** Convert colour-bearing resources that don't depend on the CTM: shadings, patterns, colour spaces, soft-mask forms, Type3. */
  private prepareResources(res: PDFDict) {
    if (this.seen.has(res)) return;
    this.seen.add(res);
    const gs = this.sub(res, 'ExtGState');
    gs?.entries().forEach(([, v]) => {
      const g = lookupDict(this.ctx, v);
      const sm = g && lookupDict(this.ctx, g.get(PDFName.of('SMask')));
      const form = sm && sm.get(PDFName.of('G'));
      if (form) this.maskForms.add(this.ctx.lookup(form));
    });
    if (this.mode === 'rgb') return;
    this.sub(res, 'Shading')?.entries().forEach(([, v]) => this.convertShading(v));
    this.sub(res, 'Pattern')?.entries().forEach(([, v]) => this.convertPattern(v));
    this.sub(res, 'ColorSpace')?.entries().forEach(([k, v]) => {
      // plain RGB spaces stay: content-stream rewriting replaces their uses
      if (this.csKind(v) === 'rgb') return;
      const nv = this.convertColorSpaceObj(v);
      if (nv) this.sub(res, 'ColorSpace')!.set(k, nv);
    });
    this.sub(res, 'Font')?.entries().forEach(([, v]) => {
      const f = lookupDict(this.ctx, v);
      if (!f || f.get(PDFName.of('Subtype'))?.toString() !== '/Type3') return;
      if (this.seen.has(f)) return;
      this.seen.add(f);
      const procs = lookupDict(this.ctx, f.get(PDFName.of('CharProcs')));
      const fres = lookupDict(this.ctx, f.get(PDFName.of('Resources'))) || res;
      procs?.entries().forEach(([, ref]) => {
        const st = this.ctx.lookup(ref) as PDFRawStream;
        const src = bytesToLatin1(decodeStream(this.ctx, st));
        if (!/\bd0\b/.test(src)) return; // d1 glyphs take colour from context
        const out = this.processContent(src, fres, ID.slice());
        if (ref instanceof PDFRef) this.ctx.assign(ref, this.ctx.flateStream(latin1ToBytes(out)));
      });
    });
  }

  /** Classify a colour space object (name or array). */
  private csKind(o: PDFObject | undefined, res?: PDFDict): CSKind {
    if (!o) return 'other';
    let v = this.ctx.lookup(o);
    if (v instanceof PDFName) {
      const n = v.asString().slice(1);
      if (n === 'DeviceRGB' || n === 'RGB' || n === 'CalRGB') return 'rgb';
      if (n === 'DeviceGray' || n === 'G') return 'gray';
      if (n === 'DeviceCMYK' || n === 'CMYK') return 'cmyk';
      if (n === 'Pattern') return 'pattern';
      if (res) {
        const named = this.sub(res, 'ColorSpace')?.get(v);
        if (named) return this.csKind(named);
      }
      return 'other';
    }
    if (v instanceof PDFArray) {
      const fam = (this.ctx.lookup(v.get(0)) as PDFName).asString().slice(1);
      if (fam === 'CalRGB') return 'rgb';
      if (fam === 'CalGray') return 'gray';
      if (fam === 'ICCBased') {
        const st = this.ctx.lookup(v.get(1)) as PDFRawStream;
        const n = (this.ctx.lookup(st.dict.get(PDFName.of('N'))) as PDFNumber).asNumber();
        return n === 3 ? 'rgb' : n === 1 ? 'gray' : n === 4 ? 'cmyk' : 'other';
      }
      if (fam === 'Pattern') return 'pattern';
      return 'other';
    }
    return 'other';
  }

  private iccBytes(o: PDFObject | undefined): Uint8Array | undefined {
    const v = o && this.ctx.lookup(o);
    if (v instanceof PDFArray && (this.ctx.lookup(v.get(0)) as PDFName).asString() === '/ICCBased') {
      return decodeStream(this.ctx, this.ctx.lookup(v.get(1)) as PDFRawStream);
    }
    return undefined;
  }

  /** Returns replacement colour-space object, or undefined if unchanged. Converts Indexed palettes in place. */
  private convertColorSpaceObj(o: PDFObject): PDFObject | undefined {
    const v = this.ctx.lookup(o);
    if (this.csKind(v) === 'rgb') return PDFName.of(this.deviceCS());
    if (v instanceof PDFArray) {
      const fam = (this.ctx.lookup(v.get(0)) as PDFName).asString().slice(1);
      if (fam === 'Indexed' || fam === 'I') {
        const base = v.get(1);
        if (this.csKind(base) !== 'rgb') return undefined;
        const hival = (this.ctx.lookup(v.get(2)) as PDFNumber).asNumber();
        const lut = this.ctx.lookup(v.get(3));
        let bytes: Uint8Array;
        if (lut instanceof PDFRawStream) bytes = decodeStream(this.ctx, lut);
        else if (lut instanceof PDFHexString) bytes = lut.asBytes();
        else bytes = (lut as PDFString).asBytes();
        const n = hival + 1;
        const conv = this.eng.convertPixels(bytes.subarray(0, n * 3), n, this.iccBytes(base));
        return this.ctx.obj([PDFName.of('Indexed'), PDFName.of(this.deviceCS()), hival, PDFHexString.of(toHexStr(conv))]);
      }
      if (fam === 'Pattern' && v.size() > 1 && this.csKind(v.get(1)) === 'rgb') {
        return this.ctx.obj([PDFName.of('Pattern'), PDFName.of(this.deviceCS())]);
      }
    }
    return undefined;
  }

  private convertPattern(o: PDFObject) {
    const v = this.ctx.lookup(o);
    if (this.seen.has(v)) return;
    this.seen.add(v);
    const d = v instanceof PDFRawStream ? v.dict : (v as PDFDict);
    const type = (this.ctx.lookup(d.get(PDFName.of('PatternType'))) as PDFNumber).asNumber();
    if (type === 2) {
      const sh = d.get(PDFName.of('Shading'));
      if (sh) this.convertShading(sh);
      return;
    }
    // tiling pattern: content stream with its own resources
    const st = v as PDFRawStream;
    const res = lookupDict(this.ctx, d.get(PDFName.of('Resources'))) || this.ctx.obj({});
    this.prepareResources(res);
    const src = bytesToLatin1(decodeStream(this.ctx, st));
    const out = this.processContent(src, res, ID.slice());
    const ns = this.ctx.flateStream(latin1ToBytes(out));
    d.entries().forEach(([k, val]) => {
      const key = k.asString();
      if (key !== '/Filter' && key !== '/Length' && key !== '/DecodeParms') ns.dict.set(k, val);
    });
    if (o instanceof PDFRef) this.ctx.assign(o, ns);
  }

  /** Mapping used for gradients: overrides' CMYK or ICC result (never spot). Returns components 0..1 in output space. */
  private gradColor(rgb: number[]): number[] {
    if (this.mode === 'gray') return [this.eng.rgbToLab(rgb[0], rgb[1], rgb[2])[0] / 100];
    const ov = this.eng.settings.overrides[toHex(rgb[0], rgb[1], rgb[2])];
    let c = ov?.cmyk;
    if (ov?.spot) {
      const t = ov.spot.tint / 100;
      const a = ov.spot.alt;
      c = { c: a.c * t, m: a.m * t, y: a.y * t, k: a.k * t };
    }
    // no small-value snapping inside gradients (it would cause visible banding rings)
    c = c || this.eng.iccCmyk(rgb[0], rgb[1], rgb[2], false);
    return [c.c / 100, c.m / 100, c.y / 100, c.k / 100];
  }

  private convertShading(o: PDFObject) {
    const v = this.ctx.lookup(o);
    if (this.seen.has(v)) return;
    this.seen.add(v);
    const d = v instanceof PDFRawStream ? v.dict : (v as PDFDict);
    const csObj = d.get(PDFName.of('ColorSpace'));
    if (this.csKind(csObj) !== 'rgb') return;
    const type = (this.ctx.lookup(d.get(PDFName.of('ShadingType'))) as PDFNumber).asNumber();
    const nOut = this.mode === 'gray' ? 1 : 4;
    const fnObj = d.get(PDFName.of('Function'));
    const bg = this.ctx.lookup(d.get(PDFName.of('Background')));
    if (bg instanceof PDFArray) {
      const rgb = bg.asArray().map((x) => (this.ctx.lookup(x) as PDFNumber).asNumber());
      d.set(PDFName.of('Background'), this.ctx.obj(this.gradColor(rgb)));
    }
    if (fnObj) {
      const fn = buildFunction(this.ctx, fnObj);
      let domain: number[];
      if (type === 1) {
        const dm = this.ctx.lookup(d.get(PDFName.of('Domain')));
        domain = dm instanceof PDFArray ? dm.asArray().map((x) => (this.ctx.lookup(x) as PDFNumber).asNumber()) : [0, 1, 0, 1];
      } else if (type === 2 || type === 3) {
        const dm = this.ctx.lookup(d.get(PDFName.of('Domain')));
        domain = dm instanceof PDFArray ? dm.asArray().map((x) => (this.ctx.lookup(x) as PDFNumber).asNumber()) : [0, 1];
      } else {
        // mesh shading with parametric colour: t range from Decode
        const dec = this.ctx.lookup(d.get(PDFName.of('Decode'))) as PDFArray;
        const a = dec.asArray().map((x) => (this.ctx.lookup(x) as PDFNumber).asNumber());
        domain = [a[4], a[5]];
      }
      const samples = domain.length === 2 ? 256 : 48;
      const newFn = makeSampledFunction(this.ctx, (inp) => this.gradColor(fn(inp)), domain, nOut, samples);
      d.set(PDFName.of('Function'), this.ctx.register(newFn));
      d.set(PDFName.of('ColorSpace'), PDFName.of(this.deviceCS()));
      return;
    }
    if (type >= 4 && type <= 7 && v instanceof PDFRawStream) {
      const ok = this.convertMesh(o, v, type, nOut);
      if (!ok) this.leftoverSet.add('网格渐变（无法转换，保持 RGB）');
      return;
    }
    this.leftoverSet.add('未知渐变类型 ' + type);
  }

  /** Re-encode mesh shading vertex colours (types 4–7) into the output space. */
  private convertMesh(ref: PDFObject, st: PDFRawStream, type: number, nOut: number): boolean {
    const d = st.dict;
    const g = (k: string) => {
      const x = this.ctx.lookup(d.get(PDFName.of(k)));
      return x instanceof PDFNumber ? x.asNumber() : 0;
    };
    const bpCoord = g('BitsPerCoordinate');
    const bpComp = g('BitsPerComponent');
    const bpFlag = type === 5 ? 0 : g('BitsPerFlag');
    const perRow = g('VerticesPerRow');
    const dec = (this.ctx.lookup(d.get(PDFName.of('Decode'))) as PDFArray).asArray().map((x) => (this.ctx.lookup(x) as PDFNumber).asNumber());
    const data = decodeStream(this.ctx, st);
    if ((data as any).remaining) return false;
    // reader
    let bit = 0;
    const read = (n: number) => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const b = bit + i;
        v = v * 2 + ((data[b >> 3] >> (7 - (b & 7))) & 1);
      }
      bit += n;
      return v;
    };
    const align = () => {
      bit = Math.ceil(bit / 8) * 8;
    };
    // writer
    const outBits: number[] = [];
    const write = (v: number, n: number) => {
      for (let i = n - 1; i >= 0; i--) outBits.push(Math.floor(v / Math.pow(2, i)) % 2);
    };
    const walign = () => {
      while (outBits.length % 8) outBits.push(0);
    };
    const maxC = Math.pow(2, bpComp) - 1;
    const copyColor = () => {
      const rgb = [0, 1, 2].map((i) => dec[4 + i * 2] + (read(bpComp) / maxC) * (dec[5 + i * 2] - dec[4 + i * 2]));
      const c = this.gradColor(rgb);
      for (const x of c) write(Math.round(Math.max(0, Math.min(1, x)) * 255), 8);
    };
    const copy = (n: number) => write(read(n), n);
    const totalBits = data.length * 8;
    try {
      while (bit + bpCoord * 2 <= totalBits) {
        if (type === 4 || type === 5) {
          if (bpFlag) copy(bpFlag);
          copy(bpCoord);
          copy(bpCoord);
          copyColor();
          align();
          walign();
        } else {
          const flag = read(bpFlag);
          write(flag, bpFlag);
          const nPts = (type === 6 ? 12 : 16) - (flag ? 4 : 0);
          const nCol = flag ? 2 : 4;
          for (let i = 0; i < nPts * 2; i++) copy(bpCoord);
          for (let i = 0; i < nCol; i++) copyColor();
          align();
          walign();
        }
      }
    } catch {
      return false;
    }
    void perRow;
    const bytes = new Uint8Array(outBits.length / 8);
    for (let i = 0; i < bytes.length; i++) {
      let v = 0;
      for (let b = 0; b < 8; b++) v = (v << 1) | outBits[i * 8 + b];
      bytes[i] = v;
    }
    const nd = dec.slice(0, 4);
    for (let i = 0; i < nOut; i++) nd.push(0, 1);
    const ns = this.ctx.flateStream(bytes, {});
    d.entries().forEach(([k, val]) => {
      const key = k.asString();
      if (!['/Filter', '/Length', '/DecodeParms', '/Decode', '/BitsPerComponent', '/ColorSpace'].includes(key)) ns.dict.set(k, val);
    });
    ns.dict.set(PDFName.of('Decode'), this.ctx.obj(nd));
    ns.dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    ns.dict.set(PDFName.of('ColorSpace'), PDFName.of(this.deviceCS()));
    if (ref instanceof PDFRef) this.ctx.assign(ref, ns);
    else return false;
    return true;
  }

  // ---------- transparency (PDF/X-1a / X-3) ----------

  /** Remove image soft masks that are completely opaque (Figma attaches them to every image). */
  async dropOpaqueMasks() {
    for (const [ref, obj] of this.ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
      const sm = obj.dict.get(PDFName.of('SMask'));
      if (!(sm instanceof PDFRef)) continue;
      const mask = await decodeImage(this.ctx, this.ctx.lookup(sm) as PDFRawStream, 1);
      if (mask && mask.data.every((v) => v === 255)) {
        obj.dict.delete(PDFName.of('SMask'));
        this.ctx.delete(sm);
      }
      void ref;
    }
  }

  /** Does the document use live transparency (alpha, soft masks, blend modes)? */
  hasTransparency(): boolean {
    for (const [, obj] of this.ctx.enumerateIndirectObjects()) {
      const d = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
      if (!d) continue;
      if (obj instanceof PDFRawStream && d.get(PDFName.of('Subtype'))?.toString() === '/Image' && d.get(PDFName.of('SMask'))) return true;
      this.collectGs(d);
    }
    return this.transparent;
  }
  private transparent = false;
  private collectGs(d: PDFDict) {
    const check = (g: PDFDict) => {
      for (const key of ['ca', 'CA']) {
        const v = this.ctx.lookup(g.get(PDFName.of(key)));
        if (v instanceof PDFNumber && v.asNumber() < 0.999) this.transparent = true;
      }
      const sm = this.ctx.lookup(g.get(PDFName.of('SMask')));
      if (sm && sm.toString() !== '/None') this.transparent = true;
      const bm = this.ctx.lookup(g.get(PDFName.of('BM')));
      if (bm && !['/Normal', '/Compatible'].includes(bm.toString()) && !(bm instanceof PDFArray)) this.transparent = true;
    };
    if (d.get(PDFName.of('Type'))?.toString() === '/ExtGState' || d.has(PDFName.of('ca')) || d.has(PDFName.of('BM'))) check(d);
    const res = lookupDict(this.ctx, d.get(PDFName.of('Resources')));
    const gs = res && lookupDict(this.ctx, res.get(PDFName.of('ExtGState')));
    gs?.entries().forEach(([, v]) => {
      const g = lookupDict(this.ctx, v);
      if (g) check(g);
    });
  }

  /** Drop transparency group dictionaries (allowed only when nothing is actually transparent). */
  stripTransparencyGroups() {
    for (const [, obj] of this.ctx.enumerateIndirectObjects()) {
      const d = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
      if (d && d.has(PDFName.of('Group'))) d.delete(PDFName.of('Group'));
    }
  }

  // ---------- dieline strokes ----------

  /**
   * Draw centre-line strokes (cut / fold / score / perforation) in their spot separations with overprint.
   * Figma outlines strokes in its PDF export, which a cutting plotter would cut twice, so these
   * layers are removed from the Figma export and re-drawn here from their vector geometry.
   * `pageH` converts Figma's y-down coordinates to PDF's y-up.
   */
  addVectorStrokes(strokes: VectorStroke[], pageH: number) {
    if (!strokes.length) return;
    const page = this.doc.getPage(0).node;
    const res = page.Resources()!;
    const lines: string[] = ['q'];
    this.addRes(res, 'ExtGState', 'PKcut', this.ctx.register(this.ctx.obj({ Type: 'ExtGState', OP: true, op: true, OPM: 1 })));
    lines.push('/PKcut gs');
    for (const s of strokes) {
      let colour: string;
      if (this.mode === 'cmyk' && this.eng.keepSpot(s.spot.name)) {
        const nm = 'PKspot_' + s.spot.name.replace(/[^A-Za-z0-9]/g, '_');
        this.addRes(res, 'ColorSpace', nm, this.spotRef(s.spot));
        colour = `/${nm} CS ${fmt(s.spot.tint / 100)} SCN`;
      } else if (this.mode === 'gray') colour = '0 G';
      else if (this.mode === 'rgb') colour = '1 0 1 RG';
      else {
        const a = s.spot.alt;
        colour = `${fmt(a.c / 100)} ${fmt(a.m / 100)} ${fmt(a.y / 100)} ${fmt(a.k / 100)} K`;
      }
      lines.push(colour, `${fmt(s.weight)} w 0 J 0 j`, s.dash.length ? `[${s.dash.map(fmt).join(' ')}] 0 d` : '[] 0 d');
      for (const p of s.paths) lines.push(svgPathToPdf(p.d, p.m, pageH) + ' S');
    }
    lines.push('Q');
    const contents = page.get(PDFName.of('Contents'));
    const extra = this.ctx.register(this.ctx.flateStream(latin1ToBytes(lines.join('\n') + '\n')));
    page.set(PDFName.of('Contents'), this.ctx.obj(contents instanceof PDFArray ? [...contents.asArray(), extra] : [contents!, extra]));
  }

  // ---------- spot / overprint helpers ----------

  spotRef(spot: SpotDef): PDFRef {
    let r = this.spotCS.get(spot.name);
    if (!r) {
      const a = spot.alt;
      const tint = this.ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [a.c / 100, a.m / 100, a.y / 100, a.k / 100], N: 1 });
      r = this.ctx.register(this.ctx.obj([PDFName.of('Separation'), PDFName.of(spot.name), PDFName.of('DeviceCMYK'), tint]));
      this.spotCS.set(spot.name, r);
    }
    return r;
  }

  private addRes(res: PDFDict, cat: string, key: string, val: PDFObject) {
    let sub = this.sub(res, cat);
    if (!sub) {
      sub = this.ctx.obj({});
      res.set(PDFName.of(cat), sub);
    }
    if (!sub.has(PDFName.of(key))) sub.set(PDFName.of(key), val);
  }

  private gsRef(OP: boolean, op: boolean): PDFRef {
    const k = `${+OP}${+op}`;
    let r = this.gsCache.get(k);
    if (!r) {
      r = this.ctx.register(this.ctx.obj({ Type: 'ExtGState', OP, op, OPM: 1 }));
      this.gsCache.set(k, r);
    }
    return r;
  }

  /** Ops that set the colour `m` for fill (stroke=false) or stroke. */
  private colorOps(m: Mapped, stroke: boolean, res: PDFDict): Op[] {
    switch (m.kind) {
      case 'cmyk':
        return [mkOp(stroke ? 'K' : 'k', ...m.v.map(num))];
      case 'gray':
        return [mkOp(stroke ? 'G' : 'g', num(m.v))];
      case 'rgb':
        return [mkOp(stroke ? 'RG' : 'rg', ...m.v.map(num))];
      case 'spot': {
        const nm = 'PKspot_' + m.spot.name.replace(/[^A-Za-z0-9]/g, '_');
        this.addRes(res, 'ColorSpace', nm, this.spotRef(m.spot));
        return [mkOp(stroke ? 'CS' : 'cs', name(nm)), mkOp(stroke ? 'SCN' : 'scn', num(m.spot.tint / 100))];
      }
    }
  }

  private overprintOps(st: GState, wantFill: boolean | null, wantStroke: boolean | null, res: PDFDict): Op[] {
    const f = wantFill ?? st.opFill;
    const s = wantStroke ?? st.opStroke;
    if (f === st.opFill && s === st.opStroke) return [];
    st.opFill = f;
    st.opStroke = s;
    const nm = `PKop${+s}${+f}`;
    this.addRes(res, 'ExtGState', nm, this.gsRef(s, f));
    if (f || s) this.report.overprintObjects++;
    return [mkOp('gs', name(nm))];
  }

  // ---------- content streams ----------

  processContent(src: string, res: PDFDict, ctm: number[], inherit?: { fillCS: CSKind; strokeCS: CSKind }): string {
    const ops = parseContent(src);
    const out: Op[] = [];
    const stack: GState[] = [];
    // forms inherit the colour spaces in effect where they are painted (Figma sets them once per page)
    let st: GState = { ctm, fillCS: inherit?.fillCS ?? 'gray', strokeCS: inherit?.strokeCS ?? 'gray', fillBlack: true, fillMapped: null, opFill: false, opStroke: false, lw: 1, translucent: false };
    let bbox = [Infinity, Infinity, -Infinity, -Infinity];
    const addPt = (x: number, y: number) => {
      const m = st.ctm;
      const X = x * m[0] + y * m[2] + m[4];
      const Y = x * m[1] + y * m[3] + m[5];
      bbox = [Math.min(bbox[0], X), Math.min(bbox[1], Y), Math.max(bbox[2], X), Math.max(bbox[3], Y)];
    };
    let inText = false;
    const conv = this.mode !== 'rgb';
    const nums = (a: Tok[]) => a.map((t) => (typeof t.v === 'number' ? t.v : 0));
    const s = this.eng.settings;

    const emitColor = (rgb: number[], stroke: boolean) => {
      const m = this.eng.map(rgb[0], rgb[1], rgb[2]);
      out.push(...this.colorOps(m, stroke, res));
      if (this.mode === 'cmyk') {
        const op = m.overprint;
        out.push(...this.overprintOps(st, stroke ? null : op, stroke ? op : null, res));
      }
      if (!stroke) {
        st.fillBlack = this.eng.isPureBlack(rgb[0], rgb[1], rgb[2]);
        st.fillMapped = m;
      }
    };

    for (const o of ops) {
      const a = o.args;
      switch (o.op) {
        case 'q':
          stack.push({ ...st, ctm: st.ctm.slice() });
          out.push(o);
          continue;
        case 'Q':
          st = stack.pop() || st;
          out.push(o);
          continue;
        case 'cm':
          if (a.length === 6) st.ctm = mul(nums(a), st.ctm);
          out.push(o);
          continue;
        case 'BT':
          inText = true;
          out.push(o);
          continue;
        case 'ET':
          inText = false;
          out.push(o);
          continue;
        case 'w':
          st.lw = nums(a)[0] ?? 1;
          out.push(o);
          continue;
        case 'gs': {
          const g = lookupDict(this.ctx, this.sub(res, 'ExtGState')?.get(PDFName.of(String(a[0]?.v))));
          const lw = g && this.ctx.lookup(g.get(PDFName.of('LW')));
          if (lw instanceof PDFNumber) st.lw = lw.asNumber();
          const OP = g && this.ctx.lookup(g.get(PDFName.of('OP')));
          const opf = g && this.ctx.lookup(g.get(PDFName.of('op')));
          if (OP) st.opStroke = OP.toString() === 'true';
          if (opf) st.opFill = opf.toString() === 'true';
          else if (OP) st.opFill = st.opStroke;
          const ca = g && this.ctx.lookup(g.get(PDFName.of('ca')));
          const sm = g && this.ctx.lookup(g.get(PDFName.of('SMask')));
          if (ca instanceof PDFNumber) st.translucent = ca.asNumber() < 0.999;
          if (sm) st.translucent = st.translucent || sm.toString() !== '/None';
          out.push(o);
          continue;
        }
      }
      if (conv) {
        switch (o.op) {
          case 'rg':
          case 'RG': {
            const stroke = o.op === 'RG';
            if (stroke) st.strokeCS = 'rgb';
            else st.fillCS = 'rgb';
            emitColor(nums(a), stroke);
            continue;
          }
          case 'g':
          case 'G': {
            const stroke = o.op === 'G';
            const v = nums(a)[0];
            if (this.mode === 'cmyk') {
              // DeviceGray in a CMYK job = K only
              out.push(mkOp(stroke ? 'K' : 'k', num(0), num(0), num(0), num(1 - v)));
              const black = v <= 0.002;
              out.push(...this.overprintOps(st, stroke ? null : black && s.overprintBlack, stroke ? black && s.overprintBlack : null, res));
            } else out.push(o);
            if (!stroke) {
              st.fillBlack = v <= 0.002;
              st.fillMapped = null;
              st.fillCS = 'gray';
            } else st.strokeCS = 'gray';
            continue;
          }
          case 'k':
          case 'K': {
            if (this.mode === 'gray') {
              const [c, m, y, k] = nums(a);
              const gv = 1 - Math.min(1, k + 0.3 * c + 0.59 * m + 0.11 * y);
              out.push(mkOp(o.op === 'K' ? 'G' : 'g', num(gv)));
            } else out.push(o);
            if (o.op === 'k') {
              st.fillCS = 'cmyk';
              st.fillBlack = false;
              st.fillMapped = null;
            } else st.strokeCS = 'cmyk';
            continue;
          }
          case 'cs':
          case 'CS': {
            const stroke = o.op === 'CS';
            const kind = this.csKind(a[0] ? PDFName.of(String(a[0].v)) : undefined, res);
            if (stroke) st.strokeCS = kind;
            else st.fillCS = kind;
            if (kind === 'rgb') {
              // initial colour of an RGB space is black
              out.push(mkOp(o.op, name(this.deviceCS())));
              continue;
            }
            out.push(o);
            continue;
          }
          case 'sc':
          case 'scn':
          case 'SC':
          case 'SCN': {
            const stroke = o.op === 'SC' || o.op === 'SCN';
            const kind = stroke ? st.strokeCS : st.fillCS;
            if (kind === 'rgb' && a.length >= 3 && a.every((t) => t.t === 'num')) {
              emitColor(nums(a), stroke);
              continue;
            }
            if (kind === 'pattern') {
              // patterns handled via resources; underlying RGB components of uncoloured patterns
              const comps = a.filter((t) => t.t === 'num');
              if (comps.length === 3) {
                const m = this.eng.map(...(nums(comps) as [number, number, number]));
                const vals = m.kind === 'cmyk' ? m.v : m.kind === 'gray' ? [m.v] : nums(comps);
                out.push(mkOp(o.op, ...vals.map(num), ...a.filter((t) => t.t === 'name')));
                continue;
              }
            }
            out.push(o);
            continue;
          }
          case 'BI':
            this.leftoverSet.add('内嵌小图片（inline image）保持原色');
            out.push(o);
            continue;
          case 'd0':
            out.push(o);
            continue;
        }
      }
      // path construction: track device-space bbox for rich-black size test
      if (o.op === 're' && a.length === 4) {
        const [x, y, w, h] = nums(a);
        addPt(x, y);
        addPt(x + w, y + h);
      } else if ((o.op === 'm' || o.op === 'l') && a.length === 2) addPt(...(nums(a) as [number, number]));
      else if (o.op === 'c' && a.length === 6) {
        const v = nums(a);
        addPt(v[4], v[5]);
      }
      // painting / XObjects
      if (o.op === 'Do') {
        const xo = this.sub(res, 'XObject');
        const ref = xo?.get(PDFName.of(String(a[0]?.v)));
        if (ref) this.handleXObject(ref, st.ctm, { fillCS: st.fillCS, strokeCS: st.strokeCS });
        out.push(o);
        continue;
      }
      if (o.op === 'sh') {
        out.push(o);
        continue;
      }
      if (PAINT_STROKE.has(o.op) && this.opts.minStrokePt > 0) {
        const eff = st.lw * scaleOf(st.ctm);
        if (eff < this.opts.minStrokePt) {
          const need = this.opts.minStrokePt / Math.max(1e-9, scaleOf(st.ctm));
          out.push(mkOp('w', num(need)));
          st.lw = need;
          this.report.hairlinesFixed++;
        }
      }
      const bigEnough = bbox[2] - bbox[0] >= RICH_MIN_PT && bbox[3] - bbox[1] >= RICH_MIN_PT;
      if (PAINT_FILL.has(o.op) || PAINT_STROKE.has(o.op) || o.op === 'n') bbox = [Infinity, Infinity, -Infinity, -Infinity];
      if (PAINT_FILL.has(o.op) && bigEnough && !st.translucent && !inText && conv && this.mode === 'cmyk' && s.richBlack && st.fillBlack && st.fillCS !== 'pattern') {
        const r = s.richBlack;
        out.push(mkOp('k', num(r.c / 100), num(r.m / 100), num(r.y / 100), num(r.k / 100)));
        const wasOp = st.opFill;
        out.push(...this.overprintOps(st, false, null, res));
        out.push(o);
        // restore previous fill
        out.push(...(st.fillMapped ? this.colorOps(st.fillMapped, false, res) : [mkOp('k', num(0), num(0), num(0), num(1))]));
        out.push(...this.overprintOps(st, wasOp, null, res));
        this.report.richBlackFills++;
        continue;
      }
      out.push(o);
    }
    return serialize(out);
  }

  private handleXObject(ref: PDFObject, ctm: number[], inherit?: { fillCS: CSKind; strokeCS: CSKind }) {
    const obj = this.ctx.lookup(ref);
    if (!(obj instanceof PDFRawStream)) return;
    const d = obj.dict;
    const sub = d.get(PDFName.of('Subtype'))?.toString();
    if (sub === '/Image') {
      if (ref instanceof PDFRef) {
        // image space is the unit square → placement size in points
        const wPt = Math.hypot(ctm[0], ctm[1]);
        const hPt = Math.hypot(ctm[2], ctm[3]);
        const w = (this.ctx.lookup(d.get(PDFName.of('Width'))) as PDFNumber).asNumber();
        const h = (this.ctx.lookup(d.get(PDFName.of('Height'))) as PDFNumber).asNumber();
        const ppi = Math.min(w / Math.max(1e-6, wPt / 72), h / Math.max(1e-6, hPt / 72));
        const prev = this.imageUse.get(ref);
        // keep the *lowest* ppi = largest placement
        if (!prev || ppi < prev.ppi) this.imageUse.set(ref, { ppi });
      }
      return;
    }
    if (sub !== '/Form') return;
    if (this.maskForms.has(obj)) {
      // soft-mask groups stay as-is (luminosity is computed in their own space)
      return;
    }
    const mtx = this.ctx.lookup(d.get(PDFName.of('Matrix')));
    const m = mtx instanceof PDFArray ? mtx.asArray().map((x) => (this.ctx.lookup(x) as PDFNumber).asNumber()) : ID;
    const fctm = mul(m, ctm);
    const res = lookupDict(this.ctx, d.get(PDFName.of('Resources'))) || this.ctx.obj({});
    if (!d.get(PDFName.of('Resources'))) d.set(PDFName.of('Resources'), res);
    if (this.seen.has(obj)) {
      // already converted — still walk for image placement sizes
      this.walkForImages(obj, res, fctm);
      return;
    }
    this.seen.add(obj);
    this.prepareResources(res);
    const src = bytesToLatin1(decodeStream(this.ctx, obj));
    const out = this.processContent(src, res, fctm, inherit);
    const ns = this.ctx.flateStream(latin1ToBytes(out));
    d.entries().forEach(([k, val]) => {
      const key = k.asString();
      if (key !== '/Filter' && key !== '/Length' && key !== '/DecodeParms') ns.dict.set(k, val);
    });
    if (this.mode !== 'rgb') {
      const grp = lookupDict(this.ctx, ns.dict.get(PDFName.of('Group')));
      if (grp && grp.get(PDFName.of('CS')) && this.csKind(grp.get(PDFName.of('CS'))) === 'rgb') grp.set(PDFName.of('CS'), PDFName.of(this.deviceCS()));
    }
    if (ref instanceof PDFRef) this.ctx.assign(ref, ns);
    this.seen.add(ns);
  }

  private walkForImages(obj: PDFRawStream, res: PDFDict, ctm: number[]) {
    const ops = parseContent(bytesToLatin1(decodeStream(this.ctx, obj)));
    const stack: number[][] = [];
    let m = ctm;
    for (const o of ops) {
      if (o.op === 'q') stack.push(m);
      else if (o.op === 'Q') m = stack.pop() || m;
      else if (o.op === 'cm' && o.args.length === 6) m = mul(o.args.map((t) => Number(t.v)), m);
      else if (o.op === 'Do') {
        const ref = this.sub(res, 'XObject')?.get(PDFName.of(String(o.args[0]?.v)));
        if (ref) this.handleXObject(ref, m);
      }
    }
  }

  // ---------- images ----------

  private async convertImages() {
    for (const [ref, use] of this.imageUse) {
      const st = this.ctx.lookup(ref) as PDFRawStream;
      const d = st.dict;
      const info: ImageInfo = {
        ref: ref.toString(),
        w: (this.ctx.lookup(d.get(PDFName.of('Width'))) as PDFNumber).asNumber(),
        h: (this.ctx.lookup(d.get(PDFName.of('Height'))) as PDFNumber).asNumber(),
        ppi: Math.round(use.ppi),
        converted: false,
      };
      this.report.images.push(info);
      if (d.get(PDFName.of('ImageMask'))?.toString() === 'true') continue;
      const csObj = d.get(PDFName.of('ColorSpace'));
      const kind = this.csKind(csObj);
      const csv = this.ctx.lookup(csObj);
      const isIndexed = csv instanceof PDFArray && ['/Indexed', '/I'].includes((this.ctx.lookup(csv.get(0)) as PDFName).asString());
      const isJpeg = (decodeStream(this.ctx, st) as any).remaining === 'DCTDecode';
      const max = this.opts.maxPpi;
      const needDown = max > 0 && use.ppi > max * 1.5 && !isIndexed;
      const needColor = this.mode !== 'rgb' && kind === 'rgb';
      if (isIndexed && this.mode !== 'rgb') {
        const nv = this.convertColorSpaceObj(csObj!);
        if (nv) {
          d.set(PDFName.of('ColorSpace'), nv);
          info.converted = true;
        }
        continue;
      }
      if (!needDown && !needColor) continue;
      const comps = kind === 'rgb' ? 3 : kind === 'gray' ? 1 : kind === 'cmyk' ? 4 : 0;
      if (!comps) {
        if (needColor) this.leftoverSet.add('特殊色彩空间的图片保持原样');
        continue;
      }
      let r = await decodeImage(this.ctx, st, comps);
      if (!r) {
        this.leftoverSet.add('JPEG2000 等特殊编码图片无法转换');
        continue;
      }
      if (isJpeg && r.comps === 4) {
        // Adobe CMYK JPEG: leave untouched unless we must downsample
        if (!needDown) continue;
      }
      // optional /Decode inversion (e.g. [1 0 1 0 1 0])
      const decArr = this.ctx.lookup(d.get(PDFName.of('Decode')));
      if (decArr instanceof PDFArray && !isJpeg) {
        const dv = decArr.asArray().map((x) => (this.ctx.lookup(x) as PDFNumber).asNumber());
        if (dv[0] === 1 && dv[1] === 0) for (let i = 0; i < r.data.length; i++) r.data[i] = 255 - r.data[i];
      }
      let smaskRaster: { ref: PDFObject; w: number; h: number } | null = null;
      if (needDown) {
        const f = max / use.ppi;
        const nw = Math.max(1, Math.round(r.w * f));
        const nh = Math.max(1, Math.round(r.h * f));
        r = resample(r, nw, nh);
        info.newW = nw;
        info.newH = nh;
        const sm = d.get(PDFName.of('SMask'));
        if (sm instanceof PDFRef) smaskRaster = { ref: sm, w: nw, h: nh };
      }
      let outData = r.data;
      let outCS: PDFObject = csObj!;
      let outComps = r.comps;
      if (needColor && r.comps === 3) {
        outData = this.eng.convertPixels(r.data, r.w * r.h, this.iccBytes(csObj));
        outComps = this.mode === 'gray' ? 1 : 4;
        outCS = PDFName.of(this.deviceCS());
        info.converted = true;
      } else if (isJpeg) {
        outCS = r.comps === 1 ? PDFName.of('DeviceGray') : r.comps === 4 ? PDFName.of('DeviceCMYK') : csObj!;
      }
      const px = outData.subarray(0, r.w * r.h * outComps);
      const comp = this.opts.imageCompression || 'auto';
      const useJpeg = (comp === 'jpeg' || (comp === 'auto' && isJpeg)) && r.w * r.h >= 256 && (outComps === 1 || outComps === 3 || outComps === 4);
      const ns = useJpeg
        ? this.ctx.stream(encodeJpeg(px, r.w, r.h, outComps as 1 | 3 | 4, this.opts.jpegQuality ?? 92), { Filter: 'DCTDecode' })
        : this.ctx.flateStream(px, {});
      if (useJpeg && outComps === 4) ns.dict.set(PDFName.of('Decode'), this.ctx.obj([1, 0, 1, 0, 1, 0, 1, 0])); // Adobe inverted CMYK
      d.entries().forEach(([k, val]) => {
        if (!['/Filter', '/Length', '/DecodeParms', '/ColorSpace', '/Width', '/Height', '/BitsPerComponent', '/Decode', '/ColorTransform'].includes(k.asString()))
          ns.dict.set(k, val);
      });
      ns.dict.set(PDFName.of('Width'), PDFNumber.of(r.w));
      ns.dict.set(PDFName.of('Height'), PDFNumber.of(r.h));
      ns.dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      ns.dict.set(PDFName.of('ColorSpace'), outCS);
      this.ctx.assign(ref, ns);
      if (smaskRaster) await this.downsampleMask(smaskRaster.ref as PDFRef, smaskRaster.w, smaskRaster.h);
    }
  }

  private async downsampleMask(ref: PDFRef, nw: number, nh: number) {
    const st = this.ctx.lookup(ref) as PDFRawStream;
    const r = await decodeImage(this.ctx, st, 1);
    if (!r || (r.w <= nw && r.h <= nh)) return;
    const s = resample(r, nw, nh);
    const ns = this.ctx.flateStream(s.data, {});
    st.dict.entries().forEach(([k, val]) => {
      if (!['/Filter', '/Length', '/DecodeParms', '/Width', '/Height', '/BitsPerComponent'].includes(k.asString())) ns.dict.set(k, val);
    });
    ns.dict.set(PDFName.of('Width'), PDFNumber.of(s.w));
    ns.dict.set(PDFName.of('Height'), PDFNumber.of(s.h));
    ns.dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    ns.dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceGray'));
    this.ctx.assign(ref, ns);
  }
}

function toHexStr(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** Audit a PDF for remaining RGB usage (used by tests and the post-export report). */
export function auditRgb(doc: PDFDocument): { rgbOps: number; rgbImages: number; rgbShadings: number } {
  const ctx = doc.context;
  let rgbOps = 0,
    rgbImages = 0,
    rgbShadings = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const d = obj.dict;
      const sub = d.get(PDFName.of('Subtype'))?.toString();
      const cs = d.get(PDFName.of('ColorSpace'));
      const csv = cs && ctx.lookup(cs);
      const isRgb = (x: any) =>
        x?.toString() === '/DeviceRGB' ||
        (x instanceof PDFArray && x.size() > 1 && x.get(0).toString() === '/ICCBased' && (ctx.lookup((ctx.lookup(x.get(1)) as PDFRawStream).dict.get(PDFName.of('N'))) as PDFNumber).asNumber() === 3);
      if (sub === '/Image' && isRgb(csv)) rgbImages++;
      else if (d.get(PDFName.of('ShadingType')) && isRgb(csv)) rgbShadings++;
      else if (!sub || sub === '/Form') {
        if (d.get(PDFName.of('FunctionType')) || d.get(PDFName.of('N'))) continue;
        const grp = lookupDict(ctx, d.get(PDFName.of('Group')));
        if (grp && ctx.lookup(grp.get(PDFName.of('CS')))?.toString() === '/DeviceGray') continue; // soft masks
        try {
          const txt = bytesToLatin1(decodeStream(ctx, obj));
          const m = txt.match(/(^|\s)(rg|RG)(\s|$)/g);
          if (m && !/\bd1\b/.test(txt.slice(0, 40))) rgbOps += m.length;
        } catch {
          /* binary */
        }
      }
    } else if (obj instanceof PDFDict && obj.get(PDFName.of('ShadingType'))) {
      const cs = ctx.lookup(obj.get(PDFName.of('ColorSpace')));
      if (cs?.toString() === '/DeviceRGB') rgbShadings++;
    } else if (obj instanceof PDFDict && obj.get(PDFName.of('PatternType'))) {
      const sh = lookupDict(ctx, obj.get(PDFName.of('Shading')));
      if (sh && ctx.lookup(sh.get(PDFName.of('ColorSpace')))?.toString() === '/DeviceRGB') rgbShadings++;
    }
  }
  return { rgbOps, rgbImages, rgbShadings };
}

export { fmt };

/** Convert SVG path data (M/L/H/V/C/S/Q/T/Z, absolute or relative) to PDF path operators. */
export function svgPathToPdf(d: string, m: number[], pageH: number): string {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const out: string[] = [];
  const P = (x: number, y: number) => {
    const X = m[0] * x + m[2] * y + m[4];
    const Y = m[1] * x + m[3] * y + m[5];
    return `${fmt(X)} ${fmt(pageH - Y)}`;
  };
  let i = 0, cmd = '', cx = 0, cy = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lqx = 0, lqy = 0;
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    if (C === 'Z') { out.push('h'); cx = sx; cy = sy; continue; }
    if (C === 'M') { cx = ox + num(); cy = oy + num(); sx = cx; sy = cy; out.push(`${P(cx, cy)} m`); cmd = rel ? 'l' : 'L'; lcx = cx; lcy = cy; lqx = cx; lqy = cy; continue; }
    if (C === 'L') { cx = ox + num(); cy = oy + num(); out.push(`${P(cx, cy)} l`); }
    else if (C === 'H') { cx = ox + num(); out.push(`${P(cx, cy)} l`); }
    else if (C === 'V') { cy = (rel ? cy : 0) + num(); out.push(`${P(cx, cy)} l`); }
    else if (C === 'C' || C === 'S') {
      let x1: number, y1: number;
      if (C === 'C') { x1 = ox + num(); y1 = oy + num(); } else { x1 = 2 * cx - lcx; y1 = 2 * cy - lcy; }
      const x2 = ox + num(), y2 = oy + num(), x = ox + num(), y = oy + num();
      out.push(`${P(x1, y1)} ${P(x2, y2)} ${P(x, y)} c`);
      lcx = x2; lcy = y2; cx = x; cy = y; lqx = cx; lqy = cy;
      continue;
    } else if (C === 'Q' || C === 'T') {
      let qx: number, qy: number;
      if (C === 'Q') { qx = ox + num(); qy = oy + num(); } else { qx = 2 * cx - lqx; qy = 2 * cy - lqy; }
      const x = ox + num(), y = oy + num();
      // quadratic → cubic
      out.push(`${P(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy))} ${P(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y))} ${P(x, y)} c`);
      lqx = qx; lqy = qy; cx = x; cy = y; lcx = cx; lcy = cy;
      continue;
    } else { i++; continue; } // arcs are not produced by Figma's vectorPaths
    lcx = cx; lcy = cy; lqx = cx; lqy = cy;
  }
  return out.join(' ');
}
