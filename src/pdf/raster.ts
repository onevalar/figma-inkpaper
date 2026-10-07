// Raster print output: CMYK / RGB / gray TIFF (Deflate, ICC + DPI tags), CMYK / RGB JPEG, PNG with DPI.

import * as pako from 'pako';
import { ColorEngine, CMYK } from './color';
import { decodePng, flattenOnWhite, Raster } from './images';
import { encodeJpeg } from './jpegenc';

export interface RasterOptions {
  format: 'tiff' | 'jpeg' | 'png';
  dpi: number;
  quality: number; // JPEG
}

/** Convert a Figma PNG render into a print raster file. */
export async function rasterExport(png: Uint8Array, eng: ColorEngine, profile: Uint8Array | null, o: RasterOptions): Promise<Uint8Array> {
  const mode = eng.settings.mode;
  if (o.format === 'png') return pngWithDpi(png, o.dpi); // PNG is RGB by definition
  const rgb = flattenOnWhite(await decodePng(png));
  let px: Uint8Array;
  let comps: 1 | 3 | 4;
  if (mode === 'cmyk') {
    px = eng.convertPixels(rgb.data, rgb.w * rgb.h, undefined, true);
    applyExactOverrides(rgb, px, eng);
    comps = 4;
  } else if (mode === 'gray') {
    px = eng.convertPixels(rgb.data, rgb.w * rgb.h);
    comps = 1;
  } else {
    px = rgb.data;
    comps = 3;
  }
  const icc = mode === 'cmyk' ? profile || undefined : undefined;
  if (o.format === 'jpeg') return encodeJpeg(px, rgb.w, rgb.h, comps, o.quality, { dpi: o.dpi, icc });
  return encodeTiff(px, rgb.w, rgb.h, comps, o.dpi, icc);
}

/** Flat brand colours that the user mapped by hand get their exact CMYK recipe in raster output too. */
export function applyExactOverrides(rgb: Raster, cmyk: Uint8Array, eng: ColorEngine) {
  const map = new Map<number, number[]>();
  for (const [hex, ov] of Object.entries(eng.settings.overrides)) {
    const c: CMYK | undefined = ov.cmyk || (ov.spot ? { c: ov.spot.alt.c * ov.spot.tint / 100, m: ov.spot.alt.m * ov.spot.tint / 100, y: ov.spot.alt.y * ov.spot.tint / 100, k: ov.spot.alt.k * ov.spot.tint / 100 } : undefined);
    if (c) map.set(parseInt(hex.slice(1), 16), [c.c, c.m, c.y, c.k].map((v) => Math.round(v * 2.55)));
  }
  if (!map.size) return;
  const n = rgb.w * rgb.h;
  for (let i = 0; i < n; i++) {
    const key = (rgb.data[i * 3] << 16) | (rgb.data[i * 3 + 1] << 8) | rgb.data[i * 3 + 2];
    const v = map.get(key);
    if (v) cmyk.set(v, i * 4);
  }
}

export function encodeTiff(px: Uint8Array, w: number, h: number, comps: 1 | 3 | 4, dpi: number, icc?: Uint8Array): Uint8Array {
  const data = pako.deflate(px.subarray(0, w * h * comps));
  type Entry = [number, number, number, number[] | Uint8Array]; // tag, type, count, values
  const SHORT = 3, LONG = 4, RATIONAL = 5, UNDEF = 7, ASCII = 2;
  const sw = new TextEncoder().encode('PressKit for Figma\0');
  const entries: Entry[] = [
    [256, LONG, 1, [w]],
    [257, LONG, 1, [h]],
    [258, SHORT, comps, new Array(comps).fill(8)],
    [259, SHORT, 1, [8]], // Adobe Deflate
    [262, SHORT, 1, [comps === 4 ? 5 : comps === 3 ? 2 : 1]],
    [273, LONG, 1, [0]], // strip offset (patched)
    [277, SHORT, 1, [comps]],
    [278, LONG, 1, [h]],
    [279, LONG, 1, [data.length]],
    [282, RATIONAL, 1, [Math.round(dpi), 1]],
    [283, RATIONAL, 1, [Math.round(dpi), 1]],
    [284, SHORT, 1, [1]],
    [296, SHORT, 1, [2]],
    [305, ASCII, sw.length, sw],
  ];
  if (comps === 4) entries.push([332, SHORT, 1, [1]]); // InkSet = CMYK
  if (icc) entries.push([34675, UNDEF, icc.length, icc]);
  entries.sort((a, b) => a[0] - b[0]);
  const size = (t: number) => (t === SHORT ? 2 : t === LONG ? 4 : t === RATIONAL ? 8 : 1);
  const ifdSize = 2 + entries.length * 12 + 4;
  let extraLen = 0;
  for (const e of entries) {
    const len = size(e[1]) * (e[1] === RATIONAL ? 1 : e[2]);
    if (len > 4) extraLen += len + (len & 1);
  }
  const ifdOff = 8;
  let extraOff = ifdOff + ifdSize;
  const dataOff = extraOff + extraLen;
  const buf = new Uint8Array(dataOff + data.length);
  const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0]);
  dv.setUint32(4, ifdOff, true);
  dv.setUint16(ifdOff, entries.length, true);
  entries.forEach((e, i) => {
    const [tag, type, count, vals] = e;
    const at = ifdOff + 2 + i * 12;
    dv.setUint16(at, tag, true);
    dv.setUint16(at + 2, type, true);
    dv.setUint32(at + 4, count, true);
    if (tag === 273) (vals as number[])[0] = dataOff;
    const len = size(type) * (type === RATIONAL ? 1 : count);
    const target = len > 4 ? extraOff : at + 8;
    if (len > 4) {
      dv.setUint32(at + 8, extraOff, true);
      extraOff += len + (len & 1);
    }
    if (vals instanceof Uint8Array) buf.set(vals, target);
    else if (type === SHORT) vals.forEach((v, k) => dv.setUint16(target + k * 2, v, true));
    else if (type === LONG) vals.forEach((v, k) => dv.setUint32(target + k * 4, v, true));
    else if (type === RATIONAL) {
      dv.setUint32(target, vals[0], true);
      dv.setUint32(target + 4, vals[1], true);
    }
  });
  buf.set(data, dataOff);
  return buf;
}

/** Insert / replace a pHYs chunk so the PNG opens at the intended print size. */
export function pngWithDpi(png: Uint8Array, dpi: number): Uint8Array {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // pHYs
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1;
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  // walk chunks, drop an existing pHYs, insert ours before the first IDAT
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let p = 8;
  let inserted = false;
  const pv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (p < png.length) {
    const len = pv.getUint32(p);
    const type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    const whole = png.subarray(p, p + 12 + len);
    if (type === 'IDAT' && !inserted) {
      parts.push(chunk);
      inserted = true;
    }
    if (type !== 'pHYs') parts.push(whole);
    p += 12 + len;
  }
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
