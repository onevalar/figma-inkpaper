// PressKit UI (runs in the plugin iframe). Holds settings, runs the colour engine and the PDF pipeline.

import { ColorEngine, ColorOverride, ColorSettings, CMYK, loadLcms, tac } from '../pdf/color';
import { runExport, setJpegDecoder, setPngDecoder, rasterExport, ExportResult, Imposition, uniform } from '../pdf/pipeline';
import {
  MM,
  PAPER_PRESETS,
  SHEET_PRESETS,
  UNIT_TO_MM,
  Unit,
  FrameInfo,
  Issue,
  ScannedColor,
  TextNodeInfo,
  ImageInfoNode,
  ExportedFrame,
  DIELINE_KEYWORDS,
  Sides,
} from '../shared';
import { zip } from './zip';
import { parseAse, parseSwatchCsv, LibSwatch } from './ase';
import { decodeToRgb, buildProof, paint, PreviewMode, ProofData } from './preview';
import { tr, translateDom, setLang, detectLang, LANGS, missing, getLang, Lang } from '../i18n/i18n';

declare const __LCMS_WASM_B64__: string;

// ---------------- settings ----------------

type Format = 'pdf' | 'tiff' | 'jpeg' | 'png';
type ImpKind = 'none' | 'spreads' | 'booklet' | 'nup' | 'duplex';

interface Settings {
  lang: Lang | '';
  unit: Unit;
  mode: 'cmyk' | 'rgb' | 'gray';
  iccId: string;
  intent: 0 | 1 | 2 | 3;
  bpc: boolean;
  pureBlackToK: boolean;
  grayToK: boolean;
  richBlackOn: boolean;
  richPreset: string;
  richBlack: CMYK;
  tacLimit: number;
  overrides: Record<string, ColorOverride>;
  colorFinishing: Record<string, string>; // HEX → finishing spot (cut / fold / varnish …)
  activeMap: string;
  mapsInFile: boolean;
  spotPolicy: 'preserve' | 'flatten' | 'keepListed';
  keepSpots: string;
  overprintBlack: boolean;
  removeWhiteOverprint: boolean;
  minStrokeOn: boolean;
  minStrokePt: number;
  bleedMm: number;
  bleedSidesOn: boolean;
  bleedSides: Sides;
  cropMarks: boolean;
  regMarks: boolean;
  colorBars: boolean;
  trimLine: boolean;
  markWeight: number;
  format: Format;
  rasterDpi: number;
  pdfx: 'none' | 'x4' | 'x3' | 'x1a';
  flattenDpi: number;
  output: 'merged' | 'separate';
  maxPpi: number;
  minPpi: number;
  blockLowPpi: boolean;
  minTextPt: number;
  autoBleed: boolean;
  keepLinks: boolean;
  bookmarks: boolean;
  author: string;
  subject: string;
  keywords: string;
  textOutline: 'perNode' | 'all' | 'none';
  dielineMode: 'off' | 'auto' | 'manual';
  dielineNames: string;
  dielineFile: 'inline' | 'separate' | 'both';
  alsoDigital: boolean;
  title: string;
  compression: 'light' | 'balanced' | 'strong' | 'custom';
  imageCompression: 'auto' | 'jpeg' | 'lossless';
  jpegQuality: number;
  scalePct: number;
  imp: { kind: ImpKind; rtl: boolean; sheet: string; sheetW: number; sheetH: number; rows: number; cols: number; gutter: number; copies: number; repeat: boolean };
  customPapers: { name: string; w: number; h: number }[];
  doc: { preset: string; w: number; h: number; landscape: boolean; bleed: number; sidesOn: boolean; sides: Sides; margin: number; safety: number; pages: number; facing: boolean; fold: 'none' | 'half' | 'tri' | 'z' | 'gate'; name: string; scale: number };
  label: { hex: boolean; rgb: boolean; cmyk: boolean; spot: boolean; names: boolean };
  pageNum: { format: string; start: number; skip: number; create: boolean; position: 'center' | 'outer' };
  box: { style: 'ste' | 'tray' | 'mailer'; w: number; d: number; h: number };
  pick: CMYK;
}

const RICH_PRESETS: Record<string, [string, CMYK]> = {
  rich: ['标准四色黑 60/40/40/100', { c: 60, m: 40, y: 40, k: 100 }],
  cool: ['冷黑 60/0/0/100', { c: 60, m: 0, y: 0, k: 100 }],
  warm: ['暖黑 0/60/30/100', { c: 0, m: 60, y: 30, k: 100 }],
  designer: ['设计师黑 50/50/50/100', { c: 50, m: 50, y: 50, k: 100 }],
  deep: ['深黑 75/68/67/90', { c: 75, m: 68, y: 67, k: 90 }],
};

const DEFAULTS: Settings = {
  lang: '',
  unit: 'mm',
  mode: 'cmyk',
  iccId: '',
  intent: 1,
  bpc: true,
  pureBlackToK: true,
  grayToK: true,
  richBlackOn: false,
  richPreset: 'rich',
  richBlack: { c: 60, m: 40, y: 40, k: 100 },
  tacLimit: 320,
  overrides: {},
  colorFinishing: {},
  activeMap: '',
  mapsInFile: false,
  spotPolicy: 'preserve',
  keepSpots: '',
  overprintBlack: true,
  removeWhiteOverprint: true,
  minStrokeOn: true,
  minStrokePt: 0.25,
  bleedMm: 3,
  bleedSidesOn: false,
  bleedSides: { t: 3, r: 3, b: 3, l: 3 },
  cropMarks: true,
  regMarks: false,
  colorBars: false,
  trimLine: false,
  markWeight: 0.25,
  format: 'pdf',
  rasterDpi: 300,
  pdfx: 'x4',
  flattenDpi: 300,
  output: 'merged',
  maxPpi: 450,
  minPpi: 250,
  blockLowPpi: false,
  minTextPt: 6,
  autoBleed: true,
  keepLinks: true,
  bookmarks: true,
  author: '',
  subject: '',
  keywords: '',
  textOutline: 'perNode',
  dielineMode: 'off',
  dielineNames: '',
  dielineFile: 'inline',
  alsoDigital: false,
  title: '',
  compression: 'balanced',
  imageCompression: 'auto',
  jpegQuality: 92,
  scalePct: 100,
  imp: { kind: 'none', rtl: false, sheet: 'a3', sheetW: 297, sheetH: 420, rows: 0, cols: 0, gutter: 6, copies: 1, repeat: true },
  customPapers: [],
  doc: { preset: 'a4', w: 210, h: 297, landscape: false, bleed: 3, sidesOn: false, sides: { t: 3, r: 3, b: 3, l: 3 }, margin: 10, safety: 3, pages: 1, facing: false, fold: 'none', name: '印刷文档', scale: 1 },
  label: { hex: true, rgb: true, cmyk: true, spot: true, names: true },
  pageNum: { format: '{n}', start: 1, skip: 0, create: true, position: 'outer' },
  box: { style: 'ste', w: 80, d: 40, h: 120 },
  pick: { c: 0, m: 100, y: 100, k: 0 },
};

const COMPRESSION: Record<string, { q: number; maxPpi: number; mode: Settings['imageCompression'] }> = {
  light: { q: 95, maxPpi: 600, mode: 'auto' },
  balanced: { q: 90, maxPpi: 450, mode: 'auto' },
  strong: { q: 80, maxPpi: 300, mode: 'jpeg' },
};

interface Profile {
  id: string;
  name: string;
  size: number;
}
interface ColorMap {
  name: string;
  overrides: Record<string, ColorOverride>;
  finishing?: Record<string, string>;
}
interface ExportPreset {
  name: string;
  settings: Partial<Settings>;
}
interface Measure {
  id: string;
  name: string;
  type: string;
  w: number;
  h: number;
  fontSize?: number;
  strokeWeight?: number;
  cornerRadius?: number;
  hasImage?: boolean;
}

type Tab = 'doc' | 'color' | 'preview' | 'text' | 'preflight' | 'pack' | 'tools' | 'export';
const TABS: [Tab, string][] = [
  ['doc', '文档'],
  ['color', '颜色'],
  ['preview', '预览'],
  ['text', '文字'],
  ['preflight', '预检'],
  ['pack', '包装'],
  ['tools', '工具'],
  ['export', '导出'],
];

const S = {
  tab: 'export' as Tab,
  settings: structuredClone(DEFAULTS) as Settings,
  frames: [] as FrameInfo[],
  order: [] as string[],
  measure: [] as Measure[],
  profiles: [] as Profile[],
  maps: [] as ColorMap[],
  fileMaps: [] as ColorMap[],
  presets: [] as ExportPreset[],
  lib: [] as LibSwatch[],
  colors: null as ScannedColor[] | null,
  texts: null as TextNodeInfo[] | null,
  issues: null as Issue[] | null,
  images: [] as ImageInfoNode[],
  thumbs: {} as Record<string, string>,
  expanded: '' as string,
  lastResult: null as ExportResult | null,
  fileName: '',
  docProfile: 'SRGB',
  busy: false,
  password: '', // never persisted
  preview: null as null | { id: string; name: string; src: { w: number; h: number; rgb: Uint8Array }; data?: ProofData; mode: PreviewMode; paper: boolean; split: number },
};

// ---------------- messaging ----------------

const post = (type: string, data: any = {}) => parent.postMessage({ pluginMessage: { type, ...data } }, '*');
const pending = new Map<string, (v: any) => void>();
let reqSeq = 0;
function storeGet<T = any>(key: string): Promise<T> {
  const reqId = 'r' + reqSeq++;
  return new Promise((res) => {
    pending.set(reqId, res);
    post('store-get', { key, reqId });
  });
}
const waiters = new Map<string, (m: any) => void>();
function request<T = any>(type: string, data: any, reply: string): Promise<T> {
  return new Promise((res, rej) => {
    waiters.set(reply, res);
    waiters.set('error:' + type, (m) => rej(new Error(m.message)));
    post(type, data);
  });
}
let saveTimer: any = 0;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => post('store-set', { key: 'pk_settings', value: S.settings }), 300);
}
const notify = (text: string, error = false) => post('notify', { text: tr(text), error });

window.onmessage = (ev) => {
  const m = ev.data?.pluginMessage;
  if (!m) return;
  const w = waiters.get(m.type);
  if (w) {
    waiters.delete(m.type);
    w(m);
  }
  switch (m.type) {
    case 'init':
      S.settings = deepMerge(structuredClone(DEFAULTS), m.settings || {});
      S.profiles = m.profiles;
      S.maps = m.maps;
      S.fileMaps = m.fileMaps || [];
      S.presets = m.presets;
      S.fileName = m.fileName;
      S.docProfile = m.docProfile;
      if (!S.settings.iccId && S.profiles.length) S.settings.iccId = S.profiles[0].id;
      applyLang();
      storeGet<LibSwatch[]>('pk_spotlib').then((v) => {
        S.lib = v || [];
      });
      refreshEngine();
      break;
    case 'selection': {
      S.frames = m.frames;
      S.measure = m.measure || [];
      const ids = S.frames.map((f) => f.id);
      S.order = [...S.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !S.order.includes(id))];
      // always re-request: the frames may have been edited since the last thumbnail
      if (ids.length) post('thumbs', { ids });
      render();
      break;
    }
    case 'thumb':
      S.thumbs[m.id] = 'data:image/png;base64,' + bytesToB64(m.png);
      if (S.tab === 'export') {
        const img = document.querySelector(`[data-thumb="${CSS.escape(m.id)}"]`);
        if (img instanceof HTMLImageElement) img.src = S.thumbs[m.id];
        else render();
      }
      break;
    case 'colors':
      S.colors = m.colors;
      if (S.issues) S.issues = [...S.issues.filter((i) => i.cat !== 'color' || i.nodeId === undefined || !i.msg.includes('色域')), ...colorIssues()];
      render();
      break;
    case 'texts':
      S.texts = m.texts;
      render();
      break;
    case 'preflight':
      S.issues = [...m.issues, ...colorIssues()];
      S.images = m.images;
      render();
      break;
    case 'progress':
      progress(m.msg, m.frac);
      break;
    case 'notice':
      notify(m.text);
      break;
    case 'store-value':
      pending.get(m.reqId)?.(m.value);
      pending.delete(m.reqId);
      break;
    case 'error': {
      const rej = waiters.get('error:' + m.during);
      if (rej) {
        waiters.delete('error:' + m.during);
        rej(m);
      } else notify('出错了：' + m.message, true);
      busy(false);
      break;
    }
  }
};

function deepMerge<T>(base: T, over: any): T {
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof (base as any)[k] === 'object' && !Array.isArray((base as any)[k]) && !(k === 'overrides' || k === 'colorFinishing'))
      (base as any)[k] = deepMerge((base as any)[k], v);
    else (base as any)[k] = v;
  }
  return base;
}

// ---------------- colour engine ----------------

let lcms: any = null;
let engine: ColorEngine | null = null;
const profileBytes = new Map<string, Uint8Array>();

function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + 0x8000)));
  return btoa(s);
}

async function getLcms() {
  if (!lcms) lcms = await loadLcms(b64ToBytes(__LCMS_WASM_B64__));
  return lcms;
}

