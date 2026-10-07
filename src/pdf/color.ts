// Colour engine: ICC-based RGB → CMYK / Gray conversion via LittleCMS (lcms-wasm),
// plus the prepress rules on top (pure black → K, neutral grey → K only, TAC limit,
// manual overrides, spot colours).

import {
  instantiate,
  TYPE_RGB_8,
  TYPE_CMYK_8,
  cmsFLAGS_BLACKPOINTCOMPENSATION,
  cmsFLAGS_HIGHRESPRECALC,
  cmsInfoDescription,
} from 'lcms-wasm';

// Float formats (lcms-wasm only supports 32-bit floats). Float CMYK is 0..100, RGB 0..1, Lab L 0..100.
const FLT = (cs: number, ch: number) => (1 << 22) | (cs << 16) | (ch << 3) | 4;
const TYPE_RGB_DBL = FLT(4, 3);
const TYPE_CMYK_DBL = FLT(6, 4);
const TYPE_Lab_DBL = FLT(10, 3);

export type OutputMode = 'cmyk' | 'rgb' | 'gray';
export type Intent = 0 | 1 | 2 | 3; // perceptual, relative, saturation, absolute

export interface CMYK {
  c: number; // 0..100
  m: number;
  y: number;
  k: number;
}

export interface SpotDef {
  name: string; // ink name, e.g. "PANTONE 186 C"
  tint: number; // 0..100 density
  alt: CMYK; // alternate (process) appearance at 100%
}

export interface ColorOverride {
  hex: string; // "#RRGGBB" uppercase
  cmyk?: CMYK; // manual process value
  spot?: SpotDef; // map to spot ink
  overprint?: boolean;
}

export interface ColorSettings {
  mode: OutputMode;
  intent: Intent;
  bpc: boolean; // black point compensation
  pureBlackToK: boolean; // #000000 → 0/0/0/100
  grayToK: boolean; // neutral greys → K only
  richBlack: CMYK | null; // non-text pure-black fills → rich black (null = off)
  tacLimit: number; // total area coverage %, 0 = off
  overrides: Record<string, ColorOverride>; // keyed by HEX
  spotPolicy: 'preserve' | 'flatten' | 'keepListed';
  keepSpots: string[];
  overprintBlack: boolean; // 100% K objects overprint
  removeWhiteOverprint: boolean;
  forceSpots?: string[]; // finishing separations (cut, varnish…) that must stay spot whatever the policy
}

export const defaultColorSettings = (): ColorSettings => ({
  mode: 'cmyk',
  intent: 1,
  bpc: true,
  pureBlackToK: true,
  grayToK: true,
  richBlack: null,
  tacLimit: 320,
  overrides: {},
  spotPolicy: 'preserve',
  keepSpots: [],
  overprintBlack: true,
  removeWhiteOverprint: true,
});

// Result of mapping one RGB colour.
export type Mapped =
  | { kind: 'cmyk'; v: [number, number, number, number]; overprint: boolean } // 0..1
  | { kind: 'gray'; v: number; overprint: boolean }
  | { kind: 'rgb'; v: [number, number, number]; overprint: boolean }
  | { kind: 'spot'; spot: SpotDef; overprint: boolean };

let lcmsPromise: Promise<any> | null = null;
export function loadLcms(wasmBinary?: Uint8Array): Promise<any> {
  if (!lcmsPromise) lcmsPromise = instantiate(wasmBinary ? { wasmBinary } : undefined);
  return lcmsPromise!;
}

