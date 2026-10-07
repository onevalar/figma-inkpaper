// Whole-page soft proof: simulated print, split compare, single plates, ink-limit heatmap, out-of-gamut overlay.

import type { ColorEngine } from '../pdf/color';
import { applyExactOverrides } from '../pdf/raster';

export type PreviewMode = 'original' | 'proof' | 'split' | 'c' | 'm' | 'y' | 'k' | 'tac' | 'gamut';

export interface ProofData {
  w: number;
  h: number;
  rgb: Uint8Array; // original (flattened on white)
  cmyk: Uint8Array;
  proof: Uint8Array; // simulated print, sRGB
  stats: { tacMax: number; tacOver: number; gamutOut: number };
}

export async function decodeToRgb(png: Uint8Array): Promise<{ w: number; h: number; rgb: Uint8Array }> {
  const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' } as any);
  const cv = document.createElement('canvas');
  cv.width = bmp.width;
  cv.height = bmp.height;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, bmp.width, bmp.height);
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
  const n = bmp.width * bmp.height;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = d[i * 4];
    rgb[i * 3 + 1] = d[i * 4 + 1];
    rgb[i * 3 + 2] = d[i * 4 + 2];
  }
  return { w: bmp.width, h: bmp.height, rgb };
}

export function buildProof(src: { w: number; h: number; rgb: Uint8Array }, eng: ColorEngine, paper: boolean, tacLimit: number): ProofData {
  const n = src.w * src.h;
  const cmyk = eng.convertPixels(src.rgb, n, undefined, true);
  applyExactOverrides({ w: src.w, h: src.h, comps: 3, data: src.rgb }, cmyk, eng);
  const proof = eng.proofPixels(cmyk, n, paper);
  let tacMax = 0, tacOver = 0, gamutOut = 0;
  const lim = (tacLimit || 400) * 2.55;
  for (let i = 0; i < n; i++) {
    const t = cmyk[i * 4] + cmyk[i * 4 + 1] + cmyk[i * 4 + 2] + cmyk[i * 4 + 3];
    if (t > tacMax) tacMax = t;
    if (t > lim + 2) tacOver++;
  }
  const a = eng.rgbPixelsToLab(src.rgb, n);
  const b = eng.rgbPixelsToLab(proof, n);
  const de = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = src.rgb[i * 3], g = src.rgb[i * 3 + 1], bl = src.rgb[i * 3 + 2];
    const kOnly = cmyk[i * 4] === 0 && cmyk[i * 4 + 1] === 0 && cmyk[i * 4 + 2] === 0 && Math.abs(r - g) <= 1 && Math.abs(g - bl) <= 1;
    de[i] = kOnly ? 0 : Math.hypot(a[i * 3] - b[i * 3], a[i * 3 + 1] - b[i * 3 + 1], a[i * 3 + 2] - b[i * 3 + 2]);
    if (de[i] > 10) gamutOut++;
  }
  (proofDE as any).last = de;
  return { w: src.w, h: src.h, rgb: src.rgb, cmyk, proof, stats: { tacMax: Math.round(tacMax / 2.55), tacOver: tacOver / n, gamutOut: gamutOut / n } };
}
const proofDE: { last?: Float32Array } = {};

/** Paint a preview mode into a canvas. `split` is 0..1 (position of the compare divider). */
export function paint(cv: HTMLCanvasElement, p: ProofData, mode: PreviewMode, split: number, tacLimit: number) {
  cv.width = p.w;
  cv.height = p.h;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(p.w, p.h);
  const d = img.data;
  const n = p.w * p.h;
  const lim = (tacLimit || 400) * 2.55;
  const de = proofDE.last;
  const cut = Math.round(split * p.w);
  for (let i = 0; i < n; i++) {
    let r = 0, gg = 0, b = 0;
    const x = i % p.w;
    const useProof = mode === 'proof' || (mode === 'split' && x >= cut);
    if (mode === 'original' || (mode === 'split' && x < cut)) {
      r = p.rgb[i * 3]; gg = p.rgb[i * 3 + 1]; b = p.rgb[i * 3 + 2];
    } else if (useProof) {
      r = p.proof[i * 3]; gg = p.proof[i * 3 + 1]; b = p.proof[i * 3 + 2];
    } else if (mode === 'c' || mode === 'm' || mode === 'y' || mode === 'k') {
      // single plate shown as printed ink on white
      const v = p.cmyk[i * 4 + 'cmyk'.indexOf(mode)] / 255;
      const ink = { c: [0, 160, 233], m: [228, 0, 127], y: [255, 241, 0], k: [35, 31, 32] }[mode];
      r = 255 - (255 - ink[0]) * v; gg = 255 - (255 - ink[1]) * v; b = 255 - (255 - ink[2]) * v;
    } else if (mode === 'tac') {
      const t = p.cmyk[i * 4] + p.cmyk[i * 4 + 1] + p.cmyk[i * 4 + 2] + p.cmyk[i * 4 + 3];
      const gray = 255 - Math.min(255, t / 4);
      if (t > lim + 2) { r = 255; gg = 40; b = 40; } else { r = gg = b = gray; }
    } else if (mode === 'gamut') {
      const out = de && de[i] > 10;
      if (out) { r = 255; gg = 0; b = 200; } else { r = p.proof[i * 3]; gg = p.proof[i * 3 + 1]; b = p.proof[i * 3 + 2]; }
    }
    d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  if (mode === 'split') {
    g.fillStyle = '#0d99ff';
    g.fillRect(cut - 1, 0, 2, p.h);
  }
}