async function getProfile(id: string): Promise<Uint8Array | null> {
  if (!id) return null;
  if (profileBytes.has(id)) return profileBytes.get(id)!;
  const v = await storeGet<Uint8Array>('pk_icc_' + id);
  if (!v) return null;
  const bytes = v instanceof Uint8Array ? v : new Uint8Array(Object.values(v as any));
  profileBytes.set(id, bytes);
  return bytes;
}

function colorSettings(): ColorSettings {
  const s = S.settings;
  return {
    mode: s.mode,
    intent: s.intent,
    bpc: s.bpc,
    pureBlackToK: s.pureBlackToK,
    grayToK: s.grayToK,
    richBlack: s.richBlackOn ? s.richBlack : null,
    tacLimit: s.tacLimit,
    overrides: s.overrides,
    spotPolicy: s.spotPolicy,
    keepSpots: s.keepSpots.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean),
    overprintBlack: s.overprintBlack,
    removeWhiteOverprint: s.removeWhiteOverprint,
  };
}

let engineSeq = 0;
async function refreshEngine() {
  const seq = ++engineSeq;
  const l = await getLcms();
  const e = new ColorEngine(l, colorSettings());
  const p = await getProfile(S.settings.iccId);
  if (p) {
    try {
      e.setOutputProfile(p);
    } catch (err: any) {
      notify(err.message, true);
    }
  }
  if (seq === engineSeq) {
    engine = e;
    if (S.preview) S.preview.data = undefined;
    render();
  }
}

// native browser decoders (no colour management)
async function decodeBitmap(bytes: Uint8Array, type: string) {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' } as any);
  const cv = document.createElement('canvas');
  cv.width = bmp.width;
  cv.height = bmp.height;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  return { w: bmp.width, h: bmp.height, d: g.getImageData(0, 0, bmp.width, bmp.height).data };
}
setJpegDecoder(async (bytes, expect) => {
  if (expect === 4) return null;
  const { w, h, d } = await decodeBitmap(bytes, 'image/jpeg');
  const n = w * h;
  const out = new Uint8Array(n * expect);
  for (let i = 0; i < n; i++) {
    if (expect === 1) out[i] = d[i * 4];
    else {
      out[i * 3] = d[i * 4];
      out[i * 3 + 1] = d[i * 4 + 1];
      out[i * 3 + 2] = d[i * 4 + 2];
    }
  }
  return { w, h, comps: expect, data: out };
});
setPngDecoder(async (bytes) => {
  const { w, h, d } = await decodeBitmap(bytes, 'image/png');
  return { w, h, comps: 4, data: new Uint8Array(d.buffer.slice(0)) };
});

// ---------------- helpers ----------------

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
const fmtC = (c: CMYK) => [c.c, c.m, c.y, c.k].map((x) => Math.round(x)).join(' / ');
const UNIT_NAMES: Record<Unit, string> = { mm: '毫米', cm: '厘米', in: '英寸', pt: '点', px: '像素' };
const toUnit = (mm: number) => +(mm / UNIT_TO_MM[S.settings.unit]).toFixed(S.settings.unit === 'mm' ? 1 : 3);
const fromUnit = (v: number) => v * UNIT_TO_MM[S.settings.unit];

function getPath(path: string): any {
  return path.split('.').reduce((o: any, k) => o?.[k], S.settings);
}
function setPath(path: string, v: any) {
  const ks = path.split('.');
  let o: any = S.settings;
  for (const k of ks.slice(0, -1)) o = o[k];
  o[ks[ks.length - 1]] = v;
}

const ENGINE_KEYS = ['mode', 'iccId', 'intent', 'bpc', 'pureBlackToK', 'grayToK', 'richBlackOn', 'tacLimit', 'overprintBlack', 'removeWhiteOverprint', 'spotPolicy', 'keepSpots'];

function update(path: string, v: any) {
  const s = S.settings;
  if (path === 'doc.landscape' && v !== s.doc.landscape) {
    const d = s.doc;
    [d.w, d.h] = v ? [Math.max(d.w, d.h), Math.min(d.w, d.h)] : [Math.min(d.w, d.h), Math.max(d.w, d.h)];
  }
  setPath(path, v);
  if (path === 'richPreset' && RICH_PRESETS[v]) s.richBlack = { ...RICH_PRESETS[v][1] };
  if (path.startsWith('richBlack.')) s.richPreset = 'custom';
  if (path === 'compression' && COMPRESSION[v]) {
    s.jpegQuality = COMPRESSION[v].q;
    s.maxPpi = COMPRESSION[v].maxPpi;
    s.imageCompression = COMPRESSION[v].mode;
  }
  if (['jpegQuality', 'maxPpi', 'imageCompression'].includes(path)) s.compression = 'custom';
  if (path === 'imp.sheet') {
    const p = SHEET_PRESETS.find((x) => x.id === v);
    if (p) [s.imp.sheetW, s.imp.sheetH] = [p.w, p.h];
  }
  if (path === 'format' && v !== 'pdf') s.imp.kind = 'none';
  saveSettings();
  if (ENGINE_KEYS.some((k) => path === k || path.startsWith('richBlack'))) refreshEngine();
  else render();
}

// form controls bound to settings paths (data-u = value stored in mm, shown in the current unit)
const num = (path: string, opts: { min?: number; max?: number; step?: number; w?: number; unit?: boolean } = {}) => {
  const v = getPath(path);
  const shown = opts.unit ? toUnit(v) : v;
  return `<input type="number" data-bind="${path}" data-t="num" ${opts.unit ? 'data-u="1"' : ''} value="${shown}" ${opts.min !== undefined ? `min="${opts.min}"` : ''} ${opts.max !== undefined ? `max="${opts.max}"` : ''} step="${opts.unit && S.settings.unit !== 'mm' ? 'any' : opts.step ?? 1}" ${opts.w ? `style="width:${opts.w}px"` : ''}>`;
};
const U = () => `<span class="unit">${S.settings.unit}</span>`;
const txt = (path: string, ph = '') => `<input type="text" data-bind="${path}" value="${esc(getPath(path) ?? '')}" placeholder="${esc(ph)}">`;
const chk = (path: string, label: string, hint = '') =>
  `<label class="chk"><input type="checkbox" data-bind="${path}" data-t="bool" ${getPath(path) ? 'checked' : ''}><span>${label}${hint ? ` <span class="muted">${hint}</span>` : ''}</span></label>`;
const seg = (path: string, opts: [any, string][]) =>
  `<div class="seg">${opts.map(([v, l]) => `<button data-act="seg" data-path="${path}" data-v="${esc(JSON.stringify(v))}" class="${getPath(path) === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
const sel = (path: string, opts: [any, string][], t = 'str') =>
  `<select data-bind="${path}" data-t="${t}">${opts.map(([v, l]) => `<option value="${esc(String(v))}" ${String(getPath(path)) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const sides4 = (base: string) =>
  `<div class="grid4">${(['t', 'r', 'b', 'l'] as const).map((k) => `<label>${{ t: '上', r: '右', b: '下', l: '左' }[k]}${num(`${base}.${k}`, { min: 0, step: 0.5, w: 54, unit: true })}</label>`).join('')}</div>`;

function tacBadge(t: number) {
  const cls = t < 280 ? 'b-ok' : t <= 320 ? 'b-warn' : 'b-err';
  return `<span class="badge ${cls}" title="总墨量 TAC">${Math.round(t)}%</span>`;
}

function cmykFor(hex: string): { c: CMYK; kind: 'icc' | 'custom' | 'spot' | 'finish' } {
  const ov = S.settings.overrides[hex];
  if (S.settings.colorFinishing[hex]) return { c: { c: 0, m: 0, y: 0, k: 0 }, kind: 'finish' };
  if (ov?.spot) return { c: ov.spot.alt, kind: 'spot' };
  if (ov?.cmyk) return { c: ov.cmyk, kind: 'custom' };
  const [r, g, b] = hexToRgb(hex);
  return { c: engine ? engine.iccCmyk(r, g, b) : { c: 0, m: 0, y: 0, k: 0 }, kind: 'icc' };
}

function currentProfile() {
  return S.profiles.find((p) => p.id === S.settings.iccId);
}

function allMaps(): (ColorMap & { file?: boolean })[] {
  return [...S.fileMaps.map((m) => ({ ...m, file: true })), ...S.maps];
}

// ---------------- language ----------------

function applyLang() {
  const l = (S.settings.lang || detectLang()) as Lang;
  setLang(l);
  document.documentElement.lang = l;
  post('set-lang', { lang: l });
  translateDom(document.getElementById('overlay')!);
  // default names follow the interface language
  const DEFAULT_NAMES = ['印刷文档', 'Print document', '印刷ドキュメント', '인쇄 문서', 'Documento de impresión', 'Druckdokument', 'Document d’impression', '印刷文件'];
  if (DEFAULT_NAMES.includes(S.settings.doc.name)) S.settings.doc.name = tr('印刷文档');
}

const langSelect = () =>
  `<select id="lang" title="Language" class="lang" data-notr>${LANGS.map((l) => `<option value="${l.code}" ${getLang() === l.code ? 'selected' : ''}>${l.name}</option>`).join('')}</select>`;

// ---------------- views ----------------

// Re-rendering replaces the form. A change event fires while focus is leaving a field (Tab, or a
// press on another control); rebuilding the DOM right then would swallow that Tab / click. So
// renders requested from a change are deferred until the press is over, and afterwards the
// cursor is put back into whichever field had focus.
const fieldKey = (el: Element | null): string | null => {
  if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.dataset.bind) return `[data-bind="${CSS.escape(el.dataset.bind)}"]`;
  return null;
};
let inChange = false;
let lastTab = 0;
document.addEventListener('keydown', (e) => e.key === 'Tab' && (lastTab = Date.now()), true);
let pointerDown = false;
let renderPending = false;
const flushRender = () => {
  if (!renderPending || pointerDown) return;
  renderPending = false;
  renderNow();
};
document.addEventListener('pointerdown', () => (pointerDown = true), true);
const release = () => {
  if (!pointerDown) return;
  pointerDown = false;
  setTimeout(flushRender, 0); // after the click event of this press
};
document.addEventListener('pointerup', release, true);
document.addEventListener('pointercancel', release, true);
window.addEventListener('blur', release);

function render() {
  if (inChange || renderPending) {
    renderPending = true;
    setTimeout(flushRender, 0);
    return;
  }
  renderNow();
}

function renderNow() {
  const focusKey = fieldKey(document.activeElement);
  const ae = document.activeElement as HTMLInputElement | null;
  let caret: [number | null, number | null] | null = null;
  try {
    if (ae && 'selectionStart' in ae) caret = [ae.selectionStart, ae.selectionEnd];
  } catch {}
  renderInner();
  if (!focusKey) return;
  const el = document.querySelector(focusKey) as HTMLInputElement | null;
  if (!el || el === document.activeElement) return;
  el.focus({ preventScroll: true });
  try {
    if (caret && caret[0] != null) el.setSelectionRange(caret[0], caret[1]);
    // number fields don't expose the caret: after Tab select the value (as the browser does),
    // otherwise put the caret at the end
    else if (el instanceof HTMLInputElement && el.type === 'number') {
      if (Date.now() - lastTab < 600) el.select();
      else {
        el.type = 'text';
        el.setSelectionRange(el.value.length, el.value.length);
        el.type = 'number';
      }
    }
  } catch {}
}