export const toHex = (r: number, g: number, b: number) =>
  '#' +
  [r, g, b]
    .map((x) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

export class ColorEngine {
  lcms: any;
  settings: ColorSettings;
  outProfile: any = null; // CMYK (or gray) output profile handle
  outProfileBytes: Uint8Array | null = null;
  outProfileName = '';
  private srgb: any;
  private lab: any;
  private xfRgbDbl: any = null; // sRGB (float) → CMYK (float)
  private xfRgb8: any = null; // sRGB 8bit → CMYK 8bit (images)
  private xfCmykLab: any = null;
  private xfRgbLab: any = null;
  private srcXf8 = new Map<string, any>(); // per embedded ICC (images) → CMYK 8bit
  private cache = new Map<string, Mapped>();
  private kCurve: number[] | null = null; // L* (0..100 step 1) → K for K-only greys
  private kRange: [number, number] | null = null; // [L* of paper, L* of K100]
  usage = new Map<string, number>(); // hex → occurrences in PDF (diagnostics)

  constructor(lcms: any, settings: ColorSettings) {
    this.lcms = lcms;
    this.settings = settings;
    this.srgb = lcms.cmsCreate_sRGBProfile();
    this.lab = lcms.cmsCreateLab4Profile(null);
    this.xfRgbLab = lcms.cmsCreateTransform(this.srgb, TYPE_RGB_DBL, this.lab, TYPE_Lab_DBL, 1, 0);
  }

  setOutputProfile(bytes: Uint8Array) {
    const l = this.lcms;
    const p = l.cmsOpenProfileFromMem(bytes, bytes.byteLength);
    if (!p) throw new Error('无法读取 ICC 配置文件');
    const space = l.cmsGetColorSpaceASCII(p).trim();
    if (space !== 'CMYK') throw new Error(`这个 ICC 不是 CMYK 印刷配置文件（实际是 ${space}）`);
    this.outProfile = p;
    this.outProfileBytes = bytes;
    this.outProfileName = l.cmsGetProfileInfoASCII(p, cmsInfoDescription, 'en', 'US') || 'CMYK';
    this.rebuild();
  }

  static describeProfile(lcms: any, bytes: Uint8Array): { name: string; space: string } {
    const p = lcms.cmsOpenProfileFromMem(bytes, bytes.byteLength);
    if (!p) throw new Error('无法读取 ICC 配置文件');
    const r = {
      name: lcms.cmsGetProfileInfoASCII(p, cmsInfoDescription, 'en', 'US') || '未命名',
      space: lcms.cmsGetColorSpaceASCII(p).trim(),
    };
    lcms.cmsCloseProfile(p);
    return r;
  }

  rebuild() {
    const l = this.lcms;
    this.cache.clear();
    this.srcXf8.clear();
    this.xfProof = null;
    this.xfProof8 = {};
    this.kLutCache = null;
    if (!this.outProfile) return;
    const flags = (this.settings.bpc ? cmsFLAGS_BLACKPOINTCOMPENSATION : 0) | cmsFLAGS_HIGHRESPRECALC;
    const intent = this.settings.intent;
    this.xfRgbDbl = l.cmsCreateTransform(this.srgb, TYPE_RGB_DBL, this.outProfile, TYPE_CMYK_DBL, intent, flags);
    this.xfRgb8 = l.cmsCreateTransform(this.srgb, TYPE_RGB_8, this.outProfile, TYPE_CMYK_8, intent, flags);
    this.xfCmykLab = l.cmsCreateTransform(this.outProfile, TYPE_CMYK_DBL, this.lab, TYPE_Lab_DBL, 1, 0);
    // K-only curve: for each L* find K so that CMYK(0,0,0,K) has that lightness
    const ls: number[] = [];
    for (let k = 0; k <= 100; k++) {
      const lab = l.cmsDoTransform(this.xfCmykLab, new Float32Array([0, 0, 0, k]), 1);
      ls.push(lab[0]);
    }
    const curve: number[] = [];
    for (let L = 0; L <= 100; L++) {
      // ls is decreasing with k
      let k = 100;
      for (let i = 0; i < 100; i++) {
        if (ls[i] >= L && ls[i + 1] <= L) {
          const t = (ls[i] - L) / Math.max(1e-6, ls[i] - ls[i + 1]);
          k = i + t;
          break;
        }
      }
      if (L >= ls[0]) k = 0;
      curve.push(k);
    }
    this.kCurve = curve;
    this.kRange = [ls[0], ls[100]];
  }

  private kLutCache: Uint8Array | null = null;
  /** K value (0..255) for each neutral grey level, from the K-only curve. */
  private kLut(): Uint8Array {
    if (this.kLutCache) return this.kLutCache;
    const lut = new Uint8Array(256);
    const save = this.settings.grayToK;
    this.settings.grayToK = true;
    for (let v = 0; v < 256; v++) lut[v] = Math.round((this.iccCmyk(v / 255, v / 255, v / 255).k / 100) * 255);
    this.settings.grayToK = save;
    this.kLutCache = lut;
    return lut;
  }

  /** Lab of an sRGB colour (0..1 channels). */
  rgbToLab(r: number, g: number, b: number): [number, number, number] {
    const o = this.lcms.cmsDoTransform(this.xfRgbLab, new Float32Array([r, g, b]), 1);
    return [o[0], o[1], o[2]];
  }

  /** CMYK (0..100) → Lab for soft proofing / ΔE display. */
  cmykToLab(c: CMYK): [number, number, number] {
    if (!this.xfCmykLab) return [0, 0, 0];
    const o = this.lcms.cmsDoTransform(this.xfCmykLab, new Float32Array([c.c, c.m, c.y, c.k]), 1);
    return [o[0], o[1], o[2]];
  }

  private xfProof: any = null;
  /** Simulated print appearance of a CMYK colour as a CSS hex (soft proof). */
  proofHex(c: CMYK): string {
    if (!this.outProfile) {
      const r = (1 - c.c / 100) * (1 - c.k / 100), g = (1 - c.m / 100) * (1 - c.k / 100), b = (1 - c.y / 100) * (1 - c.k / 100);
      return toHex(r, g, b);
    }
    if (!this.xfProof) this.xfProof = this.lcms.cmsCreateTransform(this.outProfile, TYPE_CMYK_DBL, this.srgb, TYPE_RGB_DBL, 1, cmsFLAGS_BLACKPOINTCOMPENSATION);
    const o = this.lcms.cmsDoTransform(this.xfProof, new Float32Array([c.c, c.m, c.y, c.k]), 1);
    return toHex(o[0], o[1], o[2]);
  }

  private xfProof8: Record<string, any> = {};
  /** CMYK 8-bit pixels → sRGB 8-bit (soft proof). `paper` simulates paper white (absolute colorimetric). */
  proofPixels(cmyk: Uint8Array, count: number, paper = false): Uint8Array {
    const l = this.lcms;
    if (!this.outProfile) {
      const out = new Uint8Array(count * 3);
      for (let i = 0; i < count; i++) {
        const k = 1 - cmyk[i * 4 + 3] / 255;
        for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(255 * (1 - cmyk[i * 4 + c] / 255) * k);
      }
      return out;
    }
    const key = paper ? 'abs' : 'rel';
    if (!this.xfProof8[key]) this.xfProof8[key] = l.cmsCreateTransform(this.outProfile, TYPE_CMYK_8, this.srgb, TYPE_RGB_8, paper ? 3 : 1, paper ? 0 : cmsFLAGS_BLACKPOINTCOMPENSATION);
    const out = new Uint8Array(count * 3);
    const CH = 1 << 18;
    for (let off = 0; off < count; off += CH) {
      const n = Math.min(CH, count - off);
      out.set(l.cmsDoTransform(this.xfProof8[key], cmyk.subarray(off * 4, (off + n) * 4), n), off * 3);
    }
    return out;
  }

  private xfRgb8Lab: any = null;
  /** 8-bit RGB pixels → Lab (float32 triples). */
  rgbPixelsToLab(rgb: Uint8Array, count: number): Float32Array {
    const l = this.lcms;
    if (!this.xfRgb8Lab) this.xfRgb8Lab = l.cmsCreateTransform(this.srgb, TYPE_RGB_8, this.lab, TYPE_Lab_DBL, 1, 0);
    const out = new Float32Array(count * 3);
    const CH = 1 << 17;
    for (let off = 0; off < count; off += CH) {
      const n = Math.min(CH, count - off);
      out.set(l.cmsDoTransform(this.xfRgb8Lab, rgb.subarray(off * 3, (off + n) * 3), n), off * 3);
    }
    return out;
  }

  /** ΔE76 between the screen colour and its printed (ICC-converted) appearance. */
  gamutDeltaE(r: number, g: number, b: number, c: CMYK): number {
    if (!this.outProfile) return 0;
    // Black / grays deliberately printed with K only are a chosen trade-off, not a gamut problem.
    if (c.c === 0 && c.m === 0 && c.y === 0 && Math.abs(r - g) < 0.004 && Math.abs(g - b) < 0.004) return 0;
    const a = this.rgbToLab(r, g, b);
    const p = this.cmykToLab(c);
    return Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2]);
  }

  /** Default ICC conversion (no overrides) for display in the UI. Values 0..100. */
  iccCmyk(r: number, g: number, b: number, snapSmall = true): CMYK {
    const s = this.settings;
    if (r >= 0.996 && g >= 0.996 && b >= 0.996) return { c: 0, m: 0, y: 0, k: 0 };
    if (s.pureBlackToK && r <= 0.004 && g <= 0.004 && b <= 0.004) return { c: 0, m: 0, y: 0, k: 100 };
    if (s.grayToK && Math.abs(r - g) < 0.004 && Math.abs(g - b) < 0.004 && this.kCurve) {
      if (r >= 0.996) return { c: 0, m: 0, y: 0, k: 0 };
      let L = this.rgbToLab(r, g, b)[0];
      // black point compensation: scale sRGB lightness into the K-only range (paper white … K100)
      if (s.bpc && this.kRange) L = this.kRange[1] + (L / 100) * (this.kRange[0] - this.kRange[1]);
      const k = interp(this.kCurve, L);
      return { c: 0, m: 0, y: 0, k: round1(k) };
    }
    if (!this.xfRgbDbl) return naiveCmyk(r, g, b);
    const o = this.lcms.cmsDoTransform(this.xfRgbDbl, new Float32Array([r, g, b]), 1);
    const clean = (x: number) => (snapSmall && x < 0.5 ? 0 : round1(x));
    return this.applyTac({ c: clean(o[0]), m: clean(o[1]), y: clean(o[2]), k: clean(o[3]) });
  }

  applyTac(c: CMYK): CMYK {
    const lim = this.settings.tacLimit;
    const tot = c.c + c.m + c.y + c.k;
    if (!lim || tot <= lim) return c;
    const cmy = c.c + c.m + c.y;
    const avail = Math.max(0, lim - c.k);
    const f = cmy > 0 ? avail / cmy : 0;
    return { c: round1(c.c * f), m: round1(c.m * f), y: round1(c.y * f), k: c.k };
  }

  /** Map an RGB colour from the PDF (0..1) to its final output form. */
  map(r: number, g: number, b: number): Mapped {
    const hex = toHex(r, g, b);
    this.usage.set(hex, (this.usage.get(hex) || 0) + 1);
    const hit = this.cache.get(hex);
    if (hit) return hit;
    const s = this.settings;
    const ov = s.overrides[hex];
    let res: Mapped;
    if (s.mode === 'rgb') {
      res = { kind: 'rgb', v: [r, g, b], overprint: false };
    } else if (s.mode === 'gray') {
      const L = this.rgbToLab(r, g, b)[0];
      res = { kind: 'gray', v: clamp01(L / 100), overprint: false };
    } else if (ov?.spot && this.keepSpot(ov.spot.name)) {
      res = { kind: 'spot', spot: ov.spot, overprint: !!ov.overprint };
    } else {
      let c: CMYK;
      if (ov?.spot) {
        // flattened spot: tint × alternate
        const t = ov.spot.tint / 100;
        c = { c: ov.spot.alt.c * t, m: ov.spot.alt.m * t, y: ov.spot.alt.y * t, k: ov.spot.alt.k * t };
      } else if (ov?.cmyk) c = ov.cmyk;
      else c = this.iccCmyk(r, g, b);
      const isPureK = c.c === 0 && c.m === 0 && c.y === 0 && c.k >= 99.5;
      const isWhite = c.c + c.m + c.y + c.k < 0.5;
      let op = ov?.overprint ?? (s.overprintBlack && isPureK);
      if (isWhite && s.removeWhiteOverprint) op = false;
      res = { kind: 'cmyk', v: [c.c / 100, c.m / 100, c.y / 100, c.k / 100], overprint: op };
    }
    this.cache.set(hex, res);
    return res;
  }

  keepSpot(name: string): boolean {
    const s = this.settings;
    if (s.forceSpots?.includes(name)) return true;
    if (s.spotPolicy === 'flatten') return false;
    if (s.spotPolicy === 'keepListed') return s.keepSpots.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase());
    return true;
  }

  /** Is this RGB pure black (candidate for rich black on large fills)? */
  isPureBlack(r: number, g: number, b: number) {
    return r <= 0.004 && g <= 0.004 && b <= 0.004;
  }

  /**
   * Convert interleaved 8-bit RGB pixels to CMYK (or gray). `iccSrc` is the
   * image's embedded ICC (ICCBased) if any.
   */
  convertPixels(rgb: Uint8Array, count: number, iccSrc?: Uint8Array, neutralToK = false): Uint8Array {
    const l = this.lcms;
    const s = this.settings;
    if (s.mode === 'gray') {
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        // Rec.709 luma on gamma-encoded values is a fine approximation for imagery
        out[i] = Math.round(0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2]);
      }
      return out;
    }
    let xf = this.xfRgb8;
    if (iccSrc) {
      const key = String(iccSrc.byteLength) + ':' + iccSrc[iccSrc.length - 1] + ':' + iccSrc[100];
      let x = this.srcXf8.get(key);
      if (!x) {
        const p = l.cmsOpenProfileFromMem(iccSrc, iccSrc.byteLength);
        if (p && l.cmsGetColorSpaceASCII(p).trim() === 'RGB') {
          const flags = (s.bpc ? cmsFLAGS_BLACKPOINTCOMPENSATION : 0) | cmsFLAGS_HIGHRESPRECALC;
          x = l.cmsCreateTransform(p, TYPE_RGB_8, this.outProfile, TYPE_CMYK_8, s.intent, flags);
        }
        x = x || this.xfRgb8;
        this.srcXf8.set(key, x);
      }
      xf = x;
    }
    if (!xf) {
      const out = new Uint8Array(count * 4);
      for (let i = 0; i < count; i++) {
        const c = naiveCmyk(rgb[i * 3] / 255, rgb[i * 3 + 1] / 255, rgb[i * 3 + 2] / 255);
        out[i * 4] = (c.c * 2.55) | 0;
        out[i * 4 + 1] = (c.m * 2.55) | 0;
        out[i * 4 + 2] = (c.y * 2.55) | 0;
        out[i * 4 + 3] = (c.k * 2.55) | 0;
      }
      return out;
    }
    // lcms buffers are bounded; process in chunks
    const out = new Uint8Array(count * 4);
    const CH = 1 << 18;
    for (let off = 0; off < count; off += CH) {
      const nPix = Math.min(CH, count - off);
      const res: Uint8Array = l.cmsDoTransform(xf, rgb.subarray(off * 3, (off + nPix) * 3), nPix);
      out.set(res, off * 4);
    }
    // whole-page renders (preview, TIFF/JPEG, flattened pages): keep black text and grey lines on the K plate,
    // exactly like the vector conversion does
    if (neutralToK && (s.pureBlackToK || s.grayToK)) {
      const lut = this.kLut();
      for (let i = 0; i < count; i++) {
        const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
        if (r !== g || g !== b) continue;
        if (r === 0 ? s.pureBlackToK || s.grayToK : s.grayToK) {
          out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 0;
          out[i * 4 + 3] = r === 0 && s.pureBlackToK ? 255 : lut[r];
        }
      }
    }
    // TAC limit on pixels
    const lim = s.tacLimit ? (s.tacLimit / 100) * 255 : 0;
    if (lim) {
      for (let i = 0; i < out.length; i += 4) {
        const tot = out[i] + out[i + 1] + out[i + 2] + out[i + 3];
        if (tot > lim) {
          const cmy = out[i] + out[i + 1] + out[i + 2];
          const f = cmy > 0 ? Math.max(0, lim - out[i + 3]) / cmy : 0;
          out[i] = out[i] * f;
          out[i + 1] = out[i + 1] * f;
          out[i + 2] = out[i + 2] * f;
        }
      }
    }
    return out;
  }
}

export function naiveCmyk(r: number, g: number, b: number): CMYK {
  const k = 1 - Math.max(r, g, b);
  if (k >= 0.999) return { c: 0, m: 0, y: 0, k: 100 };
  const d = 1 - k;
  return { c: round1(((1 - r - k) / d) * 100), m: round1(((1 - g - k) / d) * 100), y: round1(((1 - b - k) / d) * 100), k: round1(k * 100) };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round1 = (x: number) => Math.round(Math.max(0, Math.min(100, x)) * 10) / 10;
function interp(curve: number[], L: number) {
  const x = Math.max(0, Math.min(100, L));
  const i = Math.floor(x);
  const t = x - i;
  return i >= 100 ? curve[100] : curve[i] * (1 - t) + curve[i + 1] * t;
}

export const tac = (c: CMYK) => c.c + c.m + c.y + c.k;
