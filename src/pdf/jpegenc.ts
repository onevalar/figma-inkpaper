// Baseline JPEG encoder for 1, 3 or 4 components (no colour transform, no subsampling).
// Used to keep CMYK photos small. 4-component output follows the Adobe convention
// (APP14 marker, inverted samples) and must be paired with /Decode [1 0 1 0 1 0 1 0] in the PDF.
// Structure follows the classic public-domain JPEG encoder by Andreas Ritter / jpeg-js.

const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53, 10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38,
  46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
];
const Y_QT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24,
  35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const DC_NRCODES = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_NRCODES = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1,
  0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74,
  0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5,
  0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

type HT = [number, number][]; // value → [code, length]

function computeHuffman(nrcodes: number[], values: number[]): HT {
  let code = 0;
  let pos = 0;
  const ht: HT = [];
  for (let k = 1; k <= 16; k++) {
    for (let j = 1; j <= nrcodes[k]; j++) {
      ht[values[pos]] = [code, k];
      pos++;
      code++;
    }
    code *= 2;
  }
  return ht;
}

const DC_HT = computeHuffman(DC_NRCODES, DC_VALUES);
const AC_HT = computeHuffman(AC_NRCODES, AC_VALUES);

// category / bitcode tables
const CAT = new Int32Array(65535);
const BITCODE: [number, number][] = new Array(65535);
(() => {
  let lo = 1,
    hi = 2;
  for (let cat = 1; cat <= 15; cat++) {
    for (let n = lo; n < hi; n++) {
      CAT[32767 + n] = cat;
      BITCODE[32767 + n] = [n, cat];
    }
    for (let n = -(hi - 1); n <= -lo; n++) {
      CAT[32767 + n] = cat;
      BITCODE[32767 + n] = [hi - 1 + n, cat];
    }
    lo <<= 1;
    hi <<= 1;
  }
})();

export interface JpegExtras {
  dpi?: number; // written to JFIF (gray / RGB) or Exif (CMYK)
  icc?: Uint8Array; // embedded as APP2 ICC_PROFILE segments
}

