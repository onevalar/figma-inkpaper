// Swatch library import: Adobe Swatch Exchange (.ase) and simple CSV (name,c,m,y,k).
// Lets users bring their own licensed Pantone / RAL / HKS books instead of the plugin shipping them.

import type { CMYK } from '../pdf/color';

export interface LibSwatch {
  name: string;
  cmyk?: CMYK; // 0..100
  hex?: string; // display colour when the swatch is RGB / Lab
  spot: boolean;
}

export function parseAse(buf: ArrayBuffer): LibSwatch[] {
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'ASEF') throw new Error('不是 .ase 色板文件');
  const count = dv.getUint32(8);
  let p = 12;
  const out: LibSwatch[] = [];
  for (let i = 0; i < count && p < buf.byteLength; i++) {
    const type = dv.getUint16(p);
    const len = dv.getUint32(p + 2);
    const start = p + 6;
    if (type === 0x0001) {
      const nlen = dv.getUint16(start);
      let name = '';
      for (let k = 0; k < nlen - 1; k++) name += String.fromCharCode(dv.getUint16(start + 2 + k * 2));
      let q = start + 2 + nlen * 2;
      const model = String.fromCharCode(dv.getUint8(q), dv.getUint8(q + 1), dv.getUint8(q + 2), dv.getUint8(q + 3)).trim();
      q += 4;
      const f = (k: number) => dv.getFloat32(q + k * 4);
      const n = model === 'CMYK' ? 4 : model === 'Gray' ? 1 : 3;
      const ctype = dv.getUint16(q + n * 4);
      const sw: LibSwatch = { name, spot: ctype === 1 };
      if (model === 'CMYK') sw.cmyk = { c: f(0) * 100, m: f(1) * 100, y: f(2) * 100, k: f(3) * 100 };
      else if (model === 'RGB') sw.hex = toHex(f(0), f(1), f(2));
      else if (model === 'Gray') sw.cmyk = { c: 0, m: 0, y: 0, k: (1 - f(0)) * 100 };
      else if (model === 'LAB') sw.hex = labToHex(f(0) * 100, f(1), f(2));
      out.push(sw);
    }
    p = start + len;
  }
  return out;
}

export function parseSwatchCsv(text: string): LibSwatch[] {
  const out: LibSwatch[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split(/[,\t;]/).map((s) => s.trim());
    if (cols.length < 5 || isNaN(+cols[1])) continue;
    out.push({ name: cols[0], cmyk: { c: +cols[1], m: +cols[2], y: +cols[3], k: +cols[4] }, spot: true });
  }
  return out;
}

const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0')).join('').toUpperCase();

function labToHex(L: number, a: number, b: number) {
  // D50 Lab → XYZ → sRGB (Bradford-adapted to D65, approximate)
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = 0.9642 * inv(fx), Y = inv(fy), Z = 0.8249 * inv(fz);
  const r = 3.1339 * X - 1.6169 * Y - 0.4906 * Z;
  const g = -0.9785 * X + 1.9160 * Y + 0.0334 * Z;
  const bb = 0.0720 * X - 0.2290 * Y + 1.4057 * Z;
  const gam = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
  return toHex(gam(r), gam(g), gam(bb));
}
