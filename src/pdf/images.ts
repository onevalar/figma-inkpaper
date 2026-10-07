// Raster helpers: decode PDF image XObjects to 8-bit interleaved pixels, resample, re-encode.

import { PDFArray, PDFContext, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { decodeStream, getNum } from './streams';

export interface Raster {
  w: number;
  h: number;
  comps: number;
  data: Uint8Array; // 8 bits per component, interleaved
}

/**
 * JPEG decoding is environment specific (browser: native decoder via canvas; tests: external tool),
 * so it is injected. Must return 8-bit interleaved pixels with the JPEG's own component count.
 */
export type JpegDecoder = (jpeg: Uint8Array, expectComps: number) => Promise<Raster | null>;
let jpegDecoder: JpegDecoder | null = null;
export function setJpegDecoder(d: JpegDecoder) {
  jpegDecoder = d;
}

/** PNG decoding (browser: native decoder; tests: external tool). Returns RGBA, 8 bits. */
export type PngDecoder = (png: Uint8Array) => Promise<Raster>;
let pngDecoder: PngDecoder | null = null;
export function setPngDecoder(d: PngDecoder) {
  pngDecoder = d;
}
export function decodePng(bytes: Uint8Array): Promise<Raster> {
  if (!pngDecoder) throw new Error('PNG decoder not set');
  return pngDecoder(bytes);
}

/** Composite RGBA over white → RGB. */
export function flattenOnWhite(r: Raster): Raster {
  if (r.comps !== 4) return r;
  const n = r.w * r.h;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = r.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(r.data[i * 4 + c] * a + 255 * (1 - a));
  }
  return { w: r.w, h: r.h, comps: 3, data: out };
}

/** Decode an image stream into 8-bit pixels. Returns null if the codec is unsupported (JPX, JBIG2, CCITT). */
export async function decodeImage(ctx: PDFContext, stream: PDFRawStream, expectComps: number): Promise<Raster | null> {
  const d = stream.dict;
  const w = getNum(ctx, d, 'Width');
  const h = getNum(ctx, d, 'Height');
  const bpc = getNum(ctx, d, 'BitsPerComponent', 8);
  const data = decodeStream(ctx, stream);
  if (data.remaining) {
    if (data.remaining !== 'DCTDecode' && data.remaining !== 'DCT') return null;
    if (!jpegDecoder) return null;
    return jpegDecoder(data, expectComps);
  }
  if (bpc === 8) return { w, h, comps: expectComps, data: data.subarray(0, w * h * expectComps) };
  if (bpc === 16) {
    const out = new Uint8Array(w * h * expectComps);
    for (let i = 0; i < out.length; i++) out[i] = data[i * 2];
    return { w, h, comps: expectComps, data: out };
  }
  if (bpc < 8) {
    // unpack sub-byte samples, rows padded to byte boundary
    const out = new Uint8Array(w * h * expectComps);
    const rowBits = w * expectComps * bpc;
    const rowBytes = Math.ceil(rowBits / 8);
    const maxv = (1 << bpc) - 1;
    for (let y = 0; y < h; y++) {
      for (let i = 0; i < w * expectComps; i++) {
        const bit = y * rowBytes * 8 + i * bpc;
        const byte = data[bit >> 3];
        const v = (byte >> (8 - bpc - (bit & 7))) & maxv;
        out[y * w * expectComps + i] = Math.round((v * 255) / maxv);
      }
    }
    return { w, h, comps: expectComps, data: out };
  }
  return null;
}

/** Area-average downsample to (nw, nh). */
export function resample(r: Raster, nw: number, nh: number): Raster {
  if (nw >= r.w && nh >= r.h) return r;
  const out = new Uint8Array(nw * nh * r.comps);
  const sx = r.w / nw;
  const sy = r.h / nh;
  const acc = new Float64Array(r.comps);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      acc.fill(0);
      let n = 0;
      for (let yy = y0; yy < y1 && yy < r.h; yy++) {
        for (let xx = x0; xx < x1 && xx < r.w; xx++) {
          const o = (yy * r.w + xx) * r.comps;
          for (let c = 0; c < r.comps; c++) acc[c] += r.data[o + c];
          n++;
        }
      }
      const o = (y * nw + x) * r.comps;
      for (let c = 0; c < r.comps; c++) out[o + c] = Math.round(acc[c] / Math.max(1, n));
    }
  }
  return { w: nw, h: nh, comps: r.comps, data: out };
}

export function imageColorSpaceName(ctx: PDFContext, stream: PDFRawStream): string {
  const cs = ctx.lookup(stream.dict.get(PDFName.of('ColorSpace')));
  if (cs instanceof PDFName) return cs.asString().slice(1);
  if (cs instanceof PDFArray) return (ctx.lookup(cs.get(0)) as PDFName).asString().slice(1);
  return '';
}

export const pdfNum = (ctx: PDFContext, o: any) => (ctx.lookup(o) as PDFNumber).asNumber();
