// Stream decoding helpers (Flate + PNG/TIFF predictors, ASCIIHex, ASCII85, LZW, RunLength).
// DCT (JPEG) is handled separately in images.ts.

import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFObject, PDFRawStream } from 'pdf-lib';
import * as pako from 'pako';

export function filtersOf(ctx: PDFContext, dict: PDFDict): { names: string[]; parms: (PDFDict | undefined)[] } {
  const f = ctx.lookup(dict.get(PDFName.of('Filter')));
  const p = ctx.lookup(dict.get(PDFName.of('DecodeParms')));
  const names: string[] = [];
  const parms: (PDFDict | undefined)[] = [];
  if (f instanceof PDFName) {
    names.push(f.asString().slice(1));
    parms.push(p instanceof PDFDict ? p : undefined);
  } else if (f instanceof PDFArray) {
    f.asArray().forEach((x, i) => {
      names.push((ctx.lookup(x) as PDFName).asString().slice(1));
      const pp = p instanceof PDFArray ? ctx.lookup(p.get(i)) : undefined;
      parms.push(pp instanceof PDFDict ? pp : undefined);
    });
  }
  return { names, parms };
}

const numOf = (ctx: PDFContext, d: PDFDict | undefined, key: string, def: number) => {
  const v = d ? ctx.lookup(d.get(PDFName.of(key))) : undefined;
  return v instanceof PDFNumber ? v.asNumber() : def;
};

/**
 * Decode a stream fully, except that a trailing DCTDecode/JPX filter is left in place
 * (returned data is then still JPEG). `stopAt` reports which filter remained.
 */
export function decodeStream(
  ctx: PDFContext,
  stream: PDFRawStream,
  opts: { keepImageFilters?: boolean } = {},
): Uint8Array & { remaining?: string } {
  const { names, parms } = filtersOf(ctx, stream.dict);
  let data: Uint8Array = stream.contents;
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (n === 'FlateDecode' || n === 'Fl') {
      data = inflateLenient(data);
      data = applyPredictor(ctx, data, parms[i]);
    } else if (n === 'ASCIIHexDecode' || n === 'AHx') data = asciiHex(data);
    else if (n === 'ASCII85Decode' || n === 'A85') data = ascii85(data);
    else if (n === 'LZWDecode' || n === 'LZW') {
      data = lzw(data, numOf(ctx, parms[i], 'EarlyChange', 1));
      data = applyPredictor(ctx, data, parms[i]);
    } else if (n === 'RunLengthDecode' || n === 'RL') data = runLength(data);
    else {
      // image codecs (DCT, JPX, JBIG2, CCITT) — leave
      const out = data as Uint8Array & { remaining?: string };
      out.remaining = n;
      return out;
    }
  }
  return data;
}

function inflateLenient(d: Uint8Array): Uint8Array {
  try {
    return pako.inflate(d);
  } catch {
    // tolerate truncated streams
    const inf = new pako.Inflate();
    inf.push(d, false);
    return (inf.result as Uint8Array) || new Uint8Array(0);
  }
}

function applyPredictor(ctx: PDFContext, data: Uint8Array, parms?: PDFDict): Uint8Array {
  const pred = numOf(ctx, parms, 'Predictor', 1);
  if (pred <= 1) return data;
  const colors = numOf(ctx, parms, 'Colors', 1);
  const bpc = numOf(ctx, parms, 'BitsPerComponent', 8);
  const columns = numOf(ctx, parms, 'Columns', 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (pred === 2) {
    // TIFF predictor (8-bit only)
    const out = new Uint8Array(data);
    if (bpc === 8)
      for (let r = 0; r * rowLen < out.length; r++)
        for (let i = bpp; i < rowLen; i++) out[r * rowLen + i] = (out[r * rowLen + i] + out[r * rowLen + i - bpp]) & 0xff;
    return out;
  }
  // PNG predictors
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  const prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const dst = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? dst[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      dst[i] = v & 0xff;
    }
    prev.set(dst);
  }
  return out;
}

function asciiHex(d: Uint8Array): Uint8Array {
  const s = String.fromCharCode(...Array.from(d)).replace(/[^0-9a-fA-F>]/g, '');
  const end = s.indexOf('>');
  let h = end >= 0 ? s.slice(0, end) : s;
  if (h.length % 2) h += '0';
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function ascii85(d: Uint8Array): Uint8Array {
  const out: number[] = [];
  let tuple: number[] = [];
  for (let i = 0; i < d.length; i++) {
    const c = d[i];
    if (c === 0x7e) break; // ~>
    if (c <= 0x20) continue;
    if (c === 0x7a && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    tuple.push(c - 33);
    if (tuple.length === 5) {
      let v = 0;
      for (const t of tuple) v = v * 85 + t;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      tuple = [];
    }
  }
  if (tuple.length) {
    const n = tuple.length;
    while (tuple.length < 5) tuple.push(84);
    let v = 0;
    for (const t of tuple) v = v * 85 + t;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return new Uint8Array(out);
}

function lzw(d: Uint8Array, early: number): Uint8Array {
  const out: number[] = [];
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([], []);
  };
  reset();
  let bits = 9;
  let buf = 0;
  let nb = 0;
  let prev: number[] | null = null;
  for (let i = 0; i < d.length; i++) {
    buf = (buf << 8) | d[i];
    nb += 8;
    while (nb >= bits) {
      const code = (buf >> (nb - bits)) & ((1 << bits) - 1);
      nb -= bits;
      if (code === 256) {
        reset();
        bits = 9;
        prev = null;
        continue;
      }
      if (code === 257) return new Uint8Array(out);
      let entry: number[];
      if (code < dict.length && dict[code].length) entry = dict[code];
      else if (prev) entry = [...prev, prev[0]];
      else break;
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length + early >= 1 << bits && bits < 12) bits++;
    }
  }
  return new Uint8Array(out);
}

function runLength(d: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < d.length) {
    const len = d[i++];
    if (len === 128) break;
    if (len < 128) {
      for (let k = 0; k <= len; k++) out.push(d[i++]);
    } else {
      const v = d[i++];
      for (let k = 0; k < 257 - len; k++) out.push(v);
    }
  }
  return new Uint8Array(out);
}

export function getNum(ctx: PDFContext, d: PDFDict, key: string, def = 0): number {
  const v = ctx.lookup(d.get(PDFName.of(key)));
  return v instanceof PDFNumber ? v.asNumber() : def;
}

export function lookupDict(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  if (!o) return undefined;
  const v = ctx.lookup(o);
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFRawStream) return v.dict;
  return undefined;
}