export function encodeJpeg(data: Uint8Array, w: number, h: number, comps: 1 | 3 | 4, quality = 90, extras: JpegExtras = {}): Uint8Array {
  quality = Math.max(1, Math.min(100, quality));
  const sf = quality < 50 ? Math.floor(5000 / quality) : Math.floor(200 - quality * 2);
  const qt = new Array(64);
  for (let i = 0; i < 64; i++) qt[ZIGZAG[i]] = Math.max(1, Math.min(255, Math.floor((Y_QT[i] * sf + 50) / 100)));
  const fdtbl = new Float64Array(64);
  for (let r = 0, k = 0; r < 8; r++) for (let c = 0; c < 8; c++, k++) fdtbl[k] = 1 / (qt[ZIGZAG[k]] * AAN[r] * AAN[c] * 8);

  // output buffer
  let out = new Uint8Array(Math.max(1024, (w * h * comps) >> 1));
  let pos = 0;
  const ensure = (n: number) => {
    if (pos + n > out.length) {
      const nb = new Uint8Array(Math.max(out.length * 2, pos + n));
      nb.set(out);
      out = nb;
    }
  };
  const byte = (b: number) => {
    ensure(1);
    out[pos++] = b & 0xff;
  };
  const word = (v: number) => {
    byte(v >> 8);
    byte(v);
  };
  let bytenew = 0;
  let bytepos = 7;
  const writeBits = (bs: [number, number]) => {
    const value = bs[0];
    let posval = bs[1] - 1;
    while (posval >= 0) {
      if (value & (1 << posval)) bytenew |= 1 << bytepos;
      posval--;
      bytepos--;
      if (bytepos < 0) {
        if (bytenew === 0xff) {
          byte(0xff);
          byte(0);
        } else byte(bytenew);
        bytepos = 7;
        bytenew = 0;
      }
    }
  };

  // headers
  word(0xffd8);
  if (comps === 4) {
    word(0xffee);
    word(14);
    for (const ch of 'Adobe') byte(ch.charCodeAt(0));
    word(100);
    word(0);
    word(0);
    byte(0); // transform 0 = no colour transform (CMYK)
    if (extras.dpi) {
      // minimal Exif with X/YResolution (inches)
      const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 3];
      const entry = (tag: number, type: number, count: number, val: number) => exif.push(tag >> 8, tag & 255, type >> 8, type & 255, 0, 0, 0, count, (val >>> 24) & 255, (val >> 16) & 255, (val >> 8) & 255, val & 255);
      const valOff = 8 + 2 + 3 * 12 + 4; // after IFD
      entry(0x011a, 5, 1, valOff);
      entry(0x011b, 5, 1, valOff + 8);
      exif.push(0x01, 0x28, 0, 3, 0, 0, 0, 1, 0, 2, 0, 0); // ResolutionUnit = inch
      exif.push(0, 0, 0, 0);
      for (let k = 0; k < 2; k++) exif.push((extras.dpi >>> 24) & 255, (extras.dpi >> 16) & 255, (extras.dpi >> 8) & 255, extras.dpi & 255, 0, 0, 0, 1);
      word(0xffe1);
      word(exif.length + 2);
      for (const b of exif) byte(b);
    }
  } else {
    const dpi = Math.round(extras.dpi || 72);
    word(0xffe0);
    word(16);
    for (const ch of 'JFIF') byte(ch.charCodeAt(0));
    byte(0);
    byte(1);
    byte(1);
    byte(extras.dpi ? 1 : 0); // density unit: dots per inch
    word(extras.dpi ? dpi : 1);
    word(extras.dpi ? dpi : 1);
    byte(0);
    byte(0);
  }
  if (extras.icc) {
    const CH = 65519;
    const n = Math.ceil(extras.icc.length / CH);
    for (let k = 0; k < n; k++) {
      const part = extras.icc.subarray(k * CH, (k + 1) * CH);
      word(0xffe2);
      word(2 + 12 + 2 + part.length);
      for (const ch of 'ICC_PROFILE') byte(ch.charCodeAt(0));
      byte(0);
      byte(k + 1);
      byte(n);
      ensure(part.length);
      out.set(part, pos);
      pos += part.length;
    }
  }
  word(0xffdb);
  word(67);
  byte(0);
  for (let i = 0; i < 64; i++) byte(qt[i]); // table is stored in zigzag order
  word(0xffc0);
  word(8 + comps * 3);
  byte(8);
  word(h);
  word(w);
  byte(comps);
  for (let c = 0; c < comps; c++) {
    byte(c + 1);
    byte(0x11);
    byte(0);
  }
  word(0xffc4);
  word(2 + 1 + 16 + DC_VALUES.length + 1 + 16 + AC_VALUES.length);
  byte(0x00);
  for (let i = 1; i <= 16; i++) byte(DC_NRCODES[i]);
  for (const v of DC_VALUES) byte(v);
  byte(0x10);
  for (let i = 1; i <= 16; i++) byte(AC_NRCODES[i]);
  for (const v of AC_VALUES) byte(v);
  word(0xffda);
  word(6 + comps * 2);
  byte(comps);
  for (let c = 0; c < comps; c++) {
    byte(c + 1);
    byte(0x00);
  }
  byte(0);
  byte(0x3f);
  byte(0);

  const blk = new Float64Array(64);
  const outQ = new Int32Array(64);
  const DU = new Int32Array(64);
  const prevDC = new Int32Array(comps);
  const EOB = AC_HT[0x00];
  const M16 = AC_HT[0xf0];
  const invert = comps === 4;

  const processDU = (c: number) => {
    // forward DCT (AAN), rows then columns
    for (let i = 0; i < 64; i += 8) {
      const d0 = blk[i], d1 = blk[i + 1], d2 = blk[i + 2], d3 = blk[i + 3], d4 = blk[i + 4], d5 = blk[i + 5], d6 = blk[i + 6], d7 = blk[i + 7];
      const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6, t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
      let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
      blk[i] = t10 + t11;
      blk[i + 4] = t10 - t11;
      const z1 = (t12 + t13) * 0.707106781;
      blk[i + 2] = t13 + z1;
      blk[i + 6] = t13 - z1;
      t10 = t4 + t5;
      t11 = t5 + t6;
      t12 = t6 + t7;
      const z5 = (t10 - t12) * 0.382683433, z2 = 0.5411961 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
      const z11 = t7 + z3, z13 = t7 - z3;
      blk[i + 5] = z13 + z2;
      blk[i + 3] = z13 - z2;
      blk[i + 1] = z11 + z4;
      blk[i + 7] = z11 - z4;
    }
    for (let i = 0; i < 8; i++) {
      const d0 = blk[i], d1 = blk[i + 8], d2 = blk[i + 16], d3 = blk[i + 24], d4 = blk[i + 32], d5 = blk[i + 40], d6 = blk[i + 48], d7 = blk[i + 56];
      const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6, t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
      let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
      blk[i] = t10 + t11;
      blk[i + 32] = t10 - t11;
      const z1 = (t12 + t13) * 0.707106781;
      blk[i + 16] = t13 + z1;
      blk[i + 48] = t13 - z1;
      t10 = t4 + t5;
      t11 = t5 + t6;
      t12 = t6 + t7;
      const z5 = (t10 - t12) * 0.382683433, z2 = 0.5411961 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
      const z11 = t7 + z3, z13 = t7 - z3;
      blk[i + 40] = z13 + z2;
      blk[i + 24] = z13 - z2;
      blk[i + 8] = z11 + z4;
      blk[i + 56] = z11 - z4;
    }
    for (let i = 0; i < 64; i++) {
      const v = blk[i] * fdtbl[i];
      outQ[i] = v > 0 ? (v + 0.5) | 0 : (v - 0.5) | 0;
    }
    for (let j = 0; j < 64; j++) DU[ZIGZAG[j]] = outQ[j];
    const diff = DU[0] - prevDC[c];
    prevDC[c] = DU[0];
    if (diff === 0) writeBits(DC_HT[0]);
    else {
      const p = 32767 + diff;
      writeBits(DC_HT[CAT[p]]);
      writeBits(BITCODE[p]);
    }
    let end0pos = 63;
    while (end0pos > 0 && DU[end0pos] === 0) end0pos--;
    if (end0pos === 0) {
      writeBits(EOB);
      return;
    }
    let i = 1;
    while (i <= end0pos) {
      const start = i;
      while (DU[i] === 0 && i <= end0pos) i++;
      let nrzeroes = i - start;
      if (nrzeroes >= 16) {
        const lng = nrzeroes >> 4;
        for (let n = 1; n <= lng; n++) writeBits(M16);
        nrzeroes &= 0xf;
      }
      const p = 32767 + DU[i];
      writeBits(AC_HT[(nrzeroes << 4) + CAT[p]]);
      writeBits(BITCODE[p]);
      i++;
    }
    if (end0pos !== 63) writeBits(EOB);
  };

  for (let y = 0; y < h; y += 8) {
    for (let x = 0; x < w; x += 8) {
      for (let c = 0; c < comps; c++) {
        for (let k = 0; k < 64; k++) {
          const yy = Math.min(h - 1, y + (k >> 3));
          const xx = Math.min(w - 1, x + (k & 7));
          const o = (yy * w + xx) * comps;
          let v: number;
          if (comps === 3) {
            // JFIF expects YCbCr
            const R = data[o], G = data[o + 1], B = data[o + 2];
            v = c === 0 ? 0.299 * R + 0.587 * G + 0.114 * B : c === 1 ? -0.168736 * R - 0.331264 * G + 0.5 * B + 128 : 0.5 * R - 0.418688 * G - 0.081312 * B + 128;
          } else v = data[o + c];
          if (invert) v = 255 - v;
          blk[k] = v - 128;
        }
        processDU(c);
      }
    }
  }
  // flush
  if (bytepos >= 0) writeBits([(1 << (bytepos + 1)) - 1, bytepos + 1]);
  word(0xffd9);
  return out.subarray(0, pos);
}