function renderInner() {
  $('tabs').innerHTML = TABS.map(([id, l]) => `<button data-act="tab" data-v="${id}" class="${S.tab === id ? 'on' : ''}">${l}</button>`).join('');
  $('lang-slot').innerHTML = langSelect();
  $('tabs').querySelector('.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  translateDom($('tabs'));
  const main = $('view');
  const scroll = main.scrollTop;
  main.innerHTML = { doc: viewDoc, color: viewColor, preview: viewPreview, text: viewText, preflight: viewPreflight, pack: viewPack, tools: viewTools, export: viewExport }[S.tab]();
  translateDom(main);
  main.scrollTop = scroll;
  if (S.tab === 'preview') paintPreview();
  renderPills();
}

function frameSize(f: FrameInfo) {
  const k = f.meta?.scale || 1;
  return { w: f.meta ? f.meta.trimW : (f.w * k) / MM, h: f.meta ? f.meta.trimH : (f.h * k) / MM };
}

function framesSummary() {
  if (!S.frames.length) return `<div class="empty">请在画布上选择要导出的画板（Frame）</div>`;
  return `<div class="list">${S.frames
    .map((f) => {
      const { w, h } = frameSize(f);
      return `<div class="item click" data-act="select" data-v="${f.id}"><span class="grow" data-notr>${esc(f.name)}</span><span class="muted mono">${toUnit(w)}×${toUnit(h)}${S.settings.unit}</span>${
        f.meta ? `<span class="badge b-ok">出血 ${f.meta.bleed}mm</span>` : `<span class="badge b-info">无出血</span>`
      }${f.meta?.scale && f.meta.scale > 1 ? `<span class="badge b-warn">1:${f.meta.scale}</span>` : ''}</div>`;
    })
    .join('')}</div>`;
}

function viewDoc() {
  const s = S.settings;
  const d = s.doc;
  const groups = new Map<string, typeof PAPER_PRESETS>();
  for (const p of PAPER_PRESETS) groups.set(p.group, [...(groups.get(p.group) || []), p]);
  const presetOpts =
    [...groups.entries()].map(([g, ps]) => `<optgroup label="${g}">${ps.map((p) => `<option value="${p.id}" ${d.preset === p.id ? 'selected' : ''}>${p.name}（${p.w}×${p.h}）</option>`).join('')}</optgroup>`).join('') +
    (s.customPapers.length ? `<optgroup label="我的尺寸">${s.customPapers.map((p, i) => `<option value="custom:${i}" ${d.preset === 'custom:' + i ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>` : '') +
    `<option value="custom" ${d.preset === 'custom' ? 'selected' : ''}>自定义尺寸…</option>`;
  const big = d.w * d.h > 1000 * 1400;
  return `
  <h3>新建印刷文档<span class="sp"></span>${seg('unit', [['mm', 'mm'], ['cm', 'cm'], ['in', 'in'], ['pt', 'pt']])}</h3>
  <div class="row"><label>纸张尺寸</label><select data-act="preset">${presetOpts}</select></div>
  <div class="grid2">
    <div class="row"><label>宽</label>${num('doc.w', { min: 1, step: 0.5, w: 70, unit: true })}${U()}</div>
    <div class="row"><label>高</label>${num('doc.h', { min: 1, step: 0.5, w: 70, unit: true })}${U()}</div>
    <div class="row"><label>页边距</label>${num('doc.margin', { min: 0, unit: true })}${U()}</div>
    <div class="row"><label>安全区</label>${num('doc.safety', { min: 0, step: 0.5, unit: true })}${U()}</div>
    <div class="row"><label>页数</label>${num('doc.pages', { min: 1, max: 400 })}</div>
    <div class="row"><label>制作比例</label>${sel('doc.scale', [[1, '1:1 实际尺寸'], [2, '1:2'], [4, '1:4'], [5, '1:5'], [10, '1:10（大幅喷绘）']], 'num')}</div>
  </div>
  ${big && d.scale === 1 ? `<p class="hint" style="color:var(--warn)">幅面较大，建议用 1:10 比例制作，避免 Figma 卡顿；导出时会自动放大回实际尺寸。</p>` : ''}
  <div class="row"><label>出血</label>${d.sidesOn ? sides4('doc.sides') : `${num('doc.bleed', { min: 0, step: 0.5, unit: true })}${U()}`}</div>
  <div class="row"><label></label>${chk('doc.sidesOn', '四边出血不同', '（如装订边不需要出血）')}</div>
  <div class="row"><label>方向</label>${seg('doc.landscape', [[false, '竖版'], [true, '横版']])}</div>
  <div class="row"><label>折页</label>${sel('doc.fold', [['none', '无'], ['half', '对折'], ['tri', '三折（风琴/卷折）'], ['z', 'Z 字折'], ['gate', '关门折']])}</div>
  ${chk('doc.facing', '对页排列（画册 / 书刊跨页）')}
  <div class="row"><label>名称</label>${txt('doc.name')}</div>
  <div class="row"><button class="btn primary" data-act="create-doc">创建画板</button><button class="btn" data-act="save-paper">保存为常用尺寸</button></div>
  <p class="hint">画板会包含出血区，并自动画出裁切线、安全区、折线参考线。按 ⌘⇧4（Windows：Ctrl+Shift+4）显示或隐藏参考网格。</p>
  <h3>批量创建（CSV）</h3>
  <p class="hint">一行一个尺寸：<span class="mono">名称,宽,高,出血,页数</span>（单位 ${UNIT_NAMES[s.unit]}）。可以让 AI 帮你按需求填好再导入。</p>
  <div class="row"><button class="btn" data-act="csv-import">导入 CSV</button><button class="btn" data-act="csv-template">下载模板</button></div>
  <hr>
  <h3>给已有画板加出血</h3>
  <p class="hint">适合已经按成品尺寸做好的设计：画板向外扩大，贴边的背景、色块、图片自动延伸到出血区。</p>
  <div class="row"><label>出血</label>${s.bleedSidesOn ? sides4('bleedSides') : `${num('bleedMm', { min: 0, step: 0.5, unit: true })}${U()}`}<button class="btn" data-act="convert-frames">为所选画板加出血</button></div>
  <h3>当前选择</h3>
  ${framesSummary()}`;
}

function viewColor() {
  const s = S.settings;
  const prof = currentProfile();
  const profOpts: [string, string][] = [['', S.profiles.length ? '— 选择 —' : '尚未导入 ICC'], ...S.profiles.map((p) => [p.id, p.name] as [string, string])];
  let colorsHtml = '';
  if (s.mode !== 'cmyk') colorsHtml = `<p class="hint">颜色映射、专色和总墨量只在 CMYK 模式下生效。</p>`;
  else if (!S.colors) colorsHtml = `<div class="empty">点击“扫描颜色”，列出所选画板用到的所有颜色</div>`;
  else if (!S.colors.length) colorsHtml = `<div class="empty">没有找到颜色</div>`;
  else
    colorsHtml = `<div class="list">${S.colors
      .map((c) => {
        const { c: cm, kind } = cmykFor(c.hex);
        const ov = s.overrides[c.hex];
        const proof = engine && kind !== 'finish' ? engine.proofHex(cm) : c.hex;
        const [r, g, b] = hexToRgb(c.hex);
        const de = engine && kind === 'icc' ? engine.gamutDeltaE(r, g, b, cm) : 0;
        const label =
          kind === 'finish'
            ? `<span class="badge b-warn">工艺</span> ${esc(s.colorFinishing[c.hex])}`
            : kind === 'spot'
              ? `<span class="badge b-info">专色</span> ${esc(ov!.spot!.name)}`
              : `<span class="mono">${fmtC(cm)}</span>${kind === 'custom' ? ' <span class="badge b-info">自定义</span>' : ''}`;
        const open = S.expanded === c.hex;
        return `<div class="item click" data-act="expand" data-v="${c.hex}">
          <span class="sw pair" style="background:${c.hex}" title="设计稿颜色"></span><span class="sw pair" style="background:${proof}" title="印刷效果预览"></span>
          <span style="width:56px"><span class="mono">${c.hex}</span>${c.names?.length ? `<br><span class="muted" style="font-size:9px">${esc(c.names[0])}</span>` : ''}</span><span class="grow">${label}${ov?.overprint ? ' <span class="badge b-warn">叠印</span>' : ''}${de > 10 ? ' <span class="badge b-err" title="屏幕色超出印刷色域，印出来会偏灰">超色域</span>' : ''}</span>
          ${kind === 'icc' || kind === 'custom' ? tacBadge(tac(cm)) : ''}<span class="muted" style="width:28px;text-align:right">×${c.count}</span></div>
          ${open ? colorEditor(c) : ''}`;
      })
      .join('')}</div>`;
  const cur = allMaps().find((m) => m.name === s.activeMap);
  const dirty = s.activeMap && JSON.stringify(cur?.overrides || {}) !== JSON.stringify(s.overrides);
  return `
  <h3>输出色彩</h3>
  <div class="row"><label>颜色模式</label>${seg('mode', [['cmyk', 'CMYK 印刷'], ['rgb', 'RGB'], ['gray', '灰度']])}</div>
  ${
    s.mode === 'cmyk'
      ? `
  <div class="row"><label>ICC 配置文件</label>${sel('iccId', profOpts)}<button class="btn small" data-act="import-icc">导入</button>${prof ? `<button class="btn small" data-act="del-icc" title="从插件中移除">移除</button>` : ''}</div>
  ${
    !S.profiles.length
      ? `<div class="card"><b>第一次使用：请导入印刷厂提供的 ICC 文件</b><p class="hint">不确定用哪个时：国内胶印一般用 <b>Japan Color 2001 Coated</b>，欧洲用 <b>Coated FOGRA39</b> / <b>PSO Coated v3</b>，北美用 <b>GRACoL / SWOP</b>。<br>免费下载：<a href="https://www.adobe.com/support/downloads/iccprofiles/iccprofiles_mac.html" target="_blank">Adobe ICC 配置文件包</a>（含 Japan Color、FOGRA39、SWOP），<a href="https://www.eci.org/en/downloads" target="_blank">ECI 配置文件</a>（PSO Coated v3、eciCMYK v2）。下载解压后点“导入”，选择 .icc 文件即可，插件会记住。</p></div>`
      : ''
  }
  <div class="row"><label>渲染意图</label>${sel('intent', [[1, '相对比色（推荐，保留准确色）'], [0, '可感知（照片多时更顺滑）'], [2, '饱和度（图表、色块）'], [3, '绝对比色（模拟纸白，打样用）']], 'num')}</div>
  ${chk('bpc', '黑场补偿', '（保留暗部层次，推荐开启）')}
  <h3>黑色与墨量</h3>
  ${chk('pureBlackToK', '纯黑 #000000 → 单色黑 K100', '（小字不发虚）')}
  ${chk('grayToK', '中性灰 → 只用 K 版', '（灰色文字和线条更干净）')}
  ${chk('richBlackOn', '大面积纯黑 → 四色黑', '（≥1cm 的黑色块更浓郁，文字不受影响）')}
  ${
    s.richBlackOn
      ? `<div class="row" style="padding-left:20px"><label>配方</label>${sel('richPreset', [...Object.entries(RICH_PRESETS).map(([k, v]) => [k, v[0]] as [string, string]), ['custom', '自定义']])}</div>
  <div class="row" style="padding-left:20px"><label></label>C${num('richBlack.c', { min: 0, max: 100, w: 44 })}M${num('richBlack.m', { min: 0, max: 100, w: 44 })}Y${num('richBlack.y', { min: 0, max: 100, w: 44 })}K${num('richBlack.k', { min: 0, max: 100, w: 44 })}</div>`
      : ''
  }
  <div class="row"><label>总墨量上限</label>${num('tacLimit', { min: 0, max: 400, step: 10 })}<span class="unit">%（铜版纸常用 320，胶版纸 280–300；0 = 不限制）</span></div>
  <h3>文档颜色<span class="sp"></span><button class="btn small" data-act="scan-colors">扫描颜色</button></h3>
  <p class="hint">左边是设计稿颜色，右边是印刷模拟。点击颜色可以手动指定 CMYK、设为专色、设为刀线 / 工艺，或叠印。</p>
  <div class="row"><label>颜色映射表</label><select data-act="load-map"><option value="">— 不使用 —</option>${allMaps().map((m) => `<option ${m.name === s.activeMap ? 'selected' : ''}>${esc(m.name)}${m.file ? '（本文件）' : ''}</option>`).join('')}</select>${dirty ? '<span class="badge b-warn">未保存</span>' : ''}</div>
  <div class="row"><label></label><input type="text" id="map-name" placeholder="映射表名称，例如：品牌色 2026" value="${esc(s.activeMap)}"><button class="btn small" data-act="save-map">保存</button>${s.activeMap ? '<button class="btn small" data-act="del-map">删除</button>' : ''}</div>
  <div class="row"><label></label>${chk('mapsInFile', '保存到当前 Figma 文件', '（团队成员打开同一文件都能用）')}</div>
  <div class="row"><label>色板库</label><span class="muted grow">${S.lib.length ? `已导入 ${S.lib.length} 个色板` : '可导入潘通 / RAL / HKS 色板（.ase 或 CSV）'}</span><button class="btn small" data-act="import-lib">导入</button>${S.lib.length ? '<button class="btn small" data-act="clear-lib">清空</button>' : ''}</div>
  `
      : s.mode === 'gray'
        ? `<p class="hint">所有颜色和图片会转成单色灰度（只用黑色油墨），适合黑白印刷。</p>`
        : `<p class="hint">保持 RGB 颜色，适合数码快印或屏幕阅读。出血、裁切线等功能照常可用。</p>`
  }
  ${colorsHtml}`;
}

function colorEditor(c: ScannedColor) {
  const s = S.settings;
  const ov = s.overrides[c.hex];
  const kind = s.colorFinishing[c.hex] ? 'finish' : ov?.spot ? 'spot' : ov?.cmyk ? 'custom' : 'icc';
  const slider = (k: keyof CMYK, v: number) =>
    `<div class="slider"><b>${k.toUpperCase()}</b><input type="range" min="0" max="100" step="1" value="${v}" data-act="cmyk" data-hex="${c.hex}" data-k="${k}"><input type="number" min="0" max="100" value="${Math.round(v)}" data-act="cmyk" data-hex="${c.hex}" data-k="${k}"></div>`;
  const [r, g, b] = hexToRgb(c.hex);
  const icc = engine ? engine.iccCmyk(r, g, b) : { c: 0, m: 0, y: 0, k: 0 };
  const de = engine ? engine.gamutDeltaE(r, g, b, icc) : 0;
  return `<div class="expand" data-stop="1">
    <div class="row"><div class="seg">
      <button data-act="ckind" data-hex="${c.hex}" data-v="icc" class="${kind === 'icc' ? 'on' : ''}">按 ICC</button>
      <button data-act="ckind" data-hex="${c.hex}" data-v="custom" class="${kind === 'custom' ? 'on' : ''}">自定义 CMYK</button>
      <button data-act="ckind" data-hex="${c.hex}" data-v="spot" class="${kind === 'spot' ? 'on' : ''}">专色</button>
      <button data-act="ckind" data-hex="${c.hex}" data-v="finish" class="${kind === 'finish' ? 'on' : ''}">刀线 / 工艺</button></div></div>
    ${kind === 'icc' ? `<p class="hint">ICC 换算结果：${fmtC(icc)}，总墨量 ${Math.round(tac(icc))}%，与屏幕色差 ΔE ${de.toFixed(1)}${de > 10 ? '（超出印刷色域，会偏灰）' : de > 5 ? '（略有偏差）' : '（准确）'}。${c.inGradient ? '这个颜色用在渐变里。' : ''}</p>` : ''}
    ${kind === 'custom' ? (['c', 'm', 'y', 'k'] as const).map((k) => slider(k, ov!.cmyk![k])).join('') : ''}
    ${
      kind === 'spot'
        ? `<div class="row"><label>专色名称</label><input type="text" list="spot-lib" data-act="spotname" data-hex="${c.hex}" value="${esc(ov!.spot!.name)}" placeholder="例如 PANTONE 186 C"></div>
    ${S.lib.length ? `<div class="row"><label></label><button class="btn small" data-act="nearest-spot" data-hex="${c.hex}">从色板库找最接近的</button></div>` : ''}
    <div class="row"><label>浓度</label><input type="range" min="1" max="100" value="${ov!.spot!.tint}" data-act="tint" data-hex="${c.hex}" style="flex:1"><span class="mono">${ov!.spot!.tint}%</span></div>
    <p class="hint">专色的 CMYK 替代值（屏幕预览和“转为四色”时使用）：</p>
    ${(['c', 'm', 'y', 'k'] as const).map((k) => slider(k, ov!.spot!.alt[k])).join('')}
    ${c.inGradient ? '<p class="hint" style="color:var(--warn)">注意：渐变里的专色无法单独成版，会按 CMYK 替代值输出。</p>' : ''}`
        : ''
    }
    ${
      kind === 'finish'
        ? `<div class="row"><label>工艺版</label><select data-act="finish-name" data-hex="${c.hex}">${DIELINE_KEYWORDS.map((d) => `<option ${s.colorFinishing[c.hex] === d.spot ? 'selected' : ''}>${d.spot}</option>`).join('')}</select></div>
    <p class="hint">用这个颜色的描边会输出成单线刀线 / 折线（叠印），填充会输出成对应的工艺专色版（光油、白墨、烫金等），不会印成颜色。</p>`
        : ''
    }
    ${kind !== 'finish' ? `<label class="chk"><input type="checkbox" data-act="overprint" data-hex="${c.hex}" ${ov?.overprint ? 'checked' : ''}>叠印（压印在下层颜色上，不挖空）</label>` : ''}
    ${ov || kind === 'finish' ? `<button class="btn small" data-act="reset-color" data-hex="${c.hex}">恢复默认</button>` : ''}
    <datalist id="spot-lib">${S.lib.slice(0, 3000).map((l) => `<option value="${esc(l.name)}">`).join('')}</datalist>
  </div>`;
}

function viewPreview() {
  const p = S.preview;
  const target = S.frames.find((f) => f.id === S.order[0]);
  const st = p?.data?.stats;
  return `
  <h3>印刷效果预览<span class="sp"></span><button class="btn small" data-act="render-preview">${p ? '重新生成' : '生成预览'}</button></h3>
  <p class="hint">${target ? `预览「${esc(target.name)}」。` : '请先选择画板。'}按当前 ICC 和颜色映射模拟印刷后的样子。${S.settings.mode !== 'cmyk' ? '（预览仅在 CMYK 模式下有意义）' : ''}</p>
  ${
    p
      ? `<div class="row">${segRaw('pv-mode', p.mode, [['original', '原稿'], ['proof', '印刷模拟'], ['split', '对比'], ['tac', '墨量'], ['gamut', '超色域']])}</div>
  <div class="row">${segRaw('pv-mode', p.mode, [['c', 'C 版'], ['m', 'M 版'], ['y', 'Y 版'], ['k', 'K 版']])}<label class="chk" style="margin-left:8px"><input type="checkbox" data-act="pv-paper" ${p.paper ? 'checked' : ''}>模拟纸张白</label></div>
  ${p.mode === 'split' ? `<div class="row"><label>对比位置</label><input type="range" min="0" max="100" value="${Math.round(p.split * 100)}" data-act="pv-split" style="flex:1"></div>` : ''}
  <div class="pv"><canvas id="pv-canvas"></canvas></div>
  ${
    st
      ? `<div class="row"><span class="badge ${st.tacMax > S.settings.tacLimit ? 'b-err' : 'b-ok'}">最大墨量 ${st.tacMax}%</span><span class="badge ${st.tacOver > 0 ? 'b-warn' : 'b-ok'}">超墨量面积 ${(st.tacOver * 100).toFixed(1)}%</span><span class="badge ${st.gamutOut > 0.02 ? 'b-warn' : 'b-ok'}">超色域面积 ${(st.gamutOut * 100).toFixed(1)}%</span></div>
  <p class="hint">“墨量”里红色区域超过总墨量上限（导出时会自动压到上限）；“超色域”里品红色区域在印刷时会明显变灰、变暗。</p>`
      : ''
  }`
      : `<div class="empty">点击“生成预览”</div>`
  }`;
}
const segRaw = (act: string, cur: string, opts: [string, string][]) => `<div class="seg">${opts.map(([v, l]) => `<button data-act="${act}" data-v="${v}" class="${cur === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;

function paintPreview() {
  const p = S.preview;
  const cv = document.getElementById('pv-canvas') as HTMLCanvasElement | null;
  if (!p || !cv || !engine) return;
  if (!p.data) {
    p.data = buildProof(p.src, engine, p.paper, S.settings.tacLimit);
    // stats appear after the first build
    setTimeout(render, 0);
    return;
  }
  paint(cv, p.data, p.mode, p.split, S.settings.tacLimit);
}

function viewText() {
  const t = S.texts;
  let body = '';
  if (!t) body = `<div class="empty">点击“扫描文字”列出所选画板中的文字图层</div>`;
  else if (!t.length) body = `<div class="empty">没有文字图层</div>`;
  else {
    const byFrame = new Map<string, TextNodeInfo[]>();
    for (const n of t) byFrame.set(n.frame, [...(byFrame.get(n.frame) || []), n]);
    body = [...byFrame.entries()]
      .map(
        ([fr, list]) => `<h3 data-notr>${esc(fr)}</h3><div class="list">${list
          .map(
            (n) => `<div class="item"><div class="grow" data-act="select" data-v="${n.id}" style="cursor:pointer"><div class="grow" data-notr>${esc(n.preview || n.name)}</div><div class="muted">${esc(n.fonts.join('、'))} · ${n.size}pt${n.hasEffects ? ' · <span style="color:var(--warn)">有效果</span>' : ''}${n.missingFont ? ' · <span style="color:var(--danger)">缺字体</span>' : ''}</div></div>
            <div class="seg"><button data-act="tmode" data-v="${n.id}" data-m="live" class="${n.mode === 'live' ? 'on' : ''}" title="保留可选中、可搜索的文字">Aa 文字</button><button data-act="tmode" data-v="${n.id}" data-m="outline" class="${n.mode === 'outline' ? 'on' : ''}" title="转成矢量路径，任何印刷机都安全">转曲</button></div></div>`,
          )
          .join('')}</div>`,
      )
      .join('');
  }
  const missing = t?.filter((n) => n.missingFont).length || 0;
  return `
  <h3>文字输出方式<span class="sp"></span><button class="btn small" data-act="scan-text">扫描文字</button></h3>
  <p class="hint"><b>Aa 文字</b>：字形完整嵌入，PDF 里可以选中、搜索、复制（含中文）。<br><b>转曲</b>：彻底转成路径，没有任何字体依赖，但 PDF 里不能再选中文字。</p>
  ${missing ? `<div class="card" style="color:var(--danger)">有 ${missing} 个文字图层缺少字体，请先在 Figma 中安装或替换字体，否则导出的字形会被替换。</div>` : ''}
  ${t?.length ? `<div class="chips"><button class="btn small" data-act="tall" data-v="live">全部保留文字</button><button class="btn small" data-act="tall" data-v="live-noeff">有效果的转曲，其余保留</button><button class="btn small" data-act="tall" data-v="outline">全部转曲</button></div>` : ''}
  <div class="row"><label>导出时</label>${sel('textOutline', [['perNode', '按每个图层的设置'], ['all', '全部转曲'], ['none', '全部保留文字']])}</div>
  ${body}`;
}

function colorIssues(): Issue[] {
  const out: Issue[] = [];
  const s = S.settings;
  if (s.mode !== 'cmyk') return out;
  if (!currentProfile()) out.push({ level: 'warning', cat: 'color', msg: '没有选择 ICC 配置文件，将用简单公式换算 CMYK，颜色可能偏差较大。请在“颜色”页导入。' });
  for (const c of S.colors || []) {
    const { c: cm, kind } = cmykFor(c.hex);
    if (kind === 'finish') continue;
    if (kind !== 'spot' && s.tacLimit && tac(cm) > s.tacLimit + 0.5)
      out.push({ level: 'warning', cat: 'color', nodeId: c.sampleNode, msg: `颜色 ${c.hex} 总墨量 ${Math.round(tac(cm))}% 超过 ${s.tacLimit}%（导出时会自动压到上限）。` });
    const [r, g, b] = hexToRgb(c.hex);
    if (kind === 'icc' && engine && !c.inGradient) {
      const de = engine.gamutDeltaE(r, g, b, cm);
      if (de > 10) out.push({ level: 'info', cat: 'color', nodeId: c.sampleNode, msg: `颜色 ${c.hex} 超出印刷色域（色差 ΔE ${de.toFixed(0)}），印出来会偏灰。可以在“颜色”页手动指定 CMYK 或改用专色。` });
    }
    const ov = s.overrides[c.hex];
    if (ov?.spot && c.inGradient) out.push({ level: 'warning', cat: 'spot', nodeId: c.sampleNode, msg: `专色「${ov.spot.name}」用在了渐变里，渐变部分会按四色输出。` });
    if (ov?.overprint && tac(cm) < 1) out.push({ level: 'error', cat: 'color', nodeId: c.sampleNode, msg: `白色 ${c.hex} 设置了叠印，印刷时会消失。`, fix: 'removeWhiteOverprint' });
  }
  return out;
}

const CAT_NAMES: Record<string, string> = { geometry: '几何 / 版面', color: '颜色', resolution: '分辨率', transparency: '透明度', text: '文字', annotation: '注释', spot: '专色 / 刀版' };

function viewPreflight() {
  const is = S.issues;
  let body = '';
  if (!is) body = `<div class="empty">点击“开始检查”，检查分辨率、出血、细线、小字、四色黑小字、色域、总墨量等问题</div>`;
  else {
    const count = (l: string) => is.filter((i) => i.level === l).length;
    const score = Math.max(0, 100 - count('error') * 15 - count('warning') * 5 - count('info'));
    body = `<div class="row"><span class="score ${score >= 85 ? 'b-ok' : score >= 60 ? 'b-warn' : 'b-err'}">${score}</span><span class="badge b-err">${count('error')} 个错误</span><span class="badge b-warn">${count('warning')} 个警告</span><span class="badge b-info">${count('info')} 个提示</span></div>`;
    if (!count('error') && !count('warning')) body += `<div class="card" style="color:var(--ok)">没有发现会影响印刷的问题 ✓</div>`;
    const cats = [...new Set(is.map((i) => i.cat))];
    const order = { error: 0, warning: 1, info: 2, pass: 3 } as Record<string, number>;
    body += cats
      .map(
        (c) => `<h3>${CAT_NAMES[c] || c}</h3><div class="list">${is
          .filter((i) => i.cat === c)
          .sort((a, b) => order[a.level] - order[b.level])
          .map((i, idx) => `<div class="issue" ${i.nodeId ? `data-act="select" data-v="${i.nodeId}"` : ''}><span class="dot d-${i.level}"></span><span class="grow" style="white-space:normal">${esc(i.msg)}${i.frame && !i.msg.includes(i.frame) ? ` <span class="muted">· ${esc(i.frame)}</span>` : ''}</span>${fixButton(i, idx)}</div>`)
          .join('')}</div>`,
      )
      .join('');
    if (S.images.length)
      body += `<h3>图片分辨率</h3><div class="list">${S.images
        .map((im) => `<div class="item click" data-act="select" data-v="${im.id}"><span class="grow" data-notr>${esc(im.name)}</span><span class="muted mono">${im.px}</span><span class="badge ${im.ppi >= S.settings.minPpi ? 'b-ok' : im.ppi >= S.settings.minPpi / 2 ? 'b-warn' : 'b-err'}">${im.ppi} ppi</span></div>`)
        .join('')}</div>`;
  }
  return `
  <h3>检查标准</h3>
  <div class="grid2">
    <div class="row"><label>最低分辨率</label>${num('minPpi', { min: 72, max: 600, step: 10 })}<span class="unit">ppi</span></div>
    <div class="row"><label>最细线条</label>${num('minStrokePt', { min: 0, max: 2, step: 0.05 })}<span class="unit">pt</span></div>
    <div class="row"><label>最小字号</label>${num('minTextPt', { min: 3, max: 12, step: 0.5 })}<span class="unit">pt</span></div>
  </div>
  ${chk('blockLowPpi', '有图片低于最低分辨率时，禁止导出')}
  <div class="row"><button class="btn primary" data-act="preflight">开始检查</button><span class="muted">点击问题可在画布上定位</span></div>
  ${body}`;
}

function fixButton(i: Issue, _idx: number) {
  if (!i.fix) return '';
  if (i.fix.startsWith('k100:')) return `<button class="btn small" data-act="fix-k100" data-v="${i.fix.slice(5)}">改为单色黑</button>`;
  if (i.fix === 'upscale' && i.nodeId) return `<button class="btn small" data-act="upscale" data-v="${i.nodeId}">放大 2 倍</button>`;
  if (i.fix === 'autoBleed') return '';
  return '';
}

function viewPack() {
  const s = S.settings;
  const spots = Object.values(s.overrides).filter((o) => o.spot);
  const fin = Object.entries(s.colorFinishing);
  const b = s.box;
  return `
  <h3>专色处理</h3>
  <div class="row">${seg('spotPolicy', [['preserve', '全部保留为专色'], ['flatten', '全部转为四色'], ['keepListed', '只保留指定的']])}</div>
  ${s.spotPolicy === 'keepListed' ? `<div class="row"><label>保留这些</label>${txt('keepSpots', '专色名，用逗号分隔')}</div>` : ''}
  ${spots.length ? `<div class="list">${spots.map((o) => `<div class="item"><span class="sw" style="background:${engine ? engine.proofHex(o.spot!.alt) : o.hex}"></span><span class="grow">${esc(o.spot!.name)}</span><span class="muted">${o.spot!.tint}% · 来自 ${o.hex}</span></div>`).join('')}</div>` : `<p class="hint">还没有专色。在“颜色”页点击某个颜色，选择“专色”即可添加。</p>`}
  <h3>刀版与特殊工艺</h3>
  <div class="row">${seg('dielineMode', [['off', '关闭'], ['auto', '按图层名识别'], ['manual', '手动指定']])}</div>
  ${
    s.dielineMode === 'auto'
      ? `<p class="hint">图层名以下面关键词开头的图层，会单独输出成对应的专色分版，并自动叠印。刀线、折线、压痕、打孔会输出成真正的单线路径（切割机只切一刀）：</p>
  <div class="list">${DIELINE_KEYWORDS.map((d) => `<div class="item"><span class="mono" style="width:110px">${d.spot}</span><span class="muted grow" data-notr>${d.key.source.replace(/^\^\\\[\?\\s\*\(/, '').replace(/\)$/, '').replace(/\|/g, ' / ').replace(/\.\?/g, ' ')}</span></div>`).join('')}</div>`
      : s.dielineMode === 'manual'
        ? `<div class="row"><label>专色名</label>${txt('dielineNames', '例如 CutContour, Kiss Cut')}</div><p class="hint">图层名以这些名字开头的图层，会输出为同名专色分版（叠印）。</p>`
        : `<p class="hint">做包装、贴纸、异形卡片时开启：刀版、折线、烫金、UV、白墨等会各自成为单独的专色版。</p>`
  }
  ${fin.length ? `<p class="hint">按颜色指定的工艺：</p><div class="list">${fin.map(([hex, sp]) => `<div class="item"><span class="sw" style="background:${hex}"></span><span class="mono">${hex}</span><span class="grow">→ ${esc(sp)}</span></div>`).join('')}</div>` : ''}
  <div class="row"><label>刀版输出</label>${sel('dielineFile', [['inline', '和设计稿在同一个文件'], ['separate', '单独一个刀版 PDF'], ['both', '两种都要']])}</div>
  <h3>纸盒刀版生成</h3>
  <div class="row"><label>盒型</label>${seg('box.style', [['ste', '插舌盒'], ['tray', '托盘盒'], ['mailer', '飞机盒']])}</div>
  <div class="grid3"><label>长${num('box.w', { min: 10, w: 56 })}</label><label>宽${num('box.d', { min: 10, w: 56 })}</label><label>高${num('box.h', { min: 5, w: 56 })}</label></div>
  <div class="row"><span class="muted grow">单位 mm，内尺寸。生成后刀线为实线、折线为虚线，图层名已按规则命名。</span><button class="btn" data-act="box">生成刀版</button></div>
  <p class="hint">当前：${b.w}×${b.d}×${b.h}mm</p>`;
}

function viewTools() {
  const s = S.settings;
  const m = S.measure;
  const pickHex = engine ? engine.proofHex(s.pick) : '#ccc';
  const sizeRows = m.length
    ? m
        .slice(0, 6)
        .map(
          (n) => `<div class="card"><div class="row"><b class="grow" data-notr>${esc(n.name)}</b><span class="muted">${n.type}</span></div>
      <div class="grid2"><div class="row"><label>宽</label><input type="number" step="any" data-act="mz" data-id="${n.id}" data-k="w" value="${toUnit((n.w * 25.4) / 72)}" style="width:70px">${U()}</div>
      <div class="row"><label>高</label><input type="number" step="any" data-act="mz" data-id="${n.id}" data-k="h" value="${toUnit((n.h * 25.4) / 72)}" style="width:70px">${U()}</div>
      ${n.fontSize !== undefined ? `<div class="row"><label>字号</label><input type="number" step="0.5" data-act="mz" data-id="${n.id}" data-k="fontSize" value="${n.fontSize}" style="width:70px"><span class="unit">pt</span></div>` : ''}
      ${n.strokeWeight !== undefined ? `<div class="row"><label>描边</label><input type="number" step="0.05" data-act="mz" data-id="${n.id}" data-k="strokeWeight" value="${n.strokeWeight}" style="width:70px"><span class="unit">pt</span></div>` : ''}
      ${n.cornerRadius !== undefined ? `<div class="row"><label>圆角</label><input type="number" step="any" data-act="mz" data-id="${n.id}" data-k="cornerRadius" value="${toUnit((n.cornerRadius * 25.4) / 72)}" style="width:70px">${U()}</div>` : ''}</div>
      ${n.hasImage ? `<div class="row"><button class="btn small" data-act="replace-image" data-v="${n.id}">替换图片（保留裁切）</button><button class="btn small" data-act="upscale" data-v="${n.id}">图片放大 2 倍</button></div>` : ''}</div>`,
        )
        .join('')
    : `<p class="hint">在画布上选中任意图层，这里会显示它的实际尺寸（${UNIT_NAMES[s.unit]}），可以直接改。</p>`;
  return `
  <h3>实物尺寸<span class="sp"></span>${seg('unit', [['mm', 'mm'], ['cm', 'cm'], ['in', 'in'], ['pt', 'pt']])}</h3>
  ${chk('keepRatio' as any, '改宽或高时保持比例')}
  ${sizeRows}
  <h3>按 CMYK 数值上色</h3>
  <div class="row"><span class="sw" style="background:${pickHex};width:36px;height:36px"></span><div class="grid4 grow">${(['c', 'm', 'y', 'k'] as const).map((k) => `<label>${k.toUpperCase()}${num('pick.' + k, { min: 0, max: 100, w: 50 })}</label>`).join('')}</div></div>
  <div class="row"><button class="btn" data-act="pick-apply" data-v="fill">填充所选</button><button class="btn" data-act="pick-apply" data-v="stroke">描边所选</button><span class="muted">导出时按这组 CMYK 精确输出</span></div>
  <h3>色卡标注</h3>
  <div class="chips">${chk('label.hex', 'HEX')}${chk('label.rgb', 'RGB')}${chk('label.cmyk', 'CMYK')}${chk('label.spot', '专色名')}${chk('label.names', '样式名')}</div>
  <div class="row"><button class="btn" data-act="labels">为所选色块生成标注</button><span class="muted">重复运行会更新，不会重叠</span></div>
  <h3>页码</h3>
  <div class="grid2">
    <div class="row"><label>格式</label><span data-notr style="flex:1;display:flex">${sel('pageNum.format', [['{n}', '1'], ['{n} / {total}', '1 / 12'], ['- {n} -', '- 1 -'], ['P{n}', 'P1'], ['Page {n}', 'Page 1'], ['第 {n} 页', '第 1 页'], ['{n} ページ', '1 ページ'], ['{n} 페이지', '1 페이지'], ['Página {n}', 'Página 1'], ['Seite {n}', 'Seite 1']])}</span></div>
    <div class="row"><label>起始</label>${num('pageNum.start', { min: 0, w: 56 })}</div>
    <div class="row"><label>跳过前</label>${num('pageNum.skip', { min: 0, w: 56 })}<span class="unit">页（封面）</span></div>
    <div class="row"><label>位置</label>${sel('pageNum.position', [['outer', '外侧角'], ['center', '底部居中']])}</div>
  </div>
  ${chk('pageNum.create', '没有名为「页码」的文字图层时自动添加')}
  <div class="row"><button class="btn" data-act="page-numbers">按导出页顺序编页码</button></div>
  <h3>画板尺寸修正</h3>
  <p class="hint">按“300 DPI 像素”做的画板（例如 A4 做成 2480×3508），一键缩回实际尺寸，图片清晰度不变。</p>
  <div class="row"><label>原来按</label><select id="rescale-dpi"><option>300</option><option>150</option><option>200</option><option>350</option><option>600</option></select><span class="unit">DPI</span><button class="btn" data-act="rescale">缩回实际尺寸</button></div>
  <input type="file" id="file-image" accept="image/png,image/jpeg,image/webp" hidden>`;
}

function viewExport() {
  const s = S.settings;
  const frames = S.order.map((id) => S.frames.find((f) => f.id === id)).filter(Boolean) as FrameInfo[];
  const noBleed = frames.filter((f) => !f.meta).length;
  const r = S.lastResult;
  const isPdf = s.format === 'pdf';
  const imp = s.imp;
  return `
  <h3>页面<span class="sp"></span><span class="muted">${frames.length} 页 · 拖动调整顺序</span></h3>
  ${
    frames.length
      ? `<div class="list" id="page-list">${frames
          .map(
            (f, i) => `<div class="item" draggable="true" data-drag="${i}"><span class="muted mono" style="width:16px">${i + 1}</span>${S.thumbs[f.id] ? `<img class="thumb" data-thumb="${esc(f.id)}" src="${S.thumbs[f.id]}">` : '<span class="thumb"></span>'}<span class="grow click" data-act="select" data-v="${f.id}" style="cursor:pointer" data-notr>${esc(f.name)}</span>${
              f.meta ? `<span class="badge b-ok">出血</span>` : `<span class="badge b-info">${s.autoBleed && s.bleedMm ? '自动出血' : '无出血'}</span>`
            }<span class="order"><button data-act="up" data-v="${i}">▲</button><button data-act="down" data-v="${i}">▼</button></span></div>`,
          )
          .join('')}</div>`
      : `<div class="empty">请在画布上选择要导出的画板、编组或分区</div>`
  }
  <div class="row"><label>格式</label>${seg('format', [['pdf', 'PDF'], ['tiff', 'TIFF'], ['jpeg', 'JPEG'], ['png', 'PNG']])}</div>
  ${!isPdf ? `<div class="row"><label>分辨率</label>${sel('rasterDpi', [[150, '150 dpi'], [300, '300 dpi（标准印刷）'], [600, '600 dpi（细线、条码）'], [1200, '1200 dpi']], 'num')}</div><p class="hint">${s.format === 'png' ? 'PNG 只能是 RGB，适合数码快印。' : `${s.mode === 'cmyk' ? 'CMYK' : s.mode === 'gray' ? '灰度' : 'RGB'} 位图，内嵌 ICC 和 DPI，文字和矢量会变成像素。`}</p>` : ''}
  <div class="row"><label>文件</label>${seg('output', [['merged', isPdf ? '合并为一个文件' : '打包下载'], ['separate', '每页单独文件']])}</div>
  <div class="row"><label>文件名</label><span data-notr style="flex:1;display:flex">${txt('title', S.fileName || '印刷文件')}</span></div>
  <h3>出血与印刷标记</h3>
  <div class="row"><label>出血</label>${s.bleedSidesOn ? sides4('bleedSides') : `${num('bleedMm', { min: 0, max: 20, step: 0.5, unit: true })}${U()}`}</div>
  <div class="row"><label></label>${chk('bleedSidesOn', '四边出血不同')}</div>
  ${(() => {
    const req = s.bleedSidesOn ? s.bleedSides : uniform(s.bleedMm);
    const short = S.frames.filter((f) => {
      if (!f.meta) return false;
      const b = f.meta.bleedSides || uniform(f.meta.bleed);
      return req.t > b.t + 0.01 || req.r > b.r + 0.01 || req.b > b.b + 0.01 || req.l > b.l + 0.01;
    });
    return short.length
      ? `<div class="card" style="border-color:var(--warn)"><span style="color:var(--warn)">${short.length} 个画板做的出血比这里设置的少，导出时只能按画板实际的出血输出。</span><div class="row" style="margin-bottom:0"><button class="btn small" data-act="convert-frames">为这些画板补足出血</button></div></div>`
      : '';
  })()}
  ${noBleed ? chk('autoBleed', `没有出血的 ${noBleed} 个画板：自动把贴边元素延伸到出血区`, '（只影响导出，不改设计稿）') : ''}
  ${isPdf ? `${chk('cropMarks', '裁切线')}${chk('regMarks', '套准标记')}${s.mode !== 'rgb' ? chk('colorBars', '色标条') : ''}${chk('trimLine', '成品框线', '（在裁切位置画一圈细线，校对用）')}
  <div class="row"><label>标记线宽</label>${num('markWeight', { min: 0.1, max: 1, step: 0.05 })}<span class="unit">pt</span></div>` : ''}
  ${
    isPdf
      ? `<h3>拼版</h3>
  <div class="row">${sel('imp.kind', [['none', '不拼版（一页一个成品）'], ['spreads', '对页跨页（画册校对）'], ['booklet', '骑马钉画册（自动排页）'], ['nup', '一版多拼（名片、贴纸、卡片）'], ['duplex', '正反面拼版（双面卡片）']])}</div>
  ${imp.kind === 'booklet' ? `<div class="row"><label>翻页方向</label>${seg('imp.rtl', [[false, '从左往右'], [true, '从右往左（竖排 / 阿拉伯文）']])}</div><p class="hint">页数会补齐到 4 的倍数（空白页），按折页顺序排成正反面，双面打印后对折装订即可。</p>` : ''}
  ${
    imp.kind === 'nup' || imp.kind === 'duplex'
      ? `<div class="row"><label>印刷纸张</label>${sel('imp.sheet', [...SHEET_PRESETS.map((p) => [p.id, p.name] as [string, string]), ['custom', '自定义']])}</div>
  ${imp.sheet === 'custom' ? `<div class="grid2"><div class="row"><label>纸宽</label>${num('imp.sheetW', { min: 50, unit: true })}${U()}</div><div class="row"><label>纸高</label>${num('imp.sheetH', { min: 50, unit: true })}${U()}</div></div>` : ''}
  <div class="grid2">
    <div class="row"><label>列 × 行</label>${num('imp.cols', { min: 0, w: 46 })}×${num('imp.rows', { min: 0, w: 46 })}</div>
    <div class="row"><label>间距</label>${num('imp.gutter', { min: 0, step: 0.5, unit: true })}${U()}</div>
    <div class="row"><label>印数</label>${num('imp.copies', { min: 1 })}<span class="unit">份</span></div>
  </div>
  ${imp.kind === 'nup' ? chk('imp.repeat', '同一个成品铺满整版', '（关闭则按页序依次排）') : '<p class="hint">第 1、3、5… 页为正面，2、4、6… 页为反面；反面自动左右镜像，长边翻转后与正面对齐。</p>'}
  <p class="hint">列和行填 0 表示按纸张自动排满。</p>`
      : ''
  }
  <h3>颜色标准</h3>
  <div class="row"><label>PDF 标准</label>${s.mode === 'rgb' ? '<span class="muted">RGB 模式不适用 PDF/X</span>' : sel('pdfx', [['x4', 'PDF/X-4（推荐，支持透明）'], ['x1a', 'PDF/X-1a（老设备、报纸常用）'], ['x3', 'PDF/X-3'], ['none', '普通 PDF']])}</div>
  ${(s.pdfx === 'x1a' || s.pdfx === 'x3') && s.mode !== 'rgb' ? `<div class="row"><label>透明拼合</label>${sel('flattenDpi', [[300, '300 dpi'], [450, '450 dpi'], [600, '600 dpi（小字更清晰）']], 'num')}</div><p class="hint">X-1a / X-3 不允许透明。含阴影、半透明、混合模式的页面会整页转成图像，其余页面保持矢量。</p>` : ''}`
      : ''
  }
  <h3>图片</h3>
  <div class="row"><label>压缩</label>${seg('compression', [['light', '轻度'], ['balanced', '均衡'], ['strong', '强力'], ['custom', '自定义']])}</div>
  ${
    s.compression === 'custom'
      ? `<div class="row"><label>降采样</label>${sel('maxPpi', [[0, '不降采样'], [300, '超过 450ppi 降到 300ppi'], [450, '超过 675ppi 降到 450ppi'], [600, '超过 900ppi 降到 600ppi']], 'num')}</div>
  <div class="row"><label>编码</label>${sel('imageCompression', [['auto', '自动（照片 JPEG，图形无损）'], ['jpeg', '全部 JPEG'], ['lossless', '全部无损']])}</div>
  ${s.imageCompression !== 'lossless' ? `<div class="row"><label>JPEG 质量</label>${num('jpegQuality', { min: 50, max: 100 })}</div>` : ''}`
      : `<p class="hint">${{ light: '图片几乎不压缩，质量最高', balanced: 'JPEG 90，超过 675ppi 的图片降到 450ppi', strong: 'JPEG 80，图片统一降到 300ppi，文件最小' }[s.compression]}</p>`
  }
  ${
    isPdf
      ? `<h3>自动修复</h3>
  ${chk('minStrokeOn', `细线自动加粗到 ${s.minStrokePt}pt`)}
  ${s.mode === 'cmyk' ? chk('overprintBlack', '100% 黑色自动叠印', '（防止黑字周围露白）') : ''}
  ${s.mode === 'cmyk' ? chk('removeWhiteOverprint', '去掉白色对象的叠印', '（否则白色会消失）') : ''}
  <h3>文档信息</h3>
  <div class="row"><label>作者</label>${txt('author')}</div>
  <div class="row"><label>主题</label>${txt('subject')}</div>
  <div class="row"><label>关键词</label>${txt('keywords', '用逗号分隔')}</div>
  ${chk('bookmarks', '为每页添加书签')}
  ${s.pdfx === 'none' || s.mode === 'rgb' ? chk('keepLinks', '保留超链接') : ''}
  ${s.mode !== 'rgb' ? chk('alsoDigital', '同时导出一份 RGB 屏幕版', '（无出血、无标记，适合发给客户看）') : ''}
  <div class="row"><label>输出缩放</label>${num('scalePct', { min: 10, max: 1000, step: 5 })}<span class="unit">%</span></div>
  ${
    s.pdfx === 'none' || s.mode === 'rgb'
      ? `<div class="row"><label>打开密码</label><input type="text" id="pdf-password" value="${esc(S.password)}" placeholder="留空则不加密"></div><p class="hint">AES-256 加密。密码不会被保存。</p>`
      : `<p class="hint">PDF/X 标准不允许加密；需要密码请把“PDF 标准”切换为普通 PDF。</p>`
  }`
      : ''
  }
  <h3>导出预设</h3>
  <div class="row"><input type="text" id="preset-name" placeholder="例如：某某印刷厂 · 铜版纸"><button class="btn small" data-act="save-preset">保存当前设置</button></div>
  ${S.presets.length ? `<div class="chips">${S.presets.map((p, i) => `<span class="pill" style="display:inline-flex;gap:4px;align-items:center"><a href="#" data-act="load-preset" data-v="${i}">${esc(p.name)}</a><a href="#" data-act="del-preset" data-v="${i}" title="删除">×</a></span>`).join('')}</div>` : ''}
  <div class="row"><button class="btn small" data-act="export-json">导出预设和颜色映射（JSON）</button><button class="btn small" data-act="import-json">导入</button></div>
  ${
    r
      ? `<h3>上次导出结果</h3><div class="card report"><ul style="margin:0;padding-left:16px">${r.reports
          .map((p) => {
            const seg: string[] = [];
            if (p.flattened) seg.push('<span style="color:var(--warn)">已整页拼合为图像</span>');
            else if (p.remainingRgb === 0 || s.mode === 'rgb') seg.push('<span style="color:var(--ok)">颜色已全部转换</span>');
            else seg.push(`<span style="color:var(--warn)">还有 ${p.remainingRgb} 处保持 RGB</span>`);
            if (p.images.length) seg.push(`<span>图片 ${p.images.length} 张</span>`);
            const down = p.images.filter((i) => i.newW).length;
            if (down) seg.push(`<span>${down} 张已降采样</span>`);
            if (p.hairlinesFixed) seg.push(`<span>加粗细线 ${p.hairlinesFixed} 处</span>`);
            if (p.spotsUsed.length) seg.push(`<span>专色：</span><span data-notr>${p.spotsUsed.map(esc).join(', ')}</span>`);
            for (const l of p.leftovers) seg.push(`<span style="color:var(--warn)">${esc(l)}</span>`);
            return `<li><b data-notr>${esc(p.page)}</b> · ${seg.join(' · ')}</li>`;
          })
          .join('')}</ul><p class="hint" style="margin-bottom:0">共 ${r.files.length} 个文件。</p></div>`
      : ''
  }`;
}

function renderPills() {
  const s = S.settings;
  const p: string[] = [];
  p.push(s.format.toUpperCase());
  if (s.mode === 'cmyk') {
    p.push('CMYK');
    p.push(currentProfile()?.name || '⚠ 未选 ICC');
    p.push(['可感知', '相对比色', '饱和度', '绝对比色'][s.intent]);
    if (s.tacLimit) p.push(`TAC ${s.tacLimit}%`);
  } else p.push(s.mode === 'rgb' ? 'RGB' : '灰度');
  if (s.format === 'pdf' && s.mode !== 'rgb' && s.pdfx !== 'none') p.push({ x4: 'PDF/X-4', x1a: 'PDF/X-1a', x3: 'PDF/X-3' }[s.pdfx]);
  p.push(s.bleedSidesOn ? '四边出血' : `出血 ${s.bleedMm}mm`);
  if (s.format === 'pdf') {
    if (s.cropMarks) p.push('裁切线');
    if (s.imp.kind !== 'none') p.push({ spreads: '跨页', booklet: '骑马钉', nup: '一版多拼', duplex: '正反面' }[s.imp.kind]);
    if (s.minStrokeOn) p.push(`细线≥${s.minStrokePt}pt`);
    if (s.mode === 'cmyk' && s.overprintBlack) p.push('黑色叠印');
  } else p.push(`${s.rasterDpi}dpi`);
  const spots = Object.values(s.overrides).filter((o) => o.spot).length;
  if (spots && s.mode === 'cmyk') p.push(`${spots} 个专色`);
  if (s.activeMap) p.push(`映射：${s.activeMap}`);
  if (s.dielineMode !== 'off' || Object.keys(s.colorFinishing).length) p.push('刀版');
  if (s.richBlackOn) p.push('四色黑');
  if (S.password && s.format === 'pdf' && (s.pdfx === 'none' || s.mode === 'rgb')) p.push('🔒 加密');
  if (s.alsoDigital && s.format === 'pdf' && s.mode !== 'rgb') p.push('+屏幕版');
  $('pills').innerHTML = p.map((x) => `<span class="pill">${esc(x)}</span>`).join('');
  ($('go') as HTMLButtonElement).disabled = !S.frames.length || S.busy;
  $('go').textContent = S.frames.length > 1 ? `导出 ${S.frames.length} 页` : '导出';
  translateDom(document.querySelector('footer')!);
}

// ---------------- actions ----------------

function setOverride(hex: string, fn: (o: ColorOverride) => ColorOverride | null) {
  const cur = S.settings.overrides[hex] || { hex };
  const next = fn(structuredClone(cur));
  if (!next || (!next.cmyk && !next.spot && !next.overprint)) delete S.settings.overrides[hex];
  else S.settings.overrides[hex] = next;
  saveSettings();
  refreshEngine();
}

function nearestSpot(hex: string): LibSwatch | null {
  if (!engine || !S.lib.length) return null;
  const [r, g, b] = hexToRgb(hex);
  const target = engine.rgbToLab(r, g, b);
  let best: LibSwatch | null = null;
  let bd = Infinity;
  for (const sw of S.lib) {
    const lab = sw.cmyk ? engine.cmykToLab(sw.cmyk) : sw.hex ? engine.rgbToLab(...hexToRgb(sw.hex)) : null;
    if (!lab) continue;
    const d = Math.hypot(lab[0] - target[0], lab[1] - target[1], lab[2] - target[2]);
    if (d < bd) {
      bd = d;
      best = sw;
    }
  }
  return best;
}

async function pickFile(accept: string): Promise<File | null> {
  return new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = () => res(inp.files?.[0] || null);
    inp.click();
  });
}

async function upscale(id: string) {
  busy(true, '放大图片…');
  try {
    const m = await request<{ bytes: Uint8Array | null }>('get-image', { id }, 'image-bytes');
    if (!m.bytes) throw new Error('这个图层没有图片');
    const type = m.bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
    const bmp = await createImageBitmap(new Blob([m.bytes as BlobPart], { type }));
    if (bmp.width * 2 > 8000 || bmp.height * 2 > 8000) throw new Error('图片已经很大，不需要再放大');
    const cv = document.createElement('canvas');
    cv.width = bmp.width * 2;
    cv.height = bmp.height * 2;
    const g = cv.getContext('2d')!;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob: Blob = await new Promise((r) => cv.toBlob((b) => r(b!), type === 'image/png' ? 'image/png' : 'image/jpeg', 0.95));
    post('set-image', { id, bytes: new Uint8Array(await blob.arrayBuffer()) });
    notify(`图片已放大到 ${cv.width}×${cv.height}（细节不会凭空增加，但能减少锯齿）`);
  } catch (e: any) {
    notify(e.message || String(e), true);
  } finally {
    busy(false);
  }
}

document.addEventListener('click', async (ev) => {
  const el = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!el) return;
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return; // handled by change events
  if ((ev.target as HTMLElement).closest('[data-stop]') && el.dataset.act === 'expand') return;
  const act = el.dataset.act!;
  const v = el.dataset.v!;
  if (el.tagName === 'A') ev.preventDefault();
  const s = S.settings;
  switch (act) {
    case 'tab':
      S.tab = v as Tab;
      render();
      if (S.tab === 'color' && !S.colors && S.frames.length) post('scan-colors');
      if (S.tab === 'text' && !S.texts && S.frames.length) post('scan-text');
      if (S.tab === 'export' && S.frames.length) post('thumbs', { ids: S.frames.map((f) => f.id) });
      break;
    case 'seg':
      update(el.dataset.path!, JSON.parse(v));
      break;
    case 'select':
      post('select-node', { id: v });
      break;
    case 'create-doc': {
      const d = s.doc;
      post('create-doc', { opts: { name: d.name, trimW: d.w, trimH: d.h, bleed: d.sidesOn ? d.sides : uniform(d.bleed), margin: d.margin, safety: d.safety, pages: d.pages, facing: d.facing, fold: d.fold, scale: d.scale } });
      break;
    }
    case 'save-paper': {
      const name = `${s.doc.w}×${s.doc.h}mm`;
      if (!s.customPapers.some((p) => p.w === s.doc.w && p.h === s.doc.h)) s.customPapers.push({ name, w: s.doc.w, h: s.doc.h });
      s.doc.preset = 'custom:' + s.customPapers.findIndex((p) => p.w === s.doc.w && p.h === s.doc.h);
      saveSettings();
      render();
      notify(`已保存常用尺寸 ${name}`);
      break;
    }
    case 'csv-template':
      download('画板尺寸模板.csv', new TextEncoder().encode('﻿名称,宽,高,出血,页数\n名片,90,54,3,2\n海报,420,570,3,1\n'), 'text/csv');
      break;
    case 'csv-import': {
      const f = await pickFile('.csv,text/csv');
      if (!f) return;
      const rows = (await f.text())
        .split(/\r?\n/)
        .map((l) => l.replace(/^﻿/, '').split(/[,\t;]/).map((x) => x.trim()))
        .filter((c) => c.length >= 3 && !isNaN(+c[1]) && !isNaN(+c[2]))
        .map((c) => ({ name: c[0] || '印刷文档', trimW: fromUnit(+c[1]), trimH: fromUnit(+c[2]), bleed: c[3] ? fromUnit(+c[3]) : undefined, pages: c[4] ? +c[4] : 1 }));
      if (!rows.length) return notify('CSV 里没有找到有效的尺寸行', true);
      post('csv-frames', { rows, base: { margin: s.doc.margin, safety: s.doc.safety, facing: false, fold: 'none', bleed: uniform(s.doc.bleed), pages: 1 } });
      break;
    }
    case 'convert-frames':
      post('convert-frames', { bleed: s.bleedSidesOn ? s.bleedSides : uniform(s.bleedMm), extend: true });
      break;
    case 'scan-colors':
      post('scan-colors');
      break;
    case 'scan-text':
      post('scan-text');
      break;
    case 'expand':
      S.expanded = S.expanded === v ? '' : v;
      render();
      break;
    case 'ckind': {
      const hex = el.dataset.hex!;
      const [r, g, b] = hexToRgb(hex);
      const icc = engine ? engine.iccCmyk(r, g, b) : { c: 0, m: 0, y: 0, k: 0 };
      if (v === 'finish') {
        s.colorFinishing[hex] = s.colorFinishing[hex] || 'CutContour';
        delete s.overrides[hex];
        saveSettings();
        refreshEngine();
        break;
      }
      delete s.colorFinishing[hex];
      setOverride(hex, (o) => {
        if (v === 'icc') return { hex, overprint: o.overprint };
        if (v === 'custom') return { hex, overprint: o.overprint, cmyk: o.cmyk || o.spot?.alt || icc };
        return { hex, overprint: o.overprint, spot: o.spot || { name: 'PANTONE ', tint: 100, alt: o.cmyk || icc } };
      });
      break;
    }
    case 'nearest-spot': {
      const hex = el.dataset.hex!;
      const sw = nearestSpot(hex);
      if (!sw) return;
      setOverride(hex, (o) => ({ ...o, spot: { name: sw.name, tint: 100, alt: sw.cmyk || o.spot?.alt || { c: 0, m: 0, y: 0, k: 0 } } }));
      notify(`最接近的是 ${sw.name}`);
      break;
    }
    case 'reset-color':
      delete s.colorFinishing[el.dataset.hex!];
      setOverride(el.dataset.hex!, () => null);
      break;
    case 'tmode':
      post('set-text-mode', { ids: [v], mode: el.dataset.m });
      break;
    case 'tall': {
      const t = S.texts || [];
      const outline = t.filter((n) => v === 'outline' || (v === 'live-noeff' && n.hasEffects)).map((n) => n.id);
      const live = t.filter((n) => !outline.includes(n.id)).map((n) => n.id);
      if (outline.length) post('set-text-mode', { ids: outline, mode: 'outline' });
      if (live.length) post('set-text-mode', { ids: live, mode: 'live' });
      break;
    }
    case 'preflight':
      runPreflight();
      break;
    case 'fix-k100':
      setOverride(v, (o) => ({ ...o, cmyk: { c: 0, m: 0, y: 0, k: 100 }, spot: undefined }));
      S.issues = (S.issues || []).filter((i) => i.fix !== 'k100:' + v);
      notify(`${v} 已改为单色黑 K100 输出`);
      break;
    case 'upscale':
      await upscale(v);
      break;
    case 'replace-image': {
      const f = await pickFile('image/png,image/jpeg,image/webp');
      if (!f) return;
      post('set-image', { id: v, bytes: new Uint8Array(await f.arrayBuffer()) });
      break;
    }
    case 'import-icc':
      ($('file-icc') as HTMLInputElement).click();
      break;
    case 'del-icc': {
      const id = s.iccId;
      S.profiles = S.profiles.filter((p) => p.id !== id);
      post('store-delete', { key: 'pk_icc_' + id });
      post('store-set', { key: 'pk_icc_list', value: S.profiles });
      s.iccId = S.profiles[0]?.id || '';
      saveSettings();
      refreshEngine();
      break;
    }
    case 'import-lib': {
      const f = await pickFile('.ase,.csv,.txt');
      if (!f) return;
      try {
        const lib = f.name.toLowerCase().endsWith('.ase') ? parseAse(await f.arrayBuffer()) : parseSwatchCsv(await f.text());
        S.lib = [...S.lib.filter((x) => !lib.some((y) => y.name === x.name)), ...lib];
        post('store-set', { key: 'pk_spotlib', value: S.lib });
        notify(`已导入 ${lib.length} 个色板`);
        render();
      } catch (e: any) {
        notify(e.message, true);
      }
      break;
    }
    case 'clear-lib':
      S.lib = [];
      post('store-set', { key: 'pk_spotlib', value: [] });
      render();
      break;
    case 'save-map': {
      const name = ($('map-name') as HTMLInputElement).value.trim();
      if (!name) return notify('请先填写映射表名称', true);
      const entry: ColorMap = { name, overrides: structuredClone(s.overrides), finishing: structuredClone(s.colorFinishing) };
      if (s.mapsInFile) {
        S.fileMaps = [...S.fileMaps.filter((m) => m.name !== name), entry];
        post('file-maps-set', { maps: S.fileMaps });
      } else {
        S.maps = [...S.maps.filter((m) => m.name !== name), entry];
        post('store-set', { key: 'pk_maps', value: S.maps });
      }
      s.activeMap = name;
      saveSettings();
      render();
      notify(`颜色映射表「${name}」已保存${s.mapsInFile ? '到当前文件' : ''}`);
      break;
    }
    case 'del-map':
      S.maps = S.maps.filter((m) => m.name !== s.activeMap);
      S.fileMaps = S.fileMaps.filter((m) => m.name !== s.activeMap);
      post('store-set', { key: 'pk_maps', value: S.maps });
      post('file-maps-set', { maps: S.fileMaps });
      s.activeMap = '';
      saveSettings();
      render();
      break;
    case 'up':
    case 'down': {
      const i = +v;
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= S.order.length) return;
      [S.order[i], S.order[j]] = [S.order[j], S.order[i]];
      render();
      break;
    }
    case 'save-preset': {
      const name = ($('preset-name') as HTMLInputElement).value.trim();
      if (!name) return notify('请先填写预设名称', true);
      const { overrides, colorFinishing, activeMap, doc, customPapers, title, pick, ...rest } = s;
      void overrides; void colorFinishing; void activeMap; void doc; void customPapers; void title; void pick;
      S.presets = [...S.presets.filter((p) => p.name !== name), { name, settings: rest }];
      post('store-set', { key: 'pk_presets', value: S.presets });
      render();
      break;
    }
    case 'load-preset': {
      const p = S.presets[+v];
      if (!p) return;
      deepMerge(s, p.settings);
      saveSettings();
      refreshEngine();
      notify(`已套用预设「${p.name}」`);
      break;
    }
    case 'del-preset':
      S.presets.splice(+v, 1);
      post('store-set', { key: 'pk_presets', value: S.presets });
      render();
      break;
    case 'export-json':
      download('PressKit 预设与颜色映射.json', new TextEncoder().encode(JSON.stringify({ presets: S.presets, maps: allMaps().map(({ file: _f, ...m }) => m) }, null, 2)), 'application/json');
      break;
    case 'import-json': {
      const f = await pickFile('.json,application/json');
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (Array.isArray(j.presets)) S.presets = [...S.presets.filter((p) => !j.presets.some((q: ExportPreset) => q.name === p.name)), ...j.presets];
        if (Array.isArray(j.maps)) S.maps = [...S.maps.filter((m) => !j.maps.some((q: ColorMap) => q.name === m.name)), ...j.maps];
        post('store-set', { key: 'pk_presets', value: S.presets });
        post('store-set', { key: 'pk_maps', value: S.maps });
        notify(`已导入 ${j.presets?.length || 0} 个预设、${j.maps?.length || 0} 个颜色映射表`);
        render();
      } catch {
        notify('不是有效的 PressKit JSON 文件', true);
      }
      break;
    }
    case 'render-preview': {
      const id = S.order[0];
      if (!id) return notify('请先选择画板', true);
      busy(true, '生成预览…');
      try {
        const m = await request<{ id: string; name: string; png: Uint8Array }>('render', { id, maxPx: 900 }, 'rendered');
        S.preview = { id: m.id, name: m.name, src: await decodeToRgb(m.png), mode: S.preview?.mode || 'proof', paper: S.preview?.paper || false, split: 0.5 };
      } finally {
        busy(false);
      }
      render();
      break;
    }
    case 'pv-mode':
      if (S.preview) S.preview.mode = v as PreviewMode;
      render();
      break;
    case 'box':
      post('box-dieline', { opts: s.box });
      break;
    case 'pick-apply': {
      if (!engine) return;
      const hex = engine.proofHex(s.pick);
      // remember the exact recipe so export prints these CMYK values, not an ICC round-trip
      setOverride(hex, (o) => ({ ...o, cmyk: { ...s.pick }, spot: undefined }));
      post('apply-color', { hex, target: v });
      break;
    }
    case 'labels': {
      const m = await request<{ items: { id: string; hex: string }[] }>('swatch-info', {}, 'swatch-info');
      const L = s.label;
      const items = m.items.map((it) => {
        const [r, g, b] = hexToRgb(it.hex);
        const { c, kind } = cmykFor(it.hex);
        const ov = s.overrides[it.hex];
        const lines: string[] = [];
        const nm = S.colors?.find((x) => x.hex === it.hex)?.names?.[0];
        if (L.names && nm) lines.push(nm);
        if (L.spot && ov?.spot) lines.push(ov.spot.name);
        if (L.hex) lines.push(it.hex);
        if (L.rgb) lines.push(`RGB ${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)}`);
        if (L.cmyk && kind !== 'finish') lines.push(`CMYK ${fmtC(c).replace(/ \/ /g, ' ')}`);
        return { id: it.id, lines };
      });
      if (!items.length) return notify('请先选中纯色色块（或包含色块的画板）', true);
      post('swatch-labels', { items });
      break;
    }
    case 'page-numbers':
      post('page-numbers', { opts: { ids: S.order, ...s.pageNum } });
      break;
    case 'rescale':
      post('rescale-dpi', { dpi: +($('rescale-dpi') as HTMLSelectElement).value });
      break;
  }
});

document.addEventListener('change', (ev) => {
  inChange = true;
  try {
    onChange(ev);
  } finally {
    inChange = false;
  }
});

function onChange(ev: Event) {
  const el = ev.target as HTMLInputElement;
  const act = el.dataset.act;
  if (el.id === 'lang') {
    S.settings.lang = el.value as Lang;
    saveSettings();
    applyLang();
    render();
    return;
  }
  if (el.id === 'pdf-password') {
    S.password = el.value;
    renderPills();
    return;
  }
  if (el.dataset.bind) {
    const t = el.dataset.t;
    let v: any = t === 'bool' ? el.checked : t === 'num' ? Number(el.value) : el.value;
    if (el.dataset.u) v = +fromUnit(Number(el.value)).toFixed(3);
    update(el.dataset.bind, v);
    return;
  }
  const s = S.settings;
  if (act === 'preset') {
    const id = el.value;
    s.doc.preset = id;
    const p = id.startsWith('custom:') ? s.customPapers[+id.slice(7)] : PAPER_PRESETS.find((x) => x.id === id);
    if (p) {
      const [w, h] = s.doc.landscape ? [Math.max(p.w, p.h), Math.min(p.w, p.h)] : [p.w, p.h];
      s.doc.w = w;
      s.doc.h = h;
      if (!id.startsWith('custom')) s.doc.name = tr(`${(p as any).name} 印刷文档`);
      if (w * h > 1000 * 1400 && s.doc.scale === 1) s.doc.scale = 10;
    }
    saveSettings();
    render();
  } else if (act === 'load-map') {
    const m = allMaps().find((x) => x.name === el.value.replace(/（本文件）$/, ''));
    s.activeMap = m ? m.name : '';
    s.overrides = m ? structuredClone(m.overrides) : {};
    s.colorFinishing = m?.finishing ? structuredClone(m.finishing) : {};
    saveSettings();
    refreshEngine();
  } else if (act === 'cmyk') {
    const hex = el.dataset.hex!;
    const k = el.dataset.k as keyof CMYK;
    const val = Math.max(0, Math.min(100, Number(el.value)));
    setOverride(hex, (o) => {
      if (o.spot) o.spot.alt = { ...o.spot.alt, [k]: val };
      else o.cmyk = { ...(o.cmyk || { c: 0, m: 0, y: 0, k: 0 }), [k]: val };
      return o;
    });
  } else if (act === 'spotname') {
    const lib = S.lib.find((l) => l.name === el.value.trim());
    setOverride(el.dataset.hex!, (o) => {
      if (o.spot) {
        o.spot.name = el.value.trim() || 'Spot';
        if (lib?.cmyk) o.spot.alt = { ...lib.cmyk };
      }
      return o;
    });
  } else if (act === 'tint') {
    setOverride(el.dataset.hex!, (o) => {
      if (o.spot) o.spot.tint = Number(el.value);
      return o;
    });
  } else if (act === 'overprint') {
    setOverride(el.dataset.hex!, (o) => ({ ...o, overprint: el.checked }));
  } else if (act === 'finish-name') {
    s.colorFinishing[el.dataset.hex!] = el.value;
    saveSettings();
    render();
  } else if (act === 'pv-paper' && S.preview) {
    S.preview.paper = el.checked;
    S.preview.data = undefined;
    render();
  } else if (act === 'mz') {
    const k = el.dataset.k!;
    const val = Number(el.value);
    const px = (mmv: number) => (mmv * 72) / 25.4;
    const keepRatio = (s as any).keepRatio;
    const data: any = { ids: [el.dataset.id], keepRatio };
    if (k === 'w') data.w = px(fromUnit(val));
    if (k === 'h') data.h = px(fromUnit(val));
    if (k === 'fontSize') data.fontSize = val;
    if (k === 'strokeWeight') data.strokeWeight = val;
    if (k === 'cornerRadius') data.cornerRadius = px(fromUnit(val));
    post('resize-node', data);
  }
}

document.addEventListener('input', (ev) => {
  const el = ev.target as HTMLInputElement;
  if (el.dataset.act === 'pv-split' && S.preview) {
    S.preview.split = Number(el.value) / 100;
    paintPreview();
  }
});

// drag & drop page ordering
let dragFrom = -1;
document.addEventListener('dragstart', (ev) => {
  const el = (ev.target as HTMLElement).closest('[data-drag]') as HTMLElement | null;
  if (el) dragFrom = +el.dataset.drag!;
});
document.addEventListener('dragover', (ev) => {
  if ((ev.target as HTMLElement).closest('[data-drag]')) ev.preventDefault();
});
document.addEventListener('drop', (ev) => {
  const el = (ev.target as HTMLElement).closest('[data-drag]') as HTMLElement | null;
  if (!el || dragFrom < 0) return;
  ev.preventDefault();
  const to = +el.dataset.drag!;
  const [m] = S.order.splice(dragFrom, 1);
  S.order.splice(to, 0, m);
  dragFrom = -1;
  render();
});

$('file-icc').addEventListener('change', async (ev) => {
  const files = [...((ev.target as HTMLInputElement).files || [])];
  const l = await getLcms();
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    try {
      const info = ColorEngine.describeProfile(l, bytes);
      if (info.space !== 'CMYK') {
        notify(`「${f.name}」不是 CMYK 印刷配置文件（${info.space}），已跳过`, true);
        continue;
      }
      const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      profileBytes.set(id, bytes);
      post('store-set', { key: 'pk_icc_' + id, value: bytes });
      S.profiles.push({ id, name: info.name, size: bytes.byteLength });
      S.settings.iccId = id;
      notify(`已导入 ${info.name}`);
    } catch (e: any) {
      notify(`「${f.name}」${e.message}`, true);
    }
  }
  post('store-set', { key: 'pk_icc_list', value: S.profiles });
  (ev.target as HTMLInputElement).value = '';
  saveSettings();
  refreshEngine();
});

function preflightOpts() {
  const s = S.settings;
  return {
    minPpi: s.minPpi,
    minStrokePt: s.minStrokePt,
    minTextPt: s.minTextPt,
    pureBlackToK: s.pureBlackToK,
    dieline: { mode: s.dielineMode, manualNames: s.dielineNames.split(/[,，]/).map((x) => x.trim()).filter(Boolean) },
  };
}

function runPreflight() {
  post('scan-colors');
  post('preflight', { opts: preflightOpts() });
}

// ---------------- export ----------------

function busy(on: boolean, msg = '') {
  S.busy = on;
  $('overlay').classList.toggle('on', on);
  if (msg) $('ov-msg').textContent = tr(msg);
  if (!on) ($('ov-bar') as HTMLElement).style.width = '0';
  renderPills();
}
function progress(msg: string, frac: number) {
  $('ov-msg').textContent = tr(msg);
  ($('ov-bar') as HTMLElement).style.width = Math.round(frac * 100) + '%';
}

function download(name: string, bytes: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function finishingSpot(name: string) {
  const kw = DIELINE_KEYWORDS.find((d) => d.spot === name);
  const alt = kw ? kw.alt : [0, 100, 0, 0];
  return { name, tint: 100, alt: { c: alt[0], m: alt[1], y: alt[2], k: alt[3] } };
}

function impOption(): Imposition | undefined {
  const i = S.settings.imp;
  if (i.kind === 'none') return undefined;
  if (i.kind === 'spreads') return { kind: 'spreads' };
  if (i.kind === 'booklet') return { kind: 'booklet', rtl: i.rtl };
  const base = { sheetW: i.sheetW * MM, sheetH: i.sheetH * MM, rows: i.rows, cols: i.cols, gutter: i.gutter * MM, copies: Math.max(1, i.copies) };
  return i.kind === 'nup' ? { kind: 'nup', ...base, repeat: i.repeat } : { kind: 'duplex', ...base };
}

async function doExport() {
  const s = S.settings;
  if (!S.frames.length) return;
  busy(true, '准备导出…');
  try {
    if (s.blockLowPpi) {
      progress('检查图片分辨率…', 0.02);
      const res = await request<{ issues: Issue[] }>('preflight', { opts: preflightOpts() }, 'preflight');
      const low = res.issues.filter((i) => i.cat === 'resolution');
      if (low.length) {
        busy(false);
        S.tab = 'preflight';
        render();
        notify(`有 ${low.length} 张图片分辨率不足，已停止导出（可在“预检”页关闭此限制）`, true);
        return;
      }
    }
    const isPdf = s.format === 'pdf';
    const pdfx = s.mode === 'rgb' ? 'none' : s.pdfx;
    const res = await request<{ frames: ExportedFrame[] }>(
      'export',
      {
        req: {
          frameIds: S.order,
          bleedMm: s.bleedMm,
          bleedSides: s.bleedSidesOn ? s.bleedSides : undefined,
          autoBleed: s.autoBleed,
          dieline: preflightOpts().dieline,
          colorFinishing: s.mode === 'rgb' ? {} : s.colorFinishing,
          textOutline: s.textOutline,
          minStrokePt: s.minStrokeOn ? s.minStrokePt : 0,
          format: isPdf ? 'PDF' : 'PNG',
          pngDpi: s.rasterDpi,
          rasterDpi: isPdf && (pdfx === 'x1a' || pdfx === 'x3') ? s.flattenDpi : undefined,
        },
      },
      'exported',
    );
    const frames = res.frames;
    const l = await getLcms();
    const profile = s.mode === 'cmyk' ? await getProfile(s.iccId) : null;
    const title = s.title.trim() || S.fileName || '印刷文件';
    const safe = (x: string) => x.replace(/[\\/:*?"<>|]+/g, '_');
    let files: { name: string; bytes: Uint8Array }[] = [];

    if (!isPdf) {
      // raster output
      const eng = new ColorEngine(l, colorSettings());
      if (profile) eng.setOutputProfile(profile);
      const ext = { tiff: 'tif', jpeg: 'jpg', png: 'png' }[s.format as 'tiff' | 'jpeg' | 'png'];
      let i = 0;
      for (const f of frames) {
        progress(`生成位图：${f.name}`, 0.4 + (i++ / frames.length) * 0.6);
        files.push({ name: safe(f.name) + '.' + ext, bytes: await rasterExport(f.png!, eng, profile, { format: s.format as any, dpi: s.rasterDpi, quality: s.jpegQuality }) });
      }
      S.lastResult = { files, reports: [], usage: {} };
    } else {
      const jobs = frames.map((f) => ({
        name: f.name,
        pdf: f.pdf,
        trimW: f.trimW,
        trimH: f.trimH,
        srcBleed: f.srcBleed,
        scale: f.scale,
        sentinels: f.sentinels.map((x) => ({ hex: x.hex, spot: finishingSpot(x.spotName) })),
        vectorStrokes: f.vectorStrokes.map((v) => ({ spot: finishingSpot(v.spotName), weight: v.weight, dash: v.dash, paths: v.paths })),
        pageH: f.pageH,
        hairlinesFixed: f.hairlinesFixed,
        rasterPng: f.png,
        rasterDpi: s.flattenDpi,
      }));
      const common = {
        maxPpi: s.maxPpi,
        minStrokePt: s.minStrokeOn ? s.minStrokePt : 0,
        output: s.output,
        imageCompression: s.imageCompression,
        jpegQuality: s.jpegQuality,
        dielineFile: s.dielineFile,
      };
      const result = await runExport(
        l,
        profile,
        jobs,
        {
          ...common,
          color: colorSettings(),
          title,
          password: pdfx === 'none' ? S.password : '',
          compose: {
            bleed: s.bleedSidesOn ? { t: s.bleedSides.t * MM, r: s.bleedSides.r * MM, b: s.bleedSides.b * MM, l: s.bleedSides.l * MM } : s.bleedMm * MM,
            cropMarks: s.cropMarks,
            regMarks: s.regMarks,
            colorBars: s.colorBars,
            trimLine: s.trimLine,
            markWeight: s.markWeight,
            pdfx,
            keepLinks: s.keepLinks,
            bookmarks: s.bookmarks,
            author: s.author,
            subject: s.subject,
            keywords: s.keywords,
            imposition: impOption(),
            scale: s.scalePct / 100,
          },
        },
        (msg, frac) => progress(msg, 0.4 + frac * 0.5),
      );
      files = result.files;
      if (s.alsoDigital && s.mode !== 'rgb') {
        progress('生成屏幕版…', 0.95);
        const digital = await runExport(l, null, jobs.map((j) => ({ ...j, sentinels: [], vectorStrokes: [] })), {
          ...common,
          dielineFile: 'inline',
          color: { ...colorSettings(), mode: 'rgb' },
          title: title + ' 屏幕版',
          imageCompression: 'jpeg',
          jpegQuality: 85,
          maxPpi: 150,
          compose: { bleed: 0, cropMarks: false, regMarks: false, colorBars: false, markWeight: 0.25, pdfx: 'none', keepLinks: true, bookmarks: s.bookmarks, author: s.author, subject: s.subject, keywords: s.keywords },
        });
        files.push(...digital.files);
      }
      S.lastResult = result;
    }
    if (files.length === 1) download(files[0].name, files[0].bytes, isPdf ? 'application/pdf' : 'application/octet-stream');
    else download(safe(title) + '.zip', zip(files), 'application/zip');
    const kb = files.reduce((a, f) => a + f.bytes.length, 0) / 1024;
    const left = S.lastResult.reports.reduce((a, r) => a + r.remainingRgb, 0);
    notify(`导出完成：${files.length} 个文件，${kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB'}` + (left && s.mode !== 'rgb' ? `（${left} 处无法转换，详见导出页）` : ''));
    S.tab = 'export';
  } catch (e: any) {
    console.error(e);
    notify('导出失败：' + (e?.message || e), true);
  } finally {
    busy(false);
    render();
  }
}

$('go').addEventListener('click', doExport);

// dev aid: lets the test harness walk every view and list untranslated strings
(window as any).__pk = { S, render, update, missing, setLang: (l: Lang) => { S.settings.lang = l; applyLang(); render(); } };

render();
post('init');
