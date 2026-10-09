// Inkpaper UI (runs in the plugin iframe). Holds settings, runs the colour engine and the PDF pipeline.

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
import { tr, translateDom, setLang, detectLang, LANGS, missing, Lang } from '../i18n/i18n';

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
  doc: { kind: string; preset: string; w: number; h: number; landscape: boolean; bleed: number; sidesOn: boolean; sides: Sides; margin: number; safety: number; pages: number; facing: boolean; fold: 'none' | 'half' | 'tri' | 'z' | 'gate'; name: string; scale: number };
  label: { hex: boolean; rgb: boolean; cmyk: boolean; spot: boolean; names: boolean };
  pageNum: { format: string; start: number; skip: number; create: boolean; position: 'center' | 'outer' };
  box: { style: 'ste' | 'tray' | 'mailer'; w: number; d: number; h: number };
  pick: CMYK;
  onboarded: boolean;
  advancedOpen: boolean;
  profileId: string;
  profileBase: Record<string, any>;
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
  doc: { kind: 'book', preset: 'a4', w: 210, h: 297, landscape: false, bleed: 3, sidesOn: false, sides: { t: 3, r: 3, b: 3, l: 3 }, margin: 10, safety: 3, pages: 8, facing: true, fold: 'none', name: '画册', scale: 1 },
  label: { hex: true, rgb: true, cmyk: true, spot: true, names: true },
  pageNum: { format: '{n}', start: 1, skip: 0, create: true, position: 'outer' },
  box: { style: 'ste', w: 80, d: 40, h: 120 },
  pick: { c: 0, m: 100, y: 100, k: 0 },
  onboarded: false,
  advancedOpen: false,
  profileId: 'coated',
  profileBase: {},
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

type Route = 'welcome' | 'prepare' | 'check' | 'export';
type CheckTab = 'issues' | 'preview' | 'colors' | 'text';
type Sheet = '' | 'more' | 'imposition' | 'profile' | 'tools' | 'settings' | 'resources' | 'transfer';

const S = {
  route: 'export' as Route,
  checkTab: 'issues' as CheckTab,
  sheet: '' as Sheet,
  sheetStack: [] as Sheet[],
  routed: false,
  gotInit: false,
  gotSelection: false,
  docMore: false,
  passOpen: false,
  stdOpen: false,
  resultOpen: false,
  pagesOpen: false,
  selectionRevision: 0,
  checkError: '',
  pendingCheckId: '',
  confirmKey: '',
  toolOpen: '',
  previewIdx: 0,
  pvLoading: '',
  issuesKey: '',
  impBackup: null as null | Settings['imp'],
  selKey: '',
  baseIssues: [] as Issue[],
  pendingIssuesKey: '',
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
  const reqId = type === 'preflight' ? 'r' + reqSeq++ : '';
  const key = reqId ? reply + ':' + reqId : reply;
  const errorKey = reqId ? 'error:' + type + ':' + reqId : 'error:' + type;
  return new Promise((res, rej) => {
    waiters.set(key, (m) => { waiters.delete(errorKey); res(m); });
    waiters.set(errorKey, (m) => { waiters.delete(key); rej(new Error(m.message)); });
    post(type, { ...data, ...(reqId ? { reqId } : {}) });
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
  const replyKey = m.type === 'preflight' ? m.type + ':' + m.reqId : m.type;
  const w = waiters.get(replyKey);
  if (w) {
    waiters.delete(replyKey);
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
      if (!S.settings.profileBase || !Object.keys(S.settings.profileBase).length) {
        // first run of this version: name the profile only if the current settings really match one
        const cur = JSON.stringify(pick(S.settings, PROFILE_KEYS));
        const match = BUILTIN_PROFILES.find((b) => JSON.stringify(pick({ ...S.settings, ...structuredClone(b.s) } as Settings, PROFILE_KEYS)) === cur);
        S.settings.profileId = match ? match.id : '';
        S.settings.profileBase = pick(S.settings, PROFILE_KEYS);
      }
      refreshEngine();
      S.gotInit = true;
      maybeRoute();
      break;
    case 'selection': {
      S.selectionRevision++;
      S.frames = m.frames;
      S.measure = m.measure || [];
      const ids = S.frames.map((f) => f.id);
      S.order = [...S.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !S.order.includes(id))];
      // always re-request: the frames may have been edited since the last thumbnail
      if (ids.length) post('thumbs', { ids });
      if (selectionKey() !== S.selKey) {
        S.selKey = selectionKey();
        S.colors = null;
        S.texts = null;
        S.previewIdx = 0;
        if (!ids.length && (S.sheet === 'more' || S.sheet === 'imposition')) {
          S.sheet = '';
          S.sheetStack = [];
        }
      }
      S.gotSelection = true;
      maybeRoute();
      onEnter();
      render();
      break;
    }
    case 'thumb':
      S.thumbs[m.id] = 'data:image/png;base64,' + bytesToB64(m.png);
      if (S.route === 'export' && !S.sheet) {
        const img = document.querySelector(`[data-thumb="${CSS.escape(m.id)}"]`);
        if (img instanceof HTMLImageElement) img.src = S.thumbs[m.id];
        else render();
      }
      break;
    case 'colors':
      S.colors = m.colors;
      if (S.issues) S.issues = [...S.baseIssues, ...colorIssues()];
      render();
      break;
    case 'texts':
      S.texts = m.texts;
      render();
      break;
    case 'preflight':
      if (m.reqId !== S.pendingCheckId || S.pendingIssuesKey !== checkKey()) break;
      S.pendingIssuesKey = '';
      S.pendingCheckId = '';
      S.colors = m.colors;
      S.baseIssues = m.issues;
      S.issues = [...m.issues, ...colorIssues()];
      S.issuesKey = checkKey();
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
      const key = 'error:' + m.during + (m.during === 'preflight' ? ':' + m.reqId : '');
      const rej = waiters.get(key);
      if (rej) {
        waiters.delete(key);
        rej(m);
      } else notify('出错了：' + m.message, true);
      if (m.during === 'preflight' && m.reqId === S.pendingCheckId) {
        S.pendingCheckId = '';
        S.pendingIssuesKey = '';
        S.checkError = m.message;
        render();
      }
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
    if (S.issues) S.issues = [...S.baseIssues, ...colorIssues()];
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
  return `<input id="setting-${path}" type="number" data-bind="${path}" data-t="num" ${opts.unit ? 'data-u="1"' : ''} value="${shown}" ${opts.min !== undefined ? `min="${opts.min}"` : ''} ${opts.max !== undefined ? `max="${opts.max}"` : ''} step="${opts.unit && S.settings.unit !== 'mm' ? 'any' : opts.step ?? 1}" ${opts.w ? `style="width:${opts.w}px"` : ''}>`;
};
const U = () => `<span class="unit">${S.settings.unit}</span>`;
const txt = (path: string, ph = '') => `<input id="setting-${path}" type="text" data-bind="${path}" value="${esc(getPath(path) ?? '')}" placeholder="${esc(ph)}">`;
const chk = (path: string, label: string, hint = '') =>
  `<label class="chk"><input type="checkbox" data-bind="${path}" data-t="bool" ${getPath(path) ? 'checked' : ''}><span>${label}${hint ? ` <span class="muted">${hint}</span>` : ''}</span></label>`;
const seg = (path: string, opts: [any, string][]) =>
  `<div class="seg">${opts.map(([v, l]) => `<button data-act="seg" data-path="${path}" data-v="${esc(JSON.stringify(v))}" aria-pressed="${getPath(path) === v}" class="${getPath(path) === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
const sel = (path: string, opts: [any, string][], t = 'str') =>
  `<select id="setting-${path}" data-bind="${path}" data-t="${t}">${opts.map(([v, l]) => `<option value="${esc(String(v))}" ${String(getPath(path)) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
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

// ---------------- views ----------------

// Re-rendering replaces the form. A change event fires while focus is leaving a field (Tab, or a
// press on another control); rebuilding the DOM right then would swallow that Tab / click. So
// renders requested from a change are deferred until the press is over, and afterwards the
// cursor is put back into whichever field had focus.
const fieldKey = (el: Element | null): string | null => {
  if (el instanceof HTMLButtonElement && el.dataset.act) return `button[data-act="${CSS.escape(el.dataset.act)}"]${['v', 'path', 'dir'].filter((k) => el.dataset[k] !== undefined).map((k) => `[data-${k}="${CSS.escape(el.dataset[k]!)}"]`).join('')}`;
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

function maybeRoute() {
  if (S.routed || !S.gotInit || !S.gotSelection) return;
  S.routed = true;
  if (!S.settings.onboarded && !S.profiles.length) S.route = 'welcome';
  else S.route = S.frames.length ? 'export' : 'prepare';
}

/** Side effects of arriving at (or staying on) a screen with the current selection. */
function onEnter() {
  if (S.route !== 'check' || !S.frames.length) return;
  if (S.issuesKey !== checkKey() && S.pendingIssuesKey !== checkKey()) runPreflight();
  if (!S.texts) post('scan-text');
  if (S.checkTab === 'preview') ensurePreview();
}

async function ensurePreview() {
  const frames = orderedFrames();
  const f = frames[Math.min(S.previewIdx, frames.length - 1)];
  if (!f || S.preview?.id === f.id || S.pvLoading === f.id) return;
  S.pvLoading = f.id;
  try {
    const m = await request<{ id: string; name: string; png: Uint8Array }>('render', { id: f.id, maxPx: 900 }, 'rendered');
    S.preview = { id: m.id, name: m.name, src: await decodeToRgb(m.png), mode: S.preview?.mode || 'split', paper: S.preview?.paper || false, split: S.preview?.split ?? 0.5 };
  } catch (e: any) {
    notify(e.message || String(e), true);
  } finally {
    S.pvLoading = '';
  }
  render();
}

function renderInner() {
  $('head').innerHTML = viewHead();
  translateDom($('head'));
  const main = $('view');
  main.classList.toggle('workbench', S.route === 'export' && !S.sheet);
  const key = S.route + '/' + S.sheet + '/' + S.checkTab;
  const scroll = key === lastViewKey ? main.scrollTop : 0;
  lastViewKey = key;
  main.innerHTML = viewMain();
  translateDom(main);
  main.scrollTop = scroll;
  const dialog = $('export-confirm') as HTMLDialogElement;
  if (dialog.open && (S.route !== 'export' || S.sheet || S.confirmKey !== confirmationKey())) dialog.close();
  if (S.route === 'check' && S.checkTab === 'preview' && !S.sheet) paintPreview();
  renderFoot();
}
let lastViewKey = '';

// ---------- small building blocks ----------

const IC = {
  chev: `<svg class="chev" width="12" height="12" viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`,
  right: `<svg width="10" height="10" viewBox="0 0 10 10" style="flex:none;color:var(--fg2)"><path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>`,
  back: `<svg width="14" height="14" viewBox="0 0 12 12"><path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`,
  arrow: `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  grid: `<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="8" y="1.5" width="4.5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="1.5" y="8" width="4.5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="8" y="8" width="4.5" height="4.5" rx="2.25" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>`,
  gear: `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3-.6 2.4-2 .9L4.2 6l-2 3.5 1.6 1.8v2.4l-1.6 1.8 2 3.5 2.2-.3 2 .9L9 22h6l.6-2.4 2-.9 2.2.3 2-3.5-1.6-1.8v-2.4l1.6-1.8-2-3.5-2.2.3-2-.9L15 3Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="12.5" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`,
  plus: `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  upload: `<svg width="22" height="22" viewBox="0 0 22 22"><path d="M11 14V3M6.5 7.5L11 3l4.5 4.5M3 15v3a1 1 0 001 1h14a1 1 0 001-1v-3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  okCircle: `<svg width="14" height="14" viewBox="0 0 14 14" style="flex:none"><circle cx="7" cy="7" r="6" fill="var(--ok)"/><path d="M4.2 7.2l1.9 1.9 3.7-4" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};
const INKS = `<span class="inks"><i style="background:#00A0E9"></i><i style="background:#E5007D"></i><i style="background:#FFE100"></i><i style="background:#1d1d1f"></i></span>`;
const toggle = (path: string) => `<button class="toggle ${getPath(path) ? 'on' : ''}" data-act="tg" data-path="${path}" role="switch" aria-checked="${!!getPath(path)}"></button>`;
const tline = (path: string, label: string, hint = '') => `<div class="line"><span class="l">${label}</span>${hint ? `<span class="muted xs">${hint}</span>` : ''}${toggle(path)}</div>`;
const segRaw = (act: string, cur: string, opts: [string, string][], extra = '') =>
  `<div class="seg ${extra}">${opts.map(([v, l]) => `<button data-act="${act}" data-v="${v}" class="${cur === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
const sheetHead = (title: string, right = '') => `<div class="sheet-h"><button class="back" data-act="sheet" data-v="" title="返回">${IC.back}</button><span class="title">${title}</span>${right}</div>`;
const disclose = (act: string, open: boolean, title: string, sub = '') =>
  `<button class="disclose ${open ? 'open' : ''}" data-act="${act}"><span class="grow" style="display:flex;flex-direction:column;gap:2px"><span class="t">${title}</span>${sub ? `<span class="muted xs ell">${sub}</span>` : ''}</span>${IC.chev}</button>`;
const langSelect = () =>
  `<select id="lang" data-notr><option value="" ${!S.settings.lang ? 'selected' : ''}>${tr('跟随系统')}</option>${LANGS.map((l) => `<option value="${l.code}" ${S.settings.lang === l.code ? 'selected' : ''}>${l.name}</option>`).join('')}</select>`;

function frameSize(f: FrameInfo) {
  const k = f.meta?.scale || 1;
  return { w: f.meta ? f.meta.trimW : (f.w * k) / MM, h: f.meta ? f.meta.trimH : (f.h * k) / MM };
}
const orderedFrames = () => S.order.map((id) => S.frames.find((f) => f.id === id)).filter(Boolean) as FrameInfo[];
const selectionKey = () => S.order.join(',');
const checkKey = () => JSON.stringify([S.frames.map((f) => f.id).sort(), S.selectionRevision, preflightOpts(), colorSettings(), pick(S.settings, ['iccId', 'colorFinishing', 'bleedMm', 'bleedSidesOn', 'bleedSides', 'autoBleed', 'format', 'rasterDpi', 'pdfx', 'scalePct', 'textOutline', 'imp'])]);
/** Preflight results, only when they belong to the current selection. */
const currentIssues = () => (S.issues && S.issuesKey === checkKey() ? S.issues : null);
const confirmationKey = () => JSON.stringify([S.settings, S.selectionRevision, S.order, currentIssues()]);

// ---------- print profiles (bundles of colour + output settings) ----------

const PROFILE_KEYS = ['mode', 'intent', 'bpc', 'pureBlackToK', 'grayToK', 'richBlackOn', 'richPreset', 'richBlack', 'tacLimit', 'pdfx', 'flattenDpi', 'minStrokeOn', 'minStrokePt', 'overprintBlack', 'removeWhiteOverprint'] as const;
interface BuiltinProfile {
  id: string;
  name: string;
  desc: string;
  icc?: RegExp; // prefer an imported ICC whose name matches
  s: Partial<Settings>;
}
const BASE_PROFILE: Partial<Settings> = { mode: 'cmyk', intent: 1, bpc: true, pureBlackToK: true, grayToK: true, richBlackOn: false, tacLimit: 320, pdfx: 'x4', flattenDpi: 300, minStrokeOn: true, minStrokePt: 0.25, overprintBlack: true, removeWhiteOverprint: true };
const BUILTIN_PROFILES: BuiltinProfile[] = [
  { id: 'coated', name: '胶印 · 铜版纸', desc: '画册、海报、名片的常见选择', icc: /(?<!un)coated|fogra39|gracol|pso coated|isocoated/i, s: { ...BASE_PROFILE } },
  { id: 'uncoated', name: '胶印 · 胶版纸', desc: '书刊内页、信纸、哑感纸张', icc: /uncoated|fogra29|pso uncoated/i, s: { ...BASE_PROFILE, tacLimit: 280 } },
  { id: 'news', name: '报纸 / 老设备', desc: 'PDF/X-1a · 透明效果自动拼合', icc: /news|ifra|snap/i, s: { ...BASE_PROFILE, tacLimit: 240, pdfx: 'x1a' } },
  { id: 'digital', name: '数码快印', desc: 'CMYK · 普通 PDF', s: { ...BASE_PROFILE, pdfx: 'none' } },
  { id: 'screen', name: '屏幕查看（给客户）', desc: 'RGB · 无出血无标记', s: { ...BASE_PROFILE, mode: 'rgb', pdfx: 'none', minStrokeOn: false } },
];
const pick = (s: Settings, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, structuredClone((s as any)[k])]));

function applyProfile(id: string) {
  const s = S.settings;
  const b = BUILTIN_PROFILES.find((p) => p.id === id);
  if (b) {
    Object.assign(s, structuredClone(b.s));
    if (b.icc) {
      const m = S.profiles.find((p) => b.icc!.test(p.name));
      if (m) s.iccId = m.id;
    }
    if (id === 'screen') {
      s.cropMarks = false;
      s.regMarks = false;
      s.colorBars = false;
    } else if (id === 'digital') {
      s.regMarks = false;
      s.colorBars = false;
    }
  } else {
    const p = S.presets[+id.slice(5)];
    if (!p) return;
    deepMerge(s, structuredClone(p.settings));
  }
  s.profileId = id;
  s.profileBase = pick(s, PROFILE_KEYS);
  saveSettings();
  refreshEngine();
}
function profileName(id = S.settings.profileId) {
  if (id.startsWith('user:')) return S.presets[+id.slice(5)]?.name || '';
  return BUILTIN_PROFILES.find((p) => p.id === id)?.name || '';
}
const profileDirty = () => !!S.settings.profileId && JSON.stringify(pick(S.settings, PROFILE_KEYS)) !== JSON.stringify(S.settings.profileBase || {});

// ---------- header / footer ----------

function viewHead() {
  const step = (id: Route, n: string, label: string) =>
    `<button class="step ${S.route === id ? 'on' : ''}" data-act="route" data-v="${id}" ${S.route === id ? 'aria-current="page"' : ''}><span class="n">${n}</span><span>${label}</span></button>`;
  return `${S.route === 'welcome' ? '<span class="kicker" style="font-weight:600;color:var(--fg)" data-notr>Inkpaper 纸墨</span>' : `<nav class="steps" aria-label="${tr('插件工作区')}">${step('prepare', '1', '准备')}${step('check', '2', '检查')}${step('export', '3', '导出')}</nav>`}
  <div class="header-actions">${S.route === 'welcome' ? '' : `<button class="btn small utility ${S.sheet === 'tools' ? 'primary' : ''}" data-act="sheet" data-root="1" data-v="${S.sheet === 'tools' ? '' : 'tools'}" title="画布工具" aria-label="${tr('画布工具')}">${IC.grid}<span class="utility-label">画布工具</span></button>`}<button class="btn small utility icon-only ${['settings', 'resources', 'transfer'].includes(S.sheet) || S.sheetStack.includes('settings') ? 'primary' : ''}" data-act="sheet" data-root="1" data-v="${S.sheet === 'settings' ? '' : 'settings'}" title="设置" aria-label="${tr('设置')}">${IC.gear}</button></div>`;
}

function impSheets(n: number): number {
  const imp = S.settings.imp;
  if (imp.kind === 'spreads') return n ? 1 + Math.ceil((n - 1) / 2) : 0;
  if (imp.kind === 'booklet') return Math.ceil(n / 4) * 2;
  const g = nupGrid();
  if (!g) return n;
  if (imp.kind === 'nup') return imp.repeat ? n * Math.ceil(Math.max(1, imp.copies) / g.per) : Math.ceil((n * Math.max(1, imp.copies)) / g.per);
  if (imp.kind === 'duplex') return Math.ceil((Math.ceil(n / 2) * Math.max(1, imp.copies)) / g.per) * 2;
  return n;
}
/** Same grid the composer uses for n-up / duplex (12 mm margin for marks). */
function nupGrid() {
  const f = orderedFrames()[0];
  if (!f) return null;
  const imp = S.settings.imp;
  const { w, h } = frameSize(f);
  const k = 1;
  const cw = w * k,
    ch = h * k,
    g = imp.gutter,
    m = 12;
  const cols = imp.cols > 0 ? imp.cols : Math.max(1, Math.floor((imp.sheetW - 2 * m + g) / (cw + g)));
  const rows = imp.rows > 0 ? imp.rows : Math.max(1, Math.floor((imp.sheetH - 2 * m + g) / (ch + g)));
  return { cols, rows, per: cols * rows, cw, ch };
}

function exportLabel() {
  const s = S.settings;
  const n = S.frames.length;
  const fmt = s.format === 'pdf' ? 'PDF' : s.format.toUpperCase();
  let sub = '';
  if (s.format === 'pdf' && s.imp.kind !== 'none') sub = `${impSheets(n)} 个版面`;
  return { main: n > 1 ? `导出 ${n} 页 ${fmt}` : `导出 ${fmt}`, sub };
}

function readiness(): [string, string, string] {
  // [dot class, text, link]
  if (!S.frames.length) return ['', '在画布上选择要导出的画板', ''];
  const is = currentIssues();
  if (S.pendingIssuesKey === checkKey()) return ['', '正在检查…', ''];
  if (!is) return ['', S.issues ? '设置或选择已改变，请重新检查' : '还没有检查印刷质量', '检查'];
  const err = is.filter((i) => i.level === 'error').length;
  const warn = is.filter((i) => i.level === 'warning').length;
  if (err || warn) return [err ? 'err' : 'warn', `${err + warn} 项风险需要处理或确认`, '查看'];
  return ['ok', '检查完成，未发现已知风险', '查看'];
}

function viewReadiness() {
  const [cls, text, link] = readiness();
  const is = currentIssues();
  const count = is?.filter((i) => i.level === 'warning' || i.level === 'error').length || 0;
  const label = count ? `${count} 项风险` : cls === 'ok' ? '未发现已知风险' : S.pendingIssuesKey === checkKey() ? '正在检查…' : S.issues ? '需重新检查' : '未检查';
  return `<section class="quality compact ${cls}" title="${esc(tr(text))}"><span class="dot ${cls}" aria-hidden="true"></span><span class="grow">${label}</span>${link ? `<button class="link" data-act="route" data-v="check">${link === '检查' ? '检查' : '查看'} ${IC.right}</button>` : ''}</section>`;
}

function renderFoot() {
  let html = '';
  if (S.sheet === 'imposition') {
    html = `<div style="display:flex;gap:8px"><button class="btn" style="height:40px" data-act="imp-cancel">取消</button><button class="btn primary big" style="flex:1" data-act="sheet" data-v="">${impLabel(S.settings.imp.kind)[0] === '不拼版' ? '完成' : `使用${impLabel(S.settings.imp.kind)[0]}`}</button></div>`;
  } else if (S.sheet) {
    html = '';
  } else if (S.route === 'welcome') {
    html = `<button class="btn primary big" data-act="onboard">开始</button>`;
  } else if (S.route === 'prepare') {
    const d = S.settings.doc;
    const kind = DOC_KINDS.find((k) => k.id === d.kind);
    const pp = PAPER_PRESETS.find((p) => p.id === d.preset);
    const sizeName = pp ? tr(pp.name).replace(/（.*?）|\(.*?\)/g, '').trim() : `${toUnit(d.w)}×${toUnit(d.h)} ${S.settings.unit}`;
    html = `<button class="btn primary big" data-act="create-doc"><span>${d.pages > 1 ? `创建 ${d.pages} 页${kind?.noun || '印刷文档'}` : `创建${kind?.noun || '印刷文档'}`}</span><span class="sub" data-notr>· ${esc(sizeName)} · ${tr('出血')} ${d.sidesOn ? '…' : toUnit(d.bleed) + ' ' + S.settings.unit}</span></button>`;
  } else if (S.route === 'check') {
    html = `<button class="btn primary big" data-act="route" data-v="export"><span>返回导出</span>${IC.arrow}</button>`;
  } else {
    const lab = exportLabel();
    html = `<button class="btn primary big" data-act="export" ${!S.frames.length || S.busy ? 'disabled' : ''}><span>${lab.main}</span>${lab.sub ? `<span class="sub">· <span>${lab.sub}</span></span>` : ''}</button>`;
  }
  $('foot').hidden = !html;
  $('foot').innerHTML = html;
  translateDom($('foot'));
}

// ---------- routing of the main area ----------

function viewMain(): string {
  if (S.sheet === 'settings') return viewSettings();
  if (S.sheet === 'resources') return viewColorResources();
  if (S.sheet === 'transfer') return `${sheetHead('预设导入 / 导出')}<div class="settings-group"><p class="hint">包含印刷方案和颜色映射，不含 ICC 和色板。</p><div class="line"><button class="btn" data-act="import-json">导入 JSON</button><button class="btn" data-act="export-json">导出 JSON</button></div></div>`;
  if (S.sheet === 'tools') return viewTools();
  if (S.sheet === 'more') return viewMore();
  if (S.sheet === 'imposition') return viewImposition();
  if (S.sheet === 'profile') return viewProfile();
  if (S.route === 'welcome') return viewWelcome();
  if (S.route === 'prepare') return viewPrepare();
  if (S.route === 'check') return viewCheck();
  return viewExport();
}

const noSelection = (what: string) =>
  `<div class="empty"><span>${what}</span><button class="btn" data-act="route" data-v="prepare">${IC.plus}<span>新建印刷画板</span></button></div>`;

function viewSettings() {
  return `${sheetHead('设置')}
    <section class="settings-group"><h2>偏好</h2>
      <div class="row"><label class="lbl" for="lang">界面语言</label>${langSelect()}</div>
      <div class="row"><label class="lbl" for="setting-unit">尺寸单位</label>${sel('unit', [['mm', 'mm'], ['cm', 'cm'], ['in', 'in'], ['pt', 'pt']])}</div>
      <div class="row"><span class="lbl">外观</span><span class="muted">跟随 Figma</span></div>
    </section>
    <section class="settings-group"><h2>资源管理</h2>
      <button class="settings-link" data-act="sheet" data-v="profile"><span>印刷方案与 ICC</span>${IC.right}</button>
      <button class="settings-link" data-act="sheet" data-v="resources"><span>色板与颜色映射</span>${IC.right}</button>
      <button class="settings-link" data-act="sheet" data-v="transfer"><span>预设导入 / 导出</span>${IC.right}</button>
    </section>
    <details class="settings-help"><summary>关于与帮助</summary><p class="hint">Inkpaper 纸墨 · 全部在本机处理，不上传设计稿</p><a href="https://github.com/onevalar/figma-inkpaper#readme" target="_blank" rel="noopener noreferrer">使用说明</a></details>`;
}

// ---------- 01 welcome ----------

function viewWelcome() {
  return `<div style="display:flex;flex-direction:column;gap:12px;padding-top:14px">
    <svg width="40" height="40" viewBox="0 0 44 44"><circle cx="22" cy="22" r="12" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="22" cy="22" r="6" fill="var(--accent)"/><path d="M22 2v40M2 22h40" stroke="currentColor" stroke-width="1.5"/></svg>
    <h1 style="font-size:24px">把屏幕上的设计，<br>变成纸上的墨。</h1>
    <p class="hint">准备 → 检查 → 导出</p>
  </div>
  <div class="section" style="gap:8px">
    <h2>导入印刷厂的 ICC</h2>
    ${
      S.profiles.length
        ? `<div class="well" style="display:flex;align-items:center;gap:8px">${IC.okCircle}<span class="grow" data-notr>${esc(S.profiles.map((p) => p.name).join('、'))}</span><button class="link" data-act="import-icc">再导入</button></div>`
        : `<button class="drop" data-act="import-icc" id="icc-drop">${IC.upload}<span>拖入 .icc 文件，或点这里选择</span></button>`
    }
    <p class="hint xs">先跳过也可以，颜色会用近似算法换算</p>
    <details class="settings-help"><summary>ICC 获取帮助</summary><p class="hint xs"><span>不知道用哪个？问印刷厂要，或从官网免费下载：</span> <a href="https://www.adobe.com/support/downloads/iccprofiles/iccprofiles_mac.html" target="_blank" data-notr>Adobe</a> · <a href="https://www.eci.org/en/downloads" target="_blank" data-notr>ECI</a></p></details>
  </div>`;
}

// ---------- 02 prepare ----------

const DOC_KINDS = [
  { id: 'book', name: '画册 / 书刊', desc: 'A4 · 对页排列', noun: '画册', preset: 'a4', pages: 8, facing: true, fold: 'none', scale: 1, art: `<svg width="34" height="24" viewBox="0 0 34 24"><path d="M17 4c-4-2-9-2.5-15-2v20c6-.5 11 0 15 2 4-2 9-2.5 15-2V2c-6-.5-11 0-15 2z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/><path d="M17 4v20" stroke="currentColor" stroke-width="1.4"/></svg>` },
  { id: 'card', name: '名片 / 卡片', desc: '90×54 mm', noun: '名片', preset: 'bc-cn', pages: 2, facing: false, fold: 'none', scale: 1, art: `<svg width="34" height="24" viewBox="0 0 34 24"><rect x="2" y="4" width="30" height="18" rx="2" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M7 11h10M7 15h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>` },
  { id: 'poster', name: '海报 / 传单', desc: 'A2 · A3 · A5', noun: '海报', preset: 'a3', pages: 1, facing: false, fold: 'none', scale: 1, art: `<svg width="34" height="24" viewBox="0 0 34 24"><rect x="10" y="1" width="15" height="22" rx="1" stroke="currentColor" stroke-width="1.4" fill="none"/><circle cx="17.5" cy="9" r="3" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>` },
  { id: 'fold', name: '折页', desc: '对折 · 三折 · 关门折', noun: '折页', preset: 'trifold-a4', pages: 2, facing: false, fold: 'tri', scale: 1, art: `<svg width="34" height="24" viewBox="0 0 34 24"><path d="M2 3l10 2v17L2 20zM12 5l10-2v17l-10 2zM22 3l10 2v17l-10-2z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>` },
  { id: 'pack', name: '包装 / 吊牌', desc: '可生成纸盒刀版', noun: '吊牌', preset: 'hangtag', pages: 1, facing: false, fold: 'none', scale: 1, art: `<svg width="34" height="24" viewBox="0 0 34 24"><path d="M17 2l12 5v11l-12 5-12-5V7z M5 7l12 5 12-5 M17 12v11" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>` },
  { id: 'big', name: '大幅喷绘', desc: '易拉宝 · 按 1:10 制作', noun: '喷绘', preset: 'rollup', pages: 1, facing: false, fold: 'none', scale: 10, art: `<svg width="34" height="24" viewBox="0 0 34 24"><rect x="11" y="1" width="12" height="19" rx="1" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M9 22h16M17 20v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>` },
] as const;

function presetOptions() {
  const s = S.settings;
  const d = s.doc;
  const groups = new Map<string, typeof PAPER_PRESETS>();
  for (const p of PAPER_PRESETS) groups.set(p.group, [...(groups.get(p.group) || []), p]);
  return (
    [...groups.entries()].map(([g, ps]) => `<optgroup label="${g}">${ps.map((p) => `<option value="${p.id}" ${d.preset === p.id ? 'selected' : ''}>${p.name}（${p.w}×${p.h}）</option>`).join('')}</optgroup>`).join('') +
    (s.customPapers.length ? `<optgroup label="我的尺寸">${s.customPapers.map((p, i) => `<option value="custom:${i}" ${d.preset === 'custom:' + i ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>` : '') +
    `<option value="custom" ${d.preset === 'custom' ? 'selected' : ''}>自定义尺寸…</option>`
  );
}

function viewPrepare() {
  const s = S.settings;
  const d = s.doc;
  const big = d.w * d.h > 1000 * 1400;
  const noMeta = S.frames.filter((f) => !f.meta);
  return `
  <div style="display:flex;flex-direction:column;gap:4px"><h1>要做什么印刷品？</h1><p class="hint">选一个类型，自动带好出血、裁切线、安全区参考线</p></div>
  <div class="picks">${DOC_KINDS.map((k) => `<button class="pick ${d.kind === k.id ? 'on' : ''}" data-act="doc-kind" data-v="${k.id}"><span style="color:${d.kind === k.id ? 'var(--accent)' : 'var(--fg)'}">${k.art}</span><span style="display:flex;flex-direction:column;gap:1px"><span class="t">${k.name}</span><span class="d">${k.desc}</span></span></button>`).join('')}</div>
  <div class="section">
    <div class="row"><span class="lbl">尺寸</span><select data-act="preset">${presetOptions()}</select>${segRaw('orient', d.landscape ? 'h' : 'v', [['v', '竖版'], ['h', '横版']])}</div>
    ${d.preset === 'custom' || d.preset.startsWith('custom:') ? `<div class="row"><span class="lbl"></span>宽 ${num('doc.w', { min: 1, step: 0.5, unit: true })} 高 ${num('doc.h', { min: 1, step: 0.5, unit: true })}${U()}</div>` : ''}
    <div class="row"><span class="lbl">页数</span><span class="stepper-n"><button data-act="pages" data-v="-1">−</button>${num('doc.pages', { min: 1, max: 400 })}<button data-act="pages" data-v="1">+</button></span>${d.kind === 'book' ? `<span class="muted xs">骑马钉需要 4 的倍数</span>` : ''}</div>
    <div class="row"><span class="lbl">出血</span>${d.sidesOn ? sides4('doc.sides') : `${num('doc.bleed', { min: 0, step: 0.5, unit: true })}${U()}<span class="muted xs">安全区 ${toUnit(d.safety)} · 页边距 ${toUnit(d.margin)} ${s.unit}</span>`}</div>
    ${big && d.scale === 1 ? `<p class="hint" style="color:var(--warn)">幅面较大，建议用 1:10 比例制作，避免 Figma 卡顿；导出时会自动放大回实际尺寸。</p>` : ''}
    ${disclose('doc-more', S.docMore, '更多尺寸选项', '单位、页边距、四边出血、折页、比例、名称、保存常用尺寸')}
    ${
      S.docMore
        ? `<div class="section" style="padding:8px 0 4px">
      <div class="row"><span class="lbl">单位</span>${seg('unit', [['mm', 'mm'], ['cm', 'cm'], ['in', 'in'], ['pt', 'pt']])}</div>
      <div class="row"><span class="lbl">宽 × 高</span>${num('doc.w', { min: 1, step: 0.5, unit: true })}×${num('doc.h', { min: 1, step: 0.5, unit: true })}${U()}</div>
      <div class="row"><span class="lbl">页边距</span>${num('doc.margin', { min: 0, unit: true })}${U()}<span class="lbl" style="width:auto;padding-left:12px">安全区</span>${num('doc.safety', { min: 0, step: 0.5, unit: true })}${U()}</div>
      <div class="row"><span class="lbl"></span>${chk('doc.sidesOn', '四边出血不同', '（如装订边不需要出血）')}</div>
      <div class="row"><span class="lbl">折页</span>${sel('doc.fold', [['none', '无'], ['half', '对折'], ['tri', '三折（风琴/卷折）'], ['z', 'Z 字折'], ['gate', '关门折']])}</div>
      <div class="row"><span class="lbl">制作比例</span>${sel('doc.scale', [[1, '1:1 实际尺寸'], [2, '1:2'], [4, '1:4'], [5, '1:5'], [10, '1:10（大幅喷绘）']], 'num')}</div>
      <div class="row"><span class="lbl"></span>${chk('doc.facing', '对页排列（画册 / 书刊跨页）')}</div>
      <div class="row"><span class="lbl">名称</span>${txt('doc.name')}</div>
      <div class="row"><span class="lbl"></span><button class="btn small" data-act="save-paper">保存为常用尺寸</button></div>
      <p class="hint xs">画板会包含出血区，并自动画出裁切线、安全区、折线参考线。按 ⌘⇧4（Windows：Ctrl+Shift+4）显示或隐藏参考网格。</p>
    </div>`
        : ''
    }
  </div>
  <div class="divided" style="border-bottom:1px solid var(--line);margin-top:-18px">
    <div class="tool-h" data-act="${noMeta.length ? 'convert-doc' : ''}" style="cursor:${noMeta.length ? 'pointer' : 'default'}"><span class="ic"><svg width="16" height="16" viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" stroke="currentColor" stroke-width="1.3" fill="none"/><rect x="1.5" y="1.5" width="13" height="13" stroke="currentColor" stroke-width="1.1" stroke-dasharray="2 2" fill="none"/></svg></span><span class="grow" style="display:flex;flex-direction:column"><span style="font-weight:500">已经做好了设计？给它加出血</span><span class="muted xs">${noMeta.length ? `点这里给选中的 ${noMeta.length} 个画板加出血，贴边的背景会自动延伸` : '在画布上选中画板，贴边的背景会自动延伸'}</span></span>${noMeta.length ? IC.right : ''}</div>
    <div class="tool-h" style="cursor:default"><span class="ic"><svg width="16" height="16" viewBox="0 0 16 16"><rect x="2" y="1.5" width="12" height="13" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M5 5.5h6M5 8h6M5 10.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span><span class="grow" style="display:flex;flex-direction:column"><span style="font-weight:500">一次建很多尺寸</span><span class="muted xs">CSV 每行：名称,宽,高,出血,页数（单位 ${UNIT_NAMES[s.unit]}）</span></span><button class="link" data-act="csv-import">导入 CSV</button><button class="link muted" data-act="csv-template">下载模板</button></div>
  </div>`;
}

// ---------- 03 export ----------

const IMP_ART: Record<ImpKind, string> = {
  none: `<svg width="26" height="36" viewBox="0 0 26 36"><rect x="1" y="1" width="24" height="34" fill="var(--bg)" stroke="currentColor" stroke-width="1.2"/></svg>`,
  spreads: `<svg width="50" height="36" viewBox="0 0 50 36"><rect x="1" y="1" width="24" height="34" fill="var(--bg)" stroke="currentColor" stroke-width="1.2"/><rect x="25" y="1" width="24" height="34" fill="var(--bg)" stroke="currentColor" stroke-width="1.2"/></svg>`,
  booklet: `<svg width="50" height="36" viewBox="0 0 50 36"><rect x="1" y="1" width="24" height="34" fill="var(--bg)" stroke="currentColor" stroke-width="1.2"/><rect x="25" y="1" width="24" height="34" fill="var(--bg)" stroke="currentColor" stroke-width="1.2"/><path d="M25 1v34" stroke="currentColor" stroke-dasharray="2 2"/><text x="11" y="31" font-size="7" fill="currentColor">4</text><text x="35" y="31" font-size="7" fill="currentColor">1</text></svg>`,
  nup: `<svg width="46" height="36" viewBox="0 0 46 36"><rect x="1" y="1" width="44" height="34" fill="var(--bg)" stroke="currentColor" stroke-width="1.2"/>${[0, 1, 2].map((r) => [0, 1, 2].map((c) => `<rect x="${5 + c * 13}" y="${5 + r * 9}" width="11" height="7" fill="currentColor" opacity=".5"/>`).join('')).join('')}</svg>`,
  duplex: `<svg width="70" height="36" viewBox="0 0 70 36"><rect x="1" y="7" width="28" height="22" fill="var(--bg)" stroke="currentColor" stroke-width="1.2"/><rect x="41" y="7" width="28" height="22" fill="var(--bg)" stroke="currentColor" stroke-width="1.2"/><path d="M31 18h8M36 15l3 3-3 3" stroke="currentColor" fill="none"/><text x="11" y="21" font-size="7" fill="currentColor">A</text><text x="51" y="21" font-size="7" fill="currentColor">B</text></svg>`,
};
function impLabel(k: ImpKind): [string, string] {
  return ({ none: ['不拼版', '一页一个成品'], spreads: ['对页跨页', '画册校对用'], booklet: ['骑马钉画册', '自动排页，可从右往左'], nup: ['一版多拼', '名片、贴纸、卡片'], duplex: ['正反面拼版', '双面卡片，背面自动镜像'] } as Record<ImpKind, [string, string]>)[k];
}

function bleedShortCard() {
  const s = S.settings;
  const req = s.bleedSidesOn ? s.bleedSides : uniform(s.bleedMm);
  const short = S.frames.filter((f) => {
    if (!f.meta) return false;
    const b = f.meta.bleedSides || uniform(f.meta.bleed);
    return req.t > b.t + 0.01 || req.r > b.r + 0.01 || req.b > b.b + 0.01 || req.l > b.l + 0.01;
  });
  return short.length
    ? `<div class="card warn" style="display:flex;flex-direction:column;gap:8px"><span class="sm">${short.length} 个画板做的出血比这里设置的少，导出时只能按画板实际的出血输出。</span><div><button class="btn small" data-act="convert-frames">为这些画板补足出血</button></div></div>`
    : '';
}

function viewExport() {
  const s = S.settings;
  const frames = orderedFrames();
  if (!frames.length) return noSelection('在画布上选择要导出的画板、编组或分区');
  const isPdf = s.format === 'pdf';
  const customized = !!S.password || [...MORE_KEYS, 'imp', 'regMarks', 'colorBars', 'author', 'subject', 'keywords'].some((k) => {
    if (s.compression !== 'custom' && ['imageCompression', 'jpegQuality', 'maxPpi'].includes(k)) return false;
    return JSON.stringify((s as any)[k]) !== JSON.stringify((DEFAULTS as any)[k]);
  });
  const first = frames[0];
  const sz = frameSize(first);
  const same = frames.every((f) => {
    const z = frameSize(f);
    return Math.abs(z.w - sz.w) < 0.5 && Math.abs(z.h - sz.h) < 0.5;
  });
  const preset = PAPER_PRESETS.find((p) => Math.abs(p.w - sz.w) < 0.6 && Math.abs(p.h - sz.h) < 0.6);
  const sizeTxt = `${toUnit(sz.w)}×${toUnit(sz.h)} ${s.unit}`;
  const pname = preset ? tr(preset.name).replace(/（.*?）|\(.*?\)/g, '').trim() : '';
  const summary = !same ? '多种尺寸' : !preset ? sizeTxt : /\d×\d/.test(pname) ? `${pname} ${s.unit}` : `${pname} · ${sizeTxt}`;
  const imp = s.imp;
  const r = S.lastResult;
  return `
  <section class="pages-summary">
    <div class="pages-compact">${S.thumbs[first.id] ? `<img data-thumb="${esc(first.id)}" src="${S.thumbs[first.id]}" alt="">` : ''}<div class="grow pages-copy"><b class="num">${frames.length} 页待导出</b><span class="muted xs" data-notr>${esc(summary === '多种尺寸' ? tr(summary) : summary)}</span></div><button class="link" data-act="pages-open" aria-expanded="${S.pagesOpen}" aria-controls="export-pages">${S.pagesOpen ? '收起页面' : '查看与排序'} ${IC.chev}</button></div>
    ${S.pagesOpen ? `<div id="export-pages"><p class="hint xs">拖动排序，也可用前移、后移按钮调整。</p><div class="strip">${frames
      .map(
        (f, i) => `<div class="page" draggable="true" data-drag="${i}"><button class="page-select" data-act="select" data-v="${f.id}" title="${esc(f.name)}" data-notr><span class="pg">${S.thumbs[f.id] ? `<img data-thumb="${esc(f.id)}" src="${S.thumbs[f.id]}" alt="">` : ''}</span><span class="no num">${i + 1} · ${esc(f.name)}</span></button><div class="page-order"><button data-act="page-move" data-v="${f.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="${tr('前移')}">‹</button><button data-act="page-move" data-v="${f.id}" data-dir="1" ${i === frames.length - 1 ? 'disabled' : ''} title="${tr('后移')}">›</button></div></div>`,
      )
      .join('')}</div></div>` : ''}
  </section>
  ${viewReadiness()}
  <button class="profile" data-act="sheet" data-v="profile">${INKS}<span class="grow profile-copy"><span class="kicker">印刷方案</span><span class="name">${esc(tr(profileName() || '自定义'))}${profileDirty() ? ` <span class="muted xs" style="font-weight:400">${tr('（已修改）')}</span>` : ''}</span><span class="hint xs ${s.mode === 'cmyk' && !currentProfile() ? 'tag-warn' : ''}" data-notr>${esc(tr(s.mode === 'cmyk' ? currentProfile()?.name || '未选择 ICC，颜色仅能近似换算。' : s.mode === 'rgb' ? 'RGB' : '灰度'))}</span></span>${IC.right}</button>
  <section class="section output-settings">
    <h2>输出设置</h2>
    <div class="row"><span class="lbl" id="format-label">格式</span><div role="group" aria-labelledby="format-label">${seg('format', [['pdf', 'PDF'], ['tiff', 'TIFF'], ['jpeg', 'JPEG'], ['png', 'PNG']])}</div></div>
    ${!isPdf ? `<div class="row"><label class="lbl" for="setting-rasterDpi">分辨率</label>${sel('rasterDpi', [[150, '150 dpi'], [300, '300 dpi（标准印刷）'], [600, '600 dpi（细线、条码）'], [1200, '1200 dpi']], 'num')}</div><p class="hint xs">${s.format === 'png' ? 'PNG 只能是 RGB，适合数码快印。' : `${s.mode === 'cmyk' ? 'CMYK' : s.mode === 'gray' ? '灰度' : 'RGB'} 位图，内嵌 ICC 和 DPI，文字和矢量会变成像素。`}</p>` : ''}
    <div class="row"><label class="lbl" ${s.bleedSidesOn ? '' : 'for="setting-bleedMm"'}>出血</label>${
      s.bleedSidesOn
        ? `<button class="link" data-act="sheet" data-v="more">${s.bleedSides.t}/${s.bleedSides.r}/${s.bleedSides.b}/${s.bleedSides.l} mm</button>`
        : `${num('bleedMm', { min: 0, max: 20, step: 0.5, unit: true, w: 56 })}${U()}`
    }${isPdf ? chk('cropMarks', '裁切线') : ''}</div>
    ${bleedShortCard()}
    <div class="row"><label class="lbl" for="setting-title">文件名</label><span data-notr class="grow" style="display:flex">${txt('title', S.fileName || '印刷文件')}</span><span class="muted xs">${isPdf ? '.pdf' : '.' + ({ tiff: 'tif', jpeg: 'jpg', png: 'png' } as Record<string, string>)[s.format]}</span></div>
  </section>
  <section class="advanced">
    <button class="disclose ${s.advancedOpen ? 'open' : ''}" data-act="more-open" aria-expanded="${s.advancedOpen}" aria-controls="export-advanced"><span class="grow t">专业设置</span>${customized ? '<span class="tag-accent xs">已自定义</span>' : ''}${IC.chev}</button>
    ${s.advancedOpen ? `<div id="export-advanced" class="section output-settings">
      ${isPdf ? `<div class="row"><span class="lbl">拼版</span><button class="btn grow" data-act="sheet" data-v="imposition"><span class="grow">${impLabel(imp.kind)[0]}</span>${IC.right}</button></div>
      <div class="row"><label class="lbl" for="setting-textOutline">文字</label>${sel('textOutline', [['perNode', '按图层设置'], ['none', '全部保留'], ['all', '全部转曲']])}</div>
      <div class="row"><label class="lbl" for="setting-output">文件输出</label>${sel('output', [['merged', '合并为一个 PDF'], ['separate', '每页单独一个文件']])}</div>
      <div class="row"><span class="lbl">印刷标记</span>${chk('regMarks', '套准')}${s.mode !== 'rgb' ? chk('colorBars', '色标条') : ''}</div>` : ''}
      <div class="row"><label class="lbl" for="setting-compression">图片压缩</label>${sel('compression', [['light', '轻度'], ['balanced', '均衡'], ['strong', '强力'], ['custom', '自定义']])}</div>
      <button class="btn" data-act="sheet" data-v="more">全部专业设置 ${IC.right}</button>
    </div>` : ''}
  </section>
  ${
    r
      ? `${disclose('result', S.resultOpen, '上次导出结果', `共 ${r.files.length} 个文件`)}${
          S.resultOpen
            ? `<ul style="margin:-8px 0 0;padding-left:18px" class="sm">${r.reports
                .map((p) => {
                  const seg: string[] = [];
                  if (p.flattened) seg.push('<span class="tag-warn">已整页拼合为图像</span>');
                  else if (p.remainingRgb === 0 || s.mode === 'rgb') seg.push('<span class="tag-ok">颜色已全部转换</span>');
                  else seg.push(`<span class="tag-warn">还有 ${p.remainingRgb} 处保持 RGB</span>`);
                  if (p.images.length) seg.push(`<span>图片 ${p.images.length} 张</span>`);
                  const down = p.images.filter((i) => i.newW).length;
                  if (down) seg.push(`<span>${down} 张已降采样</span>`);
                  if (p.hairlinesFixed) seg.push(`<span>加粗细线 ${p.hairlinesFixed} 处</span>`);
                  if (p.spotsUsed.length) seg.push(`<span>专色：</span><span data-notr>${p.spotsUsed.map(esc).join(', ')}</span>`);
                  for (const l of p.leftovers) seg.push(`<span class="tag-warn">${esc(l)}</span>`);
                  return `<li><b data-notr style="font-weight:600">${esc(p.page)}</b> · ${seg.join(' · ')}</li>`;
                })
                .join('')}</ul>`
            : ''
        }`
      : ''
  }`;
}

// ---------- 04 more settings ----------

const MORE_KEYS = ['bleedSidesOn', 'bleedSides', 'autoBleed', 'trimLine', 'markWeight', 'dielineMode', 'dielineNames', 'dielineFile', 'spotPolicy', 'keepSpots', 'textOutline', 'compression', 'imageCompression', 'jpegQuality', 'maxPpi', 'bookmarks', 'keepLinks', 'alsoDigital', 'output', 'scalePct'] as const;

function viewMore() {
  const s = S.settings;
  const isPdf = s.format === 'pdf';
  const spots = Object.values(s.overrides).filter((o) => o.spot);
  const fin = Object.entries(s.colorFinishing);
  const sect = (title: string, body: string) => `<div class="section" style="padding-bottom:6px;border-bottom:1px solid var(--line)"><span class="kicker" style="padding:10px 0 2px">${title}</span>${body}</div>`;
  return `${sheetHead('专业设置', `<button class="link muted" data-act="more-reset">恢复默认</button>`)}
  <div style="display:flex;flex-direction:column;margin-top:-18px">
  ${sect(
    '出血与标记',
    `${tline('bleedSidesOn', '四边出血分别设置')}
    ${s.bleedSidesOn ? `<div style="padding:2px 0 8px">${sides4('bleedSides')}</div>` : ''}
    ${chk('autoBleed', '自动延伸未设出血画板的贴边元素', '（不修改设计稿）')}
    ${isPdf ? tline('trimLine', '成品框线', '校对用，裁切位置画一圈细线') : ''}
    ${isPdf ? `<div class="line"><span class="l">标记线宽</span>${num('markWeight', { min: 0.1, max: 1, step: 0.05, w: 64 })}<span class="unit">pt</span></div>` : ''}`,
  )}
  ${
    s.mode !== 'rgb'
      ? sect(
          '刀版与专色',
          `<div class="line"><span class="l">识别刀线和工艺</span>${seg('dielineMode', [['off', '关闭'], ['auto', '按图层名'], ['manual', '手动指定']])}</div>
    ${s.dielineMode === 'manual' ? `<div class="line">${txt('dielineNames', '专色名，例如 CutContour, Kiss Cut')}</div>` : ''}
    <details class="settings-help"><summary>刀线与工艺识别规则</summary><p class="hint xs">图层名以下面关键词开头的图层，会单独输出成对应的专色版，并自动叠印。刀线、折线、压痕、打孔会输出成真正的单线路径。也可以在「检查 → 颜色」里把某个颜色指定为刀线或工艺。</p><div class="divided">${DIELINE_KEYWORDS.map((d) => `<div class="line" style="min-height:28px"><span class="mono" style="width:110px;flex:none">${d.spot}</span><span class="muted xs ell" data-notr>${d.key.source.replace(/^\^\\\[\?\\s\*\(/, '').replace(/\)$/, '').replace(/\|/g, ' / ').replace(/\.\?/g, ' ')}</span></div>`).join('')}</div></details>
    ${fin.length ? `<p class="hint xs" style="padding-bottom:4px">按颜色指定：<span data-notr>${fin.map(([hex, sp]) => `${hex} → ${esc(sp)}`).join('，')}</span></p>` : ''}
    ${isPdf ? `<div class="line"><span class="l">刀版输出</span>${seg('dielineFile', [['inline', '随文件'], ['separate', '单独文件'], ['both', '两种都要']])}</div>` : ''}
    <div class="line"><span class="l">专色</span>${seg('spotPolicy', [['preserve', '保留专色'], ['flatten', '转为四色'], ['keepListed', '只保留指定']])}</div>
    ${s.spotPolicy === 'keepListed' ? `<div class="line">${txt('keepSpots', '专色名，用逗号分隔')}</div>` : ''}
    ${spots.length ? `<p class="hint xs" style="padding-bottom:4px">当前专色：<span data-notr>${spots.map((o) => esc(o.spot!.name)).join('、')}</span></p>` : ''}`,
        )
      : ''
  }
  ${sect(
    '文字与图片',
    `${isPdf ? `<div class="line"><span class="l">文字</span>${seg('textOutline', [['none', '全部保留'], ['perNode', '按图层设置'], ['all', '全部转曲']])}</div>` : ''}
    <div class="line"><span class="l">图片压缩</span>${seg('compression', [['light', '轻度'], ['balanced', '均衡'], ['strong', '强力'], ['custom', '自定义']])}</div>
    ${
      s.compression === 'custom'
        ? `<div class="line"><span class="l">降采样</span>${sel('maxPpi', [[0, '不降采样'], [300, '超过 450ppi 降到 300ppi'], [450, '超过 675ppi 降到 450ppi'], [600, '超过 900ppi 降到 600ppi']], 'num')}</div>
    <div class="line"><span class="l">编码</span>${sel('imageCompression', [['auto', '自动（照片 JPEG，图形无损）'], ['jpeg', '全部 JPEG'], ['lossless', '全部无损']])}</div>
    ${s.imageCompression !== 'lossless' ? `<div class="line"><span class="l">JPEG 质量</span>${num('jpegQuality', { min: 50, max: 100 })}</div>` : ''}`
        : `<p class="hint xs" style="padding-bottom:6px">${{ light: '图片几乎不压缩，质量最高', balanced: 'JPEG 90，超过 675ppi 的图片降到 450ppi', strong: 'JPEG 80，图片统一降到 300ppi，文件最小' }[s.compression]}</p>`
    }`,
  )}
  ${
    isPdf
      ? sect(
          '文件信息与安全',
          `<div class="line" style="gap:18px">${chk('bookmarks', '每页书签')}${s.pdfx === 'none' || s.mode === 'rgb' ? chk('keepLinks', '保留超链接') : ''}</div>
    <div class="line"><span style="width:64px" class="muted sm">作者</span>${txt('author')}</div>
    <div class="line"><span style="width:64px" class="muted sm">主题</span>${txt('subject')}</div>
    <div class="line"><span style="width:64px" class="muted sm">关键词</span>${txt('keywords', '用逗号分隔')}</div>
    ${
      s.pdfx === 'none' || s.mode === 'rgb'
        ? `<div class="line"><span style="width:64px" class="muted sm">打开密码</span><input type="text" id="pdf-password" value="${esc(S.password)}" placeholder="留空则不加密"></div><p class="hint xs" style="padding-bottom:6px">AES-256 加密。密码不会被保存。</p>`
        : `<div class="line"><span class="l">打开密码</span><span class="muted xs">PDF/X 不允许加密，需要密码请在印刷方案里改用普通 PDF</span></div>`
    }`,
        )
      : ''
  }
  ${sect(
    '附加输出',
    `${isPdf && s.mode !== 'rgb' ? tline('alsoDigital', '同时导出 RGB 屏幕版', '无出血无标记，发给客户看') : ''}
    <div class="line"><span class="l">${isPdf ? '每页单独一个文件' : '每页单独下载（不打包）'}</span><button class="toggle ${s.output === 'separate' ? 'on' : ''}" data-act="seg" data-path="output" data-v='"${s.output === 'separate' ? 'merged' : 'separate'}"'></button></div>
    ${isPdf ? `<div class="line"><span class="l">输出缩放</span>${num('scalePct', { min: 10, max: 1000, step: 5, w: 64 })}<span class="unit">%</span></div>` : ''}`,
  )}
  </div>`;
}

// ---------- 05 imposition ----------

function viewImposition() {
  const s = S.settings;
  const imp = s.imp;
  const kinds: ImpKind[] = ['none', 'spreads', 'booklet', 'nup', 'duplex'];
  const f = orderedFrames()[0];
  let detail = '';
  if (imp.kind === 'booklet') detail = `<div class="line"><span class="l">翻页方向</span>${seg('imp.rtl', [[false, '从左往右'], [true, '从右往左']])}</div><p class="hint xs">页数会补齐到 4 的倍数（空白页），按折页顺序排成正反面，双面打印后对折装订即可。从右往左适合竖排中文、日文、阿拉伯文。</p>`;
  if (imp.kind === 'spreads') detail = `<p class="hint">第 1 页单独一页，之后两页一组排成跨页，方便整体校对。</p>`;
  if (imp.kind === 'none') detail = `<p class="hint">每个画板单独一页输出。</p>`;
  if ((imp.kind === 'nup' || imp.kind === 'duplex') && f) {
    const g = nupGrid()!;
    const n = orderedFrames().length;
    const sheets = impSheets(n);
    const scale = Math.min(104 / imp.sheetW, 148 / imp.sheetH);
    const cells = Array.from({ length: g.per }, (_, i) => `<i style="display:block;width:${g.cw * scale}px;height:${g.ch * scale}px;background:var(--accent);opacity:.55"></i>`).join('');
    detail = `<div style="display:flex;gap:16px">
      <div style="width:132px;flex:none;display:flex;flex-direction:column;align-items:center;gap:6px"><div class="well" style="width:132px;height:180px;display:flex;align-items:center;justify-content:center;padding:0"><div style="width:${imp.sheetW * scale}px;height:${imp.sheetH * scale}px;background:var(--bg);box-shadow:0 1px 3px oklch(0 0 0 / .15);display:flex;align-items:center;justify-content:center"><div style="display:grid;grid-template-columns:repeat(${g.cols}, ${g.cw * scale}px);gap:${Math.max(1, imp.gutter * scale)}px">${cells}</div></div></div><span class="muted xs num">共 ${sheets} 张</span></div>
      <div class="grow" style="display:flex;flex-direction:column">
        <div class="line"><span class="l muted sm">印刷纸张</span>${sel('imp.sheet', [...SHEET_PRESETS.map((p) => [p.id, p.name] as [string, string]), ['custom', '自定义']])}</div>
        ${imp.sheet === 'custom' ? `<div class="line"><span class="l muted sm">纸宽 × 高</span>${num('imp.sheetW', { min: 50, w: 56 })}×${num('imp.sheetH', { min: 50, w: 56 })}</div>` : ''}
        <div class="line"><span class="l muted sm">每张排（0 = 自动）</span>${num('imp.cols', { min: 0, w: 46 })}×${num('imp.rows', { min: 0, w: 46 })}</div>
        <div class="line"><span class="l muted sm">间距</span>${num('imp.gutter', { min: 0, step: 0.5, w: 56 })}<span class="unit">mm</span></div>
        <div class="line"><span class="l muted sm">印数</span>${num('imp.copies', { min: 1, w: 56 })}<span class="unit">份</span></div>
        ${imp.kind === 'nup' ? `<div class="line"><span class="l muted sm">同一成品铺满整版</span>${toggle('imp.repeat')}</div>` : ''}
      </div></div>
      <p class="hint xs"><span>每张 ${g.cols} × ${g.rows} = ${g.per} 个，共 ${sheets} 张，裁切线画在拼版外侧。</span> ${imp.kind === 'duplex' ? '<span>第 1、3、5… 页为正面，2、4、6… 页为反面；反面自动左右镜像，长边翻转后与正面对齐。</span>' : imp.repeat ? '' : '<span>按页序依次排。</span>'}</p>`;
  }
  return `${sheetHead('拼版方式', f ? `<span class="muted xs" data-notr>${esc(f.name)}</span>` : '')}
  <div class="picks" style="margin-top:-6px">${kinds
    .map((k) => `<button class="pick ${imp.kind === k ? 'on' : ''}" data-act="seg" data-path="imp.kind" data-v='"${k}"'><span class="art">${IMP_ART[k]}</span><span style="display:flex;flex-direction:column;gap:1px"><span class="t">${impLabel(k)[0]}</span><span class="d">${impLabel(k)[1]}</span></span></button>`)
    .join('')}</div>
  <div class="section" style="gap:8px">${detail}</div>`;
}

// ---------- 10 print profile ----------

function viewProfile() {
  const s = S.settings;
  const prof = currentProfile();
  const profOpts: [string, string][] = [['', S.profiles.length ? '— 选择 —' : '尚未导入 ICC'], ...S.profiles.map((p) => [p.id, p.name] as [string, string])];
  const row = (id: string, name: string, desc: string, del = '') => {
    const on = s.profileId === id;
    return `<div class="${on ? '' : 'prow'}" style="border-bottom:1px solid var(--line);${on ? 'padding:12px 0' : ''}" ${on ? '' : `data-act="profile" data-v="${id}"`}>
      <div style="display:flex;align-items:center;gap:10px" ${on ? '' : ''}><span class="radio ${on ? 'on' : ''}"></span><span class="grow" style="display:flex;flex-direction:column"><span style="font-weight:${on ? 600 : 500}" ${id.startsWith('user:') ? 'data-notr' : ''}>${esc(name)}${on && profileDirty() ? ` <span class="muted xs" style="font-weight:400">${tr('（已修改）')}</span>` : ''}</span><span class="muted xs">${desc}</span></span>${del}</div>
      ${on ? profileDetails(profOpts, prof) : ''}</div>`;
  };
  return `${sheetHead('印刷方案', `<button class="link" data-act="import-json">导入</button><button class="link" data-act="export-json">导出</button>`)}
  <p class="hint" style="margin-top:-8px">一个方案 = 印刷厂的一套要求。选好以后，颜色转换、黑色处理、PDF 标准都按它来，一般不用再改。</p>
  <div style="margin-top:-8px">
    ${BUILTIN_PROFILES.map((p) => row(p.id, tr(p.name), p.desc)).join('')}
    ${S.presets.map((p, i) => row('user:' + i, p.name, '我的方案', `<button class="link muted" data-act="del-preset" data-v="${i}" title="删除">删除</button>`)).join('')}
    ${!s.profileId ? `<div style="padding:12px 0;border-bottom:1px solid var(--line)"><div style="display:flex;align-items:center;gap:10px"><span class="radio on"></span><span style="font-weight:600">当前设置（自定义）</span></div>${profileDetails(profOpts, prof)}</div>` : ''}
    <div class="line" style="min-height:48px">${IC.plus}<input type="text" id="preset-name" placeholder="把当前设置存为新方案，例如「某某印刷厂 · 铜版纸」"><button class="btn small" data-act="save-preset">保存</button></div>
  </div>`;
}

function profileDetails(profOpts: [string, string][], prof: Profile | undefined) {
  const s = S.settings;
  const k = (t: string) => `<span class="kicker" style="padding:10px 0 2px">${t}</span>`;
  return `<div style="display:flex;flex-direction:column;padding:6px 0 0 26px">
    ${k('颜色')}
    <div class="line"><span class="l">输出色彩</span>${seg('mode', [['cmyk', 'CMYK'], ['rgb', 'RGB'], ['gray', '灰度']])}</div>
    ${
      s.mode === 'cmyk'
        ? `<div class="line"><span class="l" style="flex:none;width:96px">ICC 配置文件</span>${sel('iccId', profOpts)}<button class="link" data-act="import-icc">导入</button>${prof ? `<button class="link muted" data-act="del-icc">移除</button>` : ''}</div>
    ${!S.profiles.length ? `<p class="hint xs">请导入印刷厂提供的 ICC 文件。国内胶印一般用 Japan Color 2001 Coated，欧洲用 FOGRA39 / PSO Coated v3，北美用 GRACoL / SWOP。可从 <a href="https://www.adobe.com/support/downloads/iccprofiles/iccprofiles_mac.html" target="_blank">Adobe</a> / <a href="https://www.eci.org/en/downloads" target="_blank">ECI</a> 免费下载。</p>` : ''}
    <div class="line"><span class="l">渲染意图</span>${sel('intent', [[1, '相对比色（推荐）'], [0, '可感知（照片多时更顺滑）'], [2, '饱和度（图表、色块）'], [3, '绝对比色（模拟纸白）']], 'num')}</div>
    <div class="line">${chk('bpc', '黑场补偿', '（保留暗部层次）')}</div>
    ${k('黑色与墨量')}
    <div class="line">${chk('pureBlackToK', '纯黑只用 K 版', '（小字不发虚）')}</div>
    <div class="line">${chk('grayToK', '灰色只用 K 版', '（灰字更干净）')}</div>
    <div class="line">${chk('richBlackOn', '大面积黑色用四色黑', '（≥1cm 色块，文字不受影响）')}</div>
    ${
      s.richBlackOn
        ? `<div class="line" style="padding-left:24px">${sel('richPreset', [...Object.entries(RICH_PRESETS).map(([key, v]) => [key, v[0]] as [string, string]), ['custom', '自定义']])}</div>
    <div class="line" style="padding-left:24px;gap:6px" data-notr>C${num('richBlack.c', { min: 0, max: 100, w: 48 })}M${num('richBlack.m', { min: 0, max: 100, w: 48 })}Y${num('richBlack.y', { min: 0, max: 100, w: 48 })}K${num('richBlack.k', { min: 0, max: 100, w: 48 })}</div>`
        : ''
    }
    <div class="line"><span class="l">总墨量上限</span>${num('tacLimit', { min: 0, max: 400, step: 10, w: 64 })}<span class="unit">%</span></div>
    <p class="hint xs">铜版纸常用 320，胶版纸 280–300，报纸 240；0 = 不限制。</p>`
        : `<p class="hint xs">${s.mode === 'gray' ? '所有颜色和图片会转成单色灰度（只用黑色油墨），适合黑白印刷。' : '保持 RGB 颜色，适合数码快印或屏幕阅读。出血、裁切线等功能照常可用。'}</p>`
    }
    ${k('输出')}
    ${s.mode !== 'rgb' ? `<div class="line"><span class="l">PDF 标准</span>${sel('pdfx', [['x4', 'PDF/X-4（推荐，支持透明）'], ['x1a', 'PDF/X-1a（老设备、报纸常用）'], ['x3', 'PDF/X-3'], ['none', '普通 PDF']])}</div>` : ''}
    ${(s.pdfx === 'x1a' || s.pdfx === 'x3') && s.mode !== 'rgb' ? `<div class="line"><span class="l">透明拼合精度</span>${sel('flattenDpi', [[300, '300 dpi'], [450, '450 dpi'], [600, '600 dpi（小字更清晰）']], 'num')}</div><p class="hint xs">X-1a / X-3 不允许透明。含阴影、半透明、混合模式的页面会整页转成图像，其余页面保持矢量。</p>` : ''}
    <div class="line">${chk('minStrokeOn', '细线自动加粗')}<span class="grow"></span>${num('minStrokePt', { min: 0, max: 2, step: 0.05, w: 64 })}<span class="unit">pt</span></div>
    ${s.mode === 'cmyk' ? `<div class="line">${chk('overprintBlack', '100% 黑色自动叠印', '（防止黑字周围露白）')}</div><div class="line">${chk('removeWhiteOverprint', '去掉白色对象的叠印', '（否则白色会消失）')}</div>` : ''}
  </div>`;
}

// ---------- 06–09 check ----------

const CAT_NAMES: Record<string, string> = { geometry: '出血与版面', color: '颜色与墨量', resolution: '图片分辨率', transparency: '透明效果', text: '文字与字体', annotation: '注释', spot: '专色与刀版' };

function viewCheck() {
  if (!S.frames.length) return noSelection('在画布上选择要检查的画板');
  const is = currentIssues();
  const nIss = is ? is.filter((i) => i.level === 'error' || i.level === 'warning').length : 0;
  const tabs: [CheckTab, string][] = [
    ['issues', `问题${nIss ? ` <b class="num" style="color:var(--warn);font-weight:600">${nIss}</b>` : ''}`],
    ['preview', '印刷预览'],
    ['colors', `颜色${S.colors ? ` <span class="muted num">${S.colors.length}</span>` : ''}`],
    ['text', `文字${S.texts ? ` <span class="muted num">${S.texts.length}</span>` : ''}`],
  ];
  const body = { issues: viewIssues, preview: viewPreview, colors: viewColors, text: viewText }[S.checkTab]();
  return `<div class="view-heading"><h1>检查印刷质量</h1><p class="hint">先了解影响，再决定如何处理。</p></div><div class="seg full" role="group" aria-label="${tr('检查内容')}">${tabs.map(([v, l]) => `<button data-act="ctab" data-v="${v}" aria-pressed="${S.checkTab === v}" class="${S.checkTab === v ? 'on' : ''}">${l}</button>`).join('')}</div>${body}`;
}

function viewIssues() {
  const s = S.settings;
  const is = currentIssues();
  if (!is) return `<section class="quality"><div class="grow"><h2>${S.pendingIssuesKey === checkKey() ? '正在检查…' : S.checkError ? '检查未完成，请重试' : '需要更新检查结果'}</h2><p class="hint">${S.checkError ? esc(S.checkError) : '旧结果不再作为当前导出的依据。'}</p></div>${S.pendingIssuesKey === checkKey() ? '' : '<button class="btn" data-act="preflight">重新检查</button>'}</section>${viewCheckStandards()}`;
  const list = is.filter((i) => i.level !== 'pass');
  const count = (l: string) => list.filter((i) => i.level === l).length;
  const err = count('error'),
    warn = count('warning'),
    info = count('info');
  const fixable = list.filter((i) => i.fix && (i.fix.startsWith('k100:') || i.fix === 'removeWhiteOverprint' || (i.fix === 'autoBleed' && !s.autoBleed)));
  const order = { error: 0, warning: 1, info: 2, pass: 3 } as Record<string, number>;
  return `
  <div class="section-title"><div class="grow"><h2>${err || warn ? `${err + warn} 项风险需要处理或确认` : '检查完成，未发现已知风险'}</h2><p class="hint xs">${err} 个错误 · ${warn} 个提醒 · ${info} 个提示</p></div><button class="btn" data-act="preflight">重新检查</button></div>
  ${fixable.length ? `<div><button class="btn" data-act="fix-all">全部修复</button><span class="muted xs"> · 仅调整导出设置</span></div>` : ''}
  ${
    list.length
      ? `<div class="issue-list">${list
          .sort((a, b) => order[a.level] - order[b.level])
          .map(
            (i) => `<article class="issue-card"><div class="section-title"><h2>${CAT_NAMES[i.cat] || '提示'}</h2><span class="issue-level ${i.level}">${{ error: '错误', warning: '风险', info: '提示', pass: '通过' }[i.level]}</span></div><p class="msg">${esc(i.msg)}</p>${i.frame ? `<p class="hint xs" data-notr>${esc(i.frame)}</p>` : ''}<div class="issue-actions">${fixButton(i)}${i.nodeId ? `<button class="link" data-act="select" data-v="${i.nodeId}">在画布上定位</button>` : ''}</div>${i.fix ? `<p class="hint xs">${i.fix === 'upscale' ? '替换或放大图片会修改原稿；放大不会补回缺失的细节。' : '仅调整导出设置，不修改设计稿。'}</p>` : ''}</article>`,
          )
          .join('')}</div>`
      : `<div class="quality ok"><span class="dot ok"></span><p class="hint">检查有范围，送印前请核对印刷厂要求。</p></div>`
  }
  <p class="hint xs">检查是最近一次快照，改稿后请重新检查。</p>
  ${disclose('pass-open', S.passOpen, '检查范围与图片', '出血、版面、图片、文字及部分颜色问题')}
  ${
    S.passOpen && S.images.length
      ? `<div class="divided" style="margin-top:-14px">${S.images.map((im) => `<div class="line" data-act="select" data-v="${im.id}" style="cursor:pointer"><span class="l ell" data-notr>${esc(im.name)}</span><span class="muted mono">${im.px}</span><span class="${im.ppi >= s.minPpi ? 'tag-ok' : 'tag-warn'} sm num" style="width:64px;text-align:right">${im.ppi} ppi</span></div>`).join('')}</div>`
      : ''
  }
  ${viewCheckStandards()}`;
}

function viewCheckStandards() {
  const s = S.settings;
  return `<div class="well" style="display:flex;flex-direction:column;gap:6px">
    <div style="display:flex;align-items:center;gap:8px"><span class="muted xs grow">检查标准：图片 ≥ ${s.minPpi} ppi · 线条 ≥ ${s.minStrokePt} pt · 字号 ≥ ${s.minTextPt} pt</span><button class="link" data-act="std-open">${S.stdOpen ? '收起' : '修改'}</button></div>
    ${
      S.stdOpen
        ? `<div class="line"><label class="l sm" for="setting-minPpi">最低分辨率</label>${num('minPpi', { min: 72, max: 600, step: 10 })}<span class="unit">ppi</span></div>
    <div class="line"><label class="l sm" for="setting-minStrokePt">最细线条</label>${num('minStrokePt', { min: 0, max: 2, step: 0.05 })}<span class="unit">pt</span></div>
    <div class="line"><label class="l sm" for="setting-minTextPt">最小字号</label>${num('minTextPt', { min: 3, max: 12, step: 0.5 })}<span class="unit">pt</span></div>
    ${chk('blockLowPpi', '有图片低于最低分辨率时，禁止导出')}
    <div><button class="btn small" data-act="preflight">按新标准重新检查</button></div>`
        : ''
    }
  </div>`;
}

function fixButton(i: Issue) {
  if (!i.fix) return '';
  if (i.fix === 'icc') return `<button class="btn" data-act="sheet" data-v="profile">选择颜色配置</button>`;
  if (i.fix.startsWith('k100:')) return `<button class="btn small" data-act="fix-k100" data-v="${i.fix.slice(5)}">改为单色黑</button>`;
  if (i.fix === 'upscale' && i.nodeId) return `<button class="btn small" data-act="upscale" data-v="${i.nodeId}">放大 2 倍</button><button class="link muted" data-act="replace-image" data-v="${i.nodeId}">替换图片</button>`;
  if (i.fix === 'autoBleed') return S.settings.autoBleed ? `<span class="muted xs">导出时自动延伸</span>` : `<button class="btn small" data-act="tg" data-path="autoBleed">导出时自动加出血</button>`;
  if (i.fix === 'removeWhiteOverprint') return `<button class="btn small" data-act="fix-white">去掉叠印</button>`;
  return '';
}

function colorIssues(): Issue[] {
  const out: Issue[] = [];
  const s = S.settings;
  if (s.mode !== 'cmyk') return out;
  if (!currentProfile()) out.push({ level: 'warning', cat: 'color', msg: '没有选择 ICC 配置文件，将用简单公式换算 CMYK，颜色可能偏差较大。请在“印刷方案”里导入。', fix: 'icc' });
  for (const c of S.colors || []) {
    const { c: cm, kind } = cmykFor(c.hex);
    if (kind === 'finish') continue;
    if (kind !== 'spot' && s.tacLimit && tac(cm) > s.tacLimit + 0.5)
      out.push({ level: 'warning', cat: 'color', nodeId: c.sampleNode, msg: `颜色 ${c.hex} 总墨量 ${Math.round(tac(cm))}% 超过 ${s.tacLimit}%（导出时会自动压到上限）。` });
    const [r, g, b] = hexToRgb(c.hex);
    if (kind === 'icc' && engine && !c.inGradient) {
      const de = engine.gamutDeltaE(r, g, b, cm);
      if (de > 10) out.push({ level: 'info', cat: 'color', nodeId: c.sampleNode, msg: `颜色 ${c.hex} 超出印刷色域（色差 ΔE ${de.toFixed(0)}），印出来会偏灰。可以在“颜色”里手动指定 CMYK 或改用专色。` });
    }
    const ov = s.overrides[c.hex];
    if (ov?.spot && c.inGradient) out.push({ level: 'warning', cat: 'spot', nodeId: c.sampleNode, msg: `专色「${ov.spot.name}」用在了渐变里，渐变部分会按四色输出。` });
    if (ov?.overprint && tac(cm) < 1) out.push({ level: 'error', cat: 'color', nodeId: c.sampleNode, msg: `白色 ${c.hex} 设置了叠印，印刷时会消失。`, fix: 'removeWhiteOverprint' });
  }
  return out;
}

function viewPreview() {
  const p = S.preview;
  const frames = orderedFrames();
  const idx = Math.min(S.previewIdx, frames.length - 1);
  const st = p?.data?.stats;
  if (!p || p.id !== frames[idx]?.id) return `<div class="empty">正在生成预览…</div>`;
  const chip = (mode: string, label: string) => `<button class="chip ${p.mode === mode ? 'on' : ''}" data-act="pv-mode" data-v="${mode}">${label}</button>`;
  const plate = (m: string, bg: string, fg = '#fff') => `<button class="plate" data-act="pv-mode" data-v="${m}" style="background:${bg};color:${fg};border:0;cursor:pointer;${p.mode === m ? 'box-shadow:0 0 0 2px var(--bg),0 0 0 3.5px var(--accent)' : ''}">${m.toUpperCase()}</button>`;
  return `
  <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${chip('split', '对比')}${chip('proof', '印刷效果')}${chip('original', '原稿')}<span class="chip ${'cmyk'.includes(p.mode) && p.mode.length === 1 ? 'on' : ''}" style="padding-right:4px;cursor:default"><span>分色</span>${plate('c', '#00A0E9')}${plate('m', '#E5007D')}${plate('y', '#FFE100', '#1d1d1f')}${plate('k', '#1d1d1f').replace('border:0', 'border:1px solid var(--fg3)')}</span>${chip('tac', '墨量')}${chip('gamut', '超色域')}</div>
  <div class="pv">${p.mode === 'split' ? `<span class="lab" style="left:12px">原稿</span><span class="lab" style="right:12px">印出来的样子</span>` : ''}<canvas id="pv-canvas"></canvas>
    <div class="pager"><button data-act="pv-page" data-v="-1" ${idx <= 0 ? 'disabled' : ''}>‹</button><span class="num" data-notr>${idx + 1} / ${frames.length}</span><button data-act="pv-page" data-v="1" ${idx >= frames.length - 1 ? 'disabled' : ''}>›</button></div></div>
  ${p.mode === 'split' ? `<input type="range" min="0" max="100" value="${Math.round(p.split * 100)}" data-act="pv-split" style="width:100%;margin-top:-10px">` : ''}
  ${
    st
      ? `<div class="stats rule" style="border-bottom:1px solid var(--line)"><div><span class="muted xs">最大墨量</span><b class="${st.tacMax > S.settings.tacLimit ? 'tag-err' : ''}">${st.tacMax}%</b></div><div><span class="muted xs">超墨量面积</span><b class="${st.tacOver > 0 ? 'tag-warn' : ''}">${(st.tacOver * 100).toFixed(1)}%</b></div><div><span class="muted xs">超色域面积</span><b class="${st.gamutOut > 0.02 ? 'tag-warn' : ''}">${(st.gamutOut * 100).toFixed(1)}%</b></div></div>`
      : ''
  }
  <div class="line" style="margin-top:-8px"><span class="l">模拟纸张白</span><span class="muted xs">纸张略偏暖，白色不是纯白</span><button class="toggle ${p.paper ? 'on' : ''}" data-act="pv-paper"></button></div>
  ${S.settings.mode !== 'cmyk' ? `<p class="hint">当前印刷方案是 ${S.settings.mode === 'rgb' ? 'RGB' : '灰度'}，印刷模拟仅在 CMYK 下有意义。</p>` : ''}
  <p class="hint xs">“墨量”里红色区域超过总墨量上限（导出时会自动压到上限）；“超色域”里标出的区域印刷时会明显变灰、变暗。</p>`;
}

function paintPreview() {
  const p = S.preview;
  const cv = document.getElementById('pv-canvas') as HTMLCanvasElement | null;
  if (!p || !cv || !engine) return;
  if (!p.data) {
    p.data = buildProof(p.src, engine, p.paper, S.settings.tacLimit);
    setTimeout(render, 0); // stats appear after the first build
    return;
  }
  paint(cv, p.data, p.mode, p.split, S.settings.tacLimit);
}

function viewColors() {
  const s = S.settings;
  if (s.mode !== 'cmyk') return `<div class="empty"><span>当前印刷方案是 ${s.mode === 'rgb' ? 'RGB' : '灰度'}，颜色映射、专色和总墨量只在 CMYK 下生效。</span><button class="btn" data-act="sheet" data-v="profile">更换印刷方案</button></div>`;
  if (!S.colors) return `<div class="empty">正在扫描颜色…</div>`;
  const rows = S.colors
    .map((c) => {
      const { c: cm, kind } = cmykFor(c.hex);
      const ov = s.overrides[c.hex];
      const proof = engine && kind !== 'finish' ? engine.proofHex(cm) : c.hex;
      const [r, g, b] = hexToRgb(c.hex);
      const de = engine && kind === 'icc' ? engine.gamutDeltaE(r, g, b, cm) : 0;
      const val = kind === 'finish' ? esc(s.colorFinishing[c.hex]) : kind === 'spot' ? esc(ov!.spot!.name) : `<span class="mono">${[cm.c, cm.m, cm.y, cm.k].map((x) => Math.round(x)).join(' ')}</span>`;
      let tag = '';
      if (kind === 'finish') tag = `<span class="tag-info">工艺</span>`;
      else if (kind === 'spot') tag = `<span class="tag-accent">专色${ov?.overprint ? ' · 叠印' : ''}</span>`;
      else if (kind === 'custom') tag = `<span>自定义${ov?.overprint ? ' · 叠印' : ''}</span>`;
      else if (de > 10) tag = `<span class="tag-warn">超色域</span>`;
      else if (cm.c === 0 && cm.m === 0 && cm.y === 0 && cm.k > 0) tag = `<span class="tag-ok">${cm.k >= 99.5 ? '单色黑' : '只用 K'}</span>`;
      else if (s.tacLimit && tac(cm) > s.tacLimit + 0.5) tag = `<span class="tag-warn">墨量 ${Math.round(tac(cm))}%</span>`;
      else if (ov?.overprint) tag = `<span>叠印</span>`;
      const open = S.expanded === c.hex;
      return `<div class="cgroup ${open ? 'open' : ''}"><div class="crow" data-act="expand" data-v="${c.hex}"><span class="sw2"><i style="background:${c.hex}" title="设计稿颜色"></i><i style="background:${proof}" title="印刷效果预览"></i></span><span class="grow" style="display:flex;flex-direction:column;min-width:0"><span class="mono">${c.hex}</span>${c.names?.length ? `<span class="muted xs ell" data-notr>${esc(c.names[0])}</span>` : ''}</span><span class="val ell" data-notr>${val}</span><span class="tag">${tag}</span><span class="cnt num">×${c.count}</span></div>${open ? colorEditor(c) : ''}</div>`;
    })
    .join('');
  return `
  <div class="line" style="margin-top:-6px"><span class="muted sm l">${S.colors.length} 种颜色，默认按印刷方案自动转换，点开可单独调整</span><button class="btn small" data-act="scan-colors">重新扫描</button></div>
  ${S.colors.length ? `<div class="divided rule" style="border-bottom:1px solid var(--line);margin-top:-10px">${rows}</div>` : `<div class="empty">没有找到颜色</div>`}
  <button class="settings-link" data-act="sheet" data-v="resources"><span>色板与颜色映射</span>${IC.right}</button>`;
}

function viewColorResources() {
  const s = S.settings;
  const cur = allMaps().find((m) => m.name === s.activeMap);
  const dirty = s.activeMap && JSON.stringify(cur?.overrides || {}) !== JSON.stringify(s.overrides);
  return `${sheetHead('色板与颜色映射')}
    <section class="settings-group"><h2>颜色映射表</h2>
      ${s.activeMap ? `<p class="hint" data-notr>${esc(s.activeMap)}${dirty ? ` ${tr('（未保存）')}` : ''}</p>` : ''}
      <div class="line"><label class="sm" for="map-select">应用</label><select id="map-select" data-act="load-map"><option value="">— 不使用 —</option>${allMaps().map((m) => `<option ${m.name === s.activeMap ? 'selected' : ''}>${esc(m.name)}${m.file ? '（本文件）' : ''}</option>`).join('')}</select>${s.activeMap ? '<button class="link muted" data-act="del-map">删除</button>' : ''}</div>
      <div class="line"><label class="sm" for="map-name">名称</label><input type="text" id="map-name" placeholder="映射表名称，例如：品牌色 2026" value="${esc(s.activeMap)}"><button class="btn small" data-act="save-map">保存</button></div>
      ${chk('mapsInFile', '保存到当前 Figma 文件', '（团队成员打开同一文件都能用）')}
    </section>
    <section class="settings-group"><h2>色板库</h2><p class="hint">${S.lib.length ? `已导入 ${S.lib.length} 个色板` : '可导入潘通 / RAL / HKS 色板（.ase 或 CSV）'}</p><div class="line"><button class="btn" data-act="import-lib">导入</button>${S.lib.length ? '<button class="link muted" data-act="clear-lib">清空</button>' : ''}</div></section>`;
}

function colorEditor(c: ScannedColor) {
  const s = S.settings;
  const ov = s.overrides[c.hex];
  const kind = s.colorFinishing[c.hex] ? 'finish' : ov?.spot ? 'spot' : ov?.cmyk ? 'custom' : 'icc';
  const COL: Record<string, string> = { c: '#00A0E9', m: '#E5007D', y: '#C9A800', k: 'var(--fg)' };
  const slider = (k: keyof CMYK, v: number) =>
    `<div class="slider"><b style="color:${COL[k]}">${k.toUpperCase()}</b><input type="range" min="0" max="100" step="1" value="${v}" data-act="cmyk" data-hex="${c.hex}" data-k="${k}"><input type="number" min="0" max="100" value="${Math.round(v)}" data-act="cmyk" data-hex="${c.hex}" data-k="${k}"></div>`;
  const [r, g, b] = hexToRgb(c.hex);
  const icc = engine ? engine.iccCmyk(r, g, b) : { c: 0, m: 0, y: 0, k: 0 };
  const de = engine ? engine.gamutDeltaE(r, g, b, icc) : 0;
  return `<div class="cedit" data-stop="1">
    ${segRaw('ckind', kind, [['icc', '按方案'], ['custom', '自定义 CMYK'], ['spot', '专色'], ['finish', '刀线 / 工艺']], 'full').replace(/data-act="ckind"/g, `data-act="ckind" data-hex="${c.hex}"`)}
    ${kind === 'icc' ? `<p class="hint xs"><span>按方案换算</span> <span data-notr class="mono">${fmtC(icc)} · TAC ${Math.round(tac(icc))}% · ΔE ${de.toFixed(1)}</span> <span>${de > 10 ? '超出印刷色域，会偏灰' : de > 5 ? '略有偏差' : '准确'}</span>${c.inGradient ? ' <span>这个颜色用在渐变里。</span>' : ''}</p>` : ''}
    ${kind === 'custom' ? `<div class="sliders">${(['c', 'm', 'y', 'k'] as const).map((k) => slider(k, ov!.cmyk![k])).join('')}</div>` : ''}
    ${
      kind === 'spot'
        ? `<div class="line"><span class="sm" style="width:64px">专色名称</span><input type="text" list="spot-lib" data-act="spotname" data-hex="${c.hex}" value="${esc(ov!.spot!.name)}" placeholder="例如 PANTONE 186 C">${S.lib.length ? `<button class="link" data-act="nearest-spot" data-hex="${c.hex}">找最接近的</button>` : ''}</div>
    <div class="line"><span class="sm" style="width:64px">浓度</span><input type="range" min="1" max="100" value="${ov!.spot!.tint}" data-act="tint" data-hex="${c.hex}" style="flex:1"><span class="mono">${ov!.spot!.tint}%</span></div>
    <p class="hint xs">专色的 CMYK 替代值（屏幕预览和“转为四色”时使用）：</p>
    <div class="sliders">${(['c', 'm', 'y', 'k'] as const).map((k) => slider(k, ov!.spot!.alt[k])).join('')}</div>
    ${c.inGradient ? '<p class="hint xs" style="color:var(--warn)">注意：渐变里的专色无法单独成版，会按 CMYK 替代值输出。</p>' : ''}`
        : ''
    }
    ${
      kind === 'finish'
        ? `<div class="line"><span class="sm" style="width:64px">工艺版</span><select data-act="finish-name" data-hex="${c.hex}">${DIELINE_KEYWORDS.map((d) => `<option ${s.colorFinishing[c.hex] === d.spot ? 'selected' : ''}>${d.spot}</option>`).join('')}</select></div>
    <p class="hint xs">用这个颜色的描边会输出成单线刀线 / 折线（叠印），填充会输出成对应的工艺专色版（光油、白墨、烫金等），不会印成颜色。</p>`
        : ''
    }
    <div class="line" style="min-height:28px">${kind !== 'finish' ? `<label class="chk sm" style="min-height:0"><input type="checkbox" data-act="overprint" data-hex="${c.hex}" ${ov?.overprint ? 'checked' : ''}>叠印</label>` : ''}<span class="grow"></span>${ov || kind === 'finish' ? `<button class="link muted" data-act="reset-color" data-hex="${c.hex}">恢复默认</button>` : ''}</div>
    <datalist id="spot-lib">${S.lib.slice(0, 3000).map((l) => `<option value="${esc(l.name)}">`).join('')}</datalist>
  </div>`;
}

function viewText() {
  const s = S.settings;
  const t = S.texts;
  if (!t) return `<div class="empty">正在扫描文字…</div>`;
  const def = s.textOutline === 'none' ? 'none' : s.textOutline === 'all' ? 'all' : 'perNode';
  const missingFonts = t.filter((n) => n.missingFont).length;
  const sorted = [...t].sort((a, b) => +(b.missingFont || b.hasEffects) - +(a.missingFont || a.hasEffects));
  return `
  <div class="section" style="gap:8px">
    <span class="muted sm">导出时文字怎么处理</span>
    ${segRaw('tdefault', def, [['none', '全部保留文字'], ['perNode', '按图层设置'], ['all', '全部转曲']], 'full')}
    <p class="hint xs"><span>保留文字：PDF 里能选中、搜索（含中文）。转曲：变成图形，任何印刷机都不会缺字体。</span>${def === 'perNode' ? ' <span>下面可以逐个图层设置。</span>' : ''}</p>
    ${def === 'perNode' && t.length ? `<div style="display:flex;gap:12px"><button class="link" data-act="tall" data-v="live-noeff">有效果的转曲，其余保留</button></div>` : ''}
  </div>
  ${missingFonts ? `<div class="card warn sm">有 ${missingFonts} 个文字图层缺少字体，请先在 Figma 中安装或替换字体，否则导出的字形会被替换。</div>` : ''}
  ${
    t.length
      ? `<div class="divided rule" style="border-bottom:1px solid var(--line);margin-top:-6px">${sorted
          .map((n) => {
            const mode = def === 'perNode' ? n.mode : def === 'all' ? 'outline' : 'live';
            return `<div class="trow"><span class="grow" data-act="select" data-v="${n.id}" style="cursor:pointer;display:flex;flex-direction:column;min-width:0"><span class="ell" style="font-weight:500" data-notr>${esc(n.preview || n.name)}</span><span class="muted xs ell"><span data-notr>${esc(n.fonts.join('、'))} · ${n.size} pt · ${esc(n.frame)}</span></span></span><span style="width:52px;flex:none" class="xs">${n.missingFont ? '<span class="tag-err">缺字体</span>' : n.hasEffects ? '<span class="tag-warn">有效果</span>' : ''}</span><div class="seg" style="${def === 'perNode' ? '' : 'opacity:.5'}"><button data-act="tmode" data-v="${n.id}" data-m="live" class="${mode === 'live' ? 'on' : ''}">文字</button><button data-act="tmode" data-v="${n.id}" data-m="outline" class="${mode === 'outline' ? 'on' : ''}">转曲</button></div></div>`;
          })
          .join('')}</div>`
      : `<div class="empty">没有文字图层</div>`
  }`;
}

// ---------- 11 toolbox ----------

function viewTools() {
  const s = S.settings;
  const m = S.measure;
  const pickHex = engine ? engine.proofHex(s.pick) : '#ccc';
  const tool = (id: string, icon: string, title: string, desc: string, body: () => string) => {
    const open = S.toolOpen === id;
    return `<div class="tool"><button class="tool-h" data-act="tool" data-v="${id}" aria-expanded="${open}" aria-controls="tool-${id}"><span class="ic">${icon}</span><span class="grow">${title}</span>${IC.chev.replace('class="chev"', `class="chev ${open ? 'open' : ''}"`)}</button>${open ? `<div class="tool-b" id="tool-${id}"><p class="hint xs">${desc}</p>${body()}</div>` : ''}</div>`;
  };
  const measure = m.length
    ? m
        .slice(0, 4)
        .map(
          (n) => `<div style="display:flex;flex-direction:column;gap:6px"><div style="display:flex;gap:8px;align-items:baseline"><b class="grow ell" style="font-weight:600" data-notr>${esc(n.name)}</b><span class="muted xs">${n.type}</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${mbox('宽', 'w', n.id, toUnit((n.w * 25.4) / 72), S.settings.unit)}${mbox('高', 'h', n.id, toUnit((n.h * 25.4) / 72), S.settings.unit)}
        ${n.fontSize !== undefined ? mbox('字号', 'fontSize', n.id, n.fontSize, 'pt') : ''}${n.strokeWeight !== undefined ? mbox('描边', 'strokeWeight', n.id, n.strokeWeight, 'pt') : ''}${n.cornerRadius !== undefined ? mbox('圆角', 'cornerRadius', n.id, toUnit((n.cornerRadius * 25.4) / 72), S.settings.unit) : ''}
      </div></div>`,
        )
        .join('<div class="rule"></div>')
    : `<p class="hint">在画布上选中任意图层，这里会显示它的实际尺寸，可以直接改。</p>`;
  return `${sheetHead('画布工具', seg('unit', [['mm', 'mm'], ['cm', 'cm'], ['in', 'in'], ['pt', 'pt']]))}
  <p class="hint xs">直接修改画布上的图层</p>
  ${tool('measure', '<svg width="18" height="18" viewBox="0 0 18 18"><rect x="1.5" y="5.5" width="15" height="7" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M4.5 5.5v3M7.5 5.5v2M10.5 5.5v3M13.5 5.5v2" stroke="currentColor" stroke-width="1.2"/></svg>', '实物尺寸', '宽高、字号、描边和圆角', () => `${chk('keepRatio' as any, '改宽高时保持比例')}${measure}`)}
  <div style="display:flex;flex-direction:column">
  <span class="kicker" style="padding:4px 0">颜色与标注</span>
  ${tool('pick', INKS.replace(/<i /g, '<i class="sm" '), '按 CMYK 数值上色', '输入印刷厂给的色值，填充或描边所选', () => `<div style="display:flex;gap:10px;align-items:center"><span style="width:36px;height:36px;border-radius:8px;flex:none;background:${pickHex};border:1px solid var(--line)"></span><div class="grid4" data-notr>${(['c', 'm', 'y', 'k'] as const).map((k) => `<label>${k.toUpperCase()}${num('pick.' + k, { min: 0, max: 100, w: 50 })}</label>`).join('')}</div></div><div style="display:flex;gap:8px;align-items:center"><button class="btn small" data-act="pick-apply" data-v="fill">填充所选</button><button class="btn small" data-act="pick-apply" data-v="stroke">描边所选</button><span class="muted xs">导出时按这组 CMYK 精确输出</span></div>`)}
  ${tool('labels', `<svg width="18" height="18" viewBox="0 0 18 18"><rect x="2" y="2" width="9" height="9" rx="1.5" fill="var(--accent)"/><path d="M4 14.5h11M4 16.5h7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`, '色卡标注', '在色块旁写上 HEX / RGB / CMYK / 专色名', () => `<div style="display:flex;gap:12px;flex-wrap:wrap">${chk('label.hex', 'HEX')}${chk('label.rgb', 'RGB')}${chk('label.cmyk', 'CMYK')}${chk('label.spot', '专色名')}${chk('label.names', '样式名')}</div><div style="display:flex;gap:8px;align-items:center"><button class="btn small" data-act="labels">为所选色块生成标注</button><span class="muted xs">重复运行会更新，不会重叠</span></div>`)}
  <span class="kicker" style="padding:12px 0 4px">版面与图片</span>
  ${tool('pagenum', `<svg width="18" height="18" viewBox="0 0 18 18"><rect x="3" y="1.5" width="12" height="15" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M10 13h3" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round"/></svg>`, '页码', '按导出顺序自动编号，奇偶页左右对称', () => `<div class="line"><span class="l sm">格式</span><span data-notr style="display:flex;flex:1">${sel('pageNum.format', [['{n}', '1'], ['{n} / {total}', '1 / 12'], ['- {n} -', '- 1 -'], ['P{n}', 'P1'], ['Page {n}', 'Page 1'], ['第 {n} 页', '第 1 页'], ['{n} ページ', '1 ページ'], ['{n} 페이지', '1 페이지'], ['Página {n}', 'Página 1'], ['Seite {n}', 'Seite 1']])}</span></div><div class="line"><span class="l sm">起始数字</span>${num('pageNum.start', { min: 0, w: 56 })}</div><div class="line"><span class="l sm">跳过前几页（封面）</span>${num('pageNum.skip', { min: 0, w: 56 })}</div><div class="line"><span class="l sm">位置</span>${seg('pageNum.position', [['outer', '外侧角'], ['center', '底部居中']])}</div>${chk('pageNum.create', '没有名为「页码」的文字图层时自动添加')}<div><button class="btn small" data-act="page-numbers">按导出页顺序编页码</button></div>`)}
  ${tool('image', `<svg width="18" height="18" viewBox="0 0 18 18"><rect x="1.5" y="3" width="15" height="12" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M3 13l4-4 3 3 2-2 3 3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>`, '替换 / 放大图片', '换图保留裁切；低清图放大 2 倍', () => {
    const imgs = m.filter((n) => n.hasImage);
    return imgs.length ? `<p class="hint xs">替换或放大图片会修改原稿；放大不会补回缺失的细节。</p>${imgs.map((n) => `<div class="line"><span class="l ell" data-notr>${esc(n.name)}</span><button class="btn small" data-act="replace-image" data-v="${n.id}">替换图片</button><button class="btn small" data-act="upscale" data-v="${n.id}">放大 2 倍</button></div>`).join('')}` : `<p class="hint xs">先在画布上选中带图片的图层。</p>`;
  })}
  ${tool('rescale', `<svg width="18" height="18" viewBox="0 0 18 18"><rect x="1.5" y="1.5" width="15" height="15" rx="1" stroke="var(--fg3)" stroke-width="1.2" fill="none"/><rect x="5" y="5" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>`, '缩回实际尺寸', '按 300 DPI 像素做的画板，一键换算成实际尺寸', () => `<p class="hint xs">例如 A4 做成 2480×3508 像素的画板，缩回 210×297 mm，图片清晰度不变。</p><div class="line"><span class="l sm">原来按</span><select id="rescale-dpi" style="flex:none;width:90px"><option>300</option><option>150</option><option>200</option><option>350</option><option>600</option></select><span class="unit">DPI</span><button class="btn small" data-act="rescale">缩回实际尺寸</button></div>`)}
  <span class="kicker" style="padding:12px 0 4px">包装</span>
  ${tool('box', `<svg width="18" height="18" viewBox="0 0 18 18"><path d="M9 1.5l7 3v9l-7 3-7-3v-9z M2 4.5l7 3 7-3 M9 7.5v9" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round" stroke-dasharray="2 1.5"/></svg>`, '纸盒刀版生成', '插舌盒 · 托盘盒 · 飞机盒，输入长宽高即可', () => `<div class="line"><span class="l sm">盒型</span>${seg('box.style', [['ste', '插舌盒'], ['tray', '托盘盒'], ['mailer', '飞机盒']])}</div><div class="grid4"><label>长${num('box.w', { min: 10, w: 56 })}</label><label>宽${num('box.d', { min: 10, w: 56 })}</label><label>高${num('box.h', { min: 5, w: 56 })}</label><span class="unit" style="align-self:center">mm</span></div><p class="hint xs">内尺寸。生成后刀线为实线、折线为虚线，图层名已按规则命名，导出时自动输出为刀版专色。</p><div><button class="btn small" data-act="box">生成刀版</button></div>`)}
  </div>
  <input type="file" id="file-image" accept="image/png,image/jpeg,image/webp" hidden>`;
}
const mbox = (label: string, k: string, id: string, v: number, unit: string) =>
  `<label class="well" style="display:flex;flex-direction:column;gap:2px;padding:6px 8px;min-width:84px;flex:1"><span class="muted xs">${label}</span><span style="display:flex;align-items:center;gap:4px"><input type="number" step="any" data-act="mz" data-id="${id}" data-k="${k}" value="${v}" style="width:56px;height:26px;border:0;background:transparent;padding:0;font-weight:600"><span class="unit" data-notr>${unit}</span></span></label>`;


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
    case 'route':
      if (S.route === 'welcome') s.onboarded = true;
      S.route = v as Route;
      if (v === 'check' && (el.closest('.quality') || el.closest('dialog'))) S.checkTab = 'issues';
      S.sheet = '';
      S.sheetStack = [];
      render();
      onEnter();
      if (S.route === 'export' && S.frames.length) post('thumbs', { ids: S.frames.map((f) => f.id) });
      break;
    case 'sheet':
      if (v === 'imposition') S.impBackup = structuredClone(s.imp);
      if (el.dataset.root) {
        S.sheetStack = [];
        S.sheet = v as Sheet;
      } else if (!v) {
        S.sheet = S.sheetStack.pop() || '';
      } else {
        S.sheetStack.push(S.sheet);
        S.sheet = v as Sheet;
      }
      render();
      if (!S.sheet) onEnter();
      break;
    case 'ctab':
      S.checkTab = v as CheckTab;
      render();
      if (v === 'colors' && !S.colors) post('scan-colors');
      onEnter();
      break;
    case 'onboard':
      s.onboarded = true;
      saveSettings();
      S.route = S.frames.length ? 'export' : 'prepare';
      render();
      break;
    case 'export':
      confirmExport();
      break;
    case 'export-cancel':
      ($('export-confirm') as HTMLDialogElement).close();
      break;
    case 'export-confirm':
      if (S.confirmKey !== confirmationKey()) return;
      ($('export-confirm') as HTMLDialogElement).close();
      doExport();
      break;
    case 'pages-open':
      S.pagesOpen = !S.pagesOpen;
      render();
      break;
    case 'more-open':
      s.advancedOpen = !s.advancedOpen;
      saveSettings();
      render();
      break;
    case 'page-move': {
      const from = S.order.indexOf(v);
      const to = from + Number(el.dataset.dir);
      if (from < 0 || to < 0 || to >= S.order.length) return;
      S.order.splice(to, 0, S.order.splice(from, 1)[0]);
      render();
      break;
    }
    case 'tg':
      update(el.dataset.path!, !getPath(el.dataset.path!));
      break;
    case 'orient':
      update('doc.landscape', v === 'h');
      break;
    case 'pages':
      update('doc.pages', Math.max(1, Math.min(400, s.doc.pages + +v)));
      break;
    case 'doc-kind': {
      const k = DOC_KINDS.find((x) => x.id === v)!;
      const p = PAPER_PRESETS.find((x) => x.id === k.preset)!;
      Object.assign(s.doc, { kind: k.id, preset: p.id, w: p.w, h: p.h, landscape: p.w > p.h, pages: k.pages, facing: k.facing, fold: k.fold, scale: k.scale, name: tr(k.noun) });
      saveSettings();
      render();
      break;
    }
    case 'doc-more':
      S.docMore = !S.docMore;
      render();
      break;
    case 'convert-doc':
      post('convert-frames', { bleed: s.doc.sidesOn ? s.doc.sides : uniform(s.doc.bleed), extend: true });
      break;
    case 'profile':
      applyProfile(v);
      notify(`已切换到「${profileName(v)}」`);
      break;
    case 'more-reset':
      for (const k of MORE_KEYS) (s as any)[k] = structuredClone((DEFAULTS as any)[k]);
      saveSettings();
      render();
      break;
    case 'imp-cancel':
      if (S.impBackup) s.imp = S.impBackup;
      S.sheet = S.sheetStack.pop() || '';
      saveSettings();
      render();
      break;
    case 'fix-all': {
      const is = currentIssues() || [];
      let n = 0;
      for (const i of is) {
        if (i.fix?.startsWith('k100:')) {
          const hex = i.fix.slice(5);
          setOverride(hex, (o) => ({ ...o, cmyk: { c: 0, m: 0, y: 0, k: 100 }, spot: undefined }));
          n++;
        } else if (i.fix === 'removeWhiteOverprint' || (i.fix === 'autoBleed' && !s.autoBleed)) n++;
      }
      if (is.some((i) => i.fix === 'removeWhiteOverprint')) {
        for (const [hex, o] of Object.entries(s.overrides)) if (o.overprint && tac(cmykFor(hex).c) < 1) o.overprint = false;
        s.removeWhiteOverprint = true;
      }
      if (is.some((i) => i.fix === 'autoBleed')) s.autoBleed = true;
      saveSettings();
      S.issues = (S.issues || []).filter((i) => !(i.fix && (i.fix.startsWith('k100:') || i.fix === 'removeWhiteOverprint' || i.fix === 'autoBleed')));
      S.baseIssues = S.baseIssues.filter((i) => !(i.fix && (i.fix.startsWith('k100:') || i.fix === 'removeWhiteOverprint' || i.fix === 'autoBleed')));
      notify(`已修复 ${n} 个问题`);
      refreshEngine();
      break;
    }
    case 'fix-white':
      for (const [hex, o] of Object.entries(s.overrides)) if (o.overprint && tac(cmykFor(hex).c) < 1) o.overprint = false;
      s.removeWhiteOverprint = true;
      saveSettings();
      S.issues = (S.issues || []).filter((i) => i.fix !== 'removeWhiteOverprint');
      S.baseIssues = S.baseIssues.filter((i) => i.fix !== 'removeWhiteOverprint');
      refreshEngine();
      break;
    case 'pass-open':
      S.passOpen = !S.passOpen;
      render();
      break;
    case 'std-open':
      S.stdOpen = !S.stdOpen;
      render();
      break;
    case 'result':
      S.resultOpen = !S.resultOpen;
      render();
      break;
    case 'tool':
      S.toolOpen = S.toolOpen === v ? '' : v;
      render();
      break;
    case 'pv-page':
      S.previewIdx = Math.max(0, Math.min(S.order.length - 1, S.previewIdx + +v));
      render();
      ensurePreview();
      break;
    case 'pv-paper':
      if (S.preview) {
        S.preview.paper = !S.preview.paper;
        S.preview.data = undefined;
      }
      render();
      break;
    case 'tdefault':
      update('textOutline', v);
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
      if (s.textOutline !== 'perNode') update('textOutline', 'perNode');
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
      S.baseIssues = S.baseIssues.filter((i) => i.fix !== 'k100:' + v);
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
      if (!name) return notify('请先填写方案名称', true);
      // a profile keeps output settings only — not colours, documents or per-session values
      const keep: Partial<Settings> = structuredClone(s);
      for (const k of ['overrides', 'colorFinishing', 'activeMap', 'doc', 'customPapers', 'title', 'pick', 'onboarded', 'advancedOpen', 'profileId', 'profileBase', 'lang'] as const) delete keep[k];
      S.presets = [...S.presets.filter((p) => p.name !== name), { name, settings: keep }];
      post('store-set', { key: 'pk_presets', value: S.presets });
      s.profileId = 'user:' + S.presets.findIndex((p) => p.name === name);
      s.profileBase = pick(s, PROFILE_KEYS);
      saveSettings();
      notify(`已保存印刷方案「${name}」`);
      render();
      break;
    }
    case 'del-preset':
      if (s.profileId === 'user:' + v) s.profileId = '';
      else if (s.profileId.startsWith('user:') && +s.profileId.slice(5) > +v) s.profileId = 'user:' + (+s.profileId.slice(5) - 1);
      saveSettings();
      S.presets.splice(+v, 1);
      post('store-set', { key: 'pk_presets', value: S.presets });
      render();
      break;
    case 'export-json':
      download('Inkpaper 预设与颜色映射.json', new TextEncoder().encode(JSON.stringify({ presets: S.presets, maps: allMaps().map(({ file: _f, ...m }) => m) }, null, 2)), 'application/json');
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
        notify('不是有效的 Inkpaper JSON 文件', true);
      }
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
    S.settings.lang = el.value as Settings['lang'];
    saveSettings();
    applyLang();
    render();
    return;
  }
  if (el.id === 'pdf-password') {
    S.password = el.value;
    renderFoot();
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

async function importIccFiles(files: File[]) {
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
  saveSettings();
  refreshEngine();
}
$('file-icc').addEventListener('change', async (ev) => {
  const inp = ev.target as HTMLInputElement;
  await importIccFiles([...(inp.files || [])]);
  inp.value = '';
});
// .icc files dropped anywhere on the panel
document.addEventListener('dragover', (ev) => {
  if (ev.dataTransfer?.types.includes('Files')) {
    ev.preventDefault();
    document.getElementById('icc-drop')?.classList.add('over');
  }
});
document.addEventListener('dragleave', () => document.getElementById('icc-drop')?.classList.remove('over'));
document.addEventListener('drop', (ev) => {
  const files = [...(ev.dataTransfer?.files || [])].filter((f) => /\.(icc|icm)$/i.test(f.name));
  if (!files.length) return;
  ev.preventDefault();
  importIccFiles(files);
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
  S.pendingIssuesKey = checkKey();
  S.pendingCheckId = 'check' + reqSeq++;
  S.checkError = '';
  post('preflight', { opts: preflightOpts(), reqId: S.pendingCheckId });
  render();
}

// ---------------- export ----------------

function confirmExport() {
  if (!S.frames.length || S.busy) return;
  const issues = currentIssues();
  const risks = issues?.filter((i) => i.level === 'warning' || i.level === 'error') || [];
  if (issues && !risks.length) { doExport(); return; }
  const dialog = $('export-confirm') as HTMLDialogElement;
  S.confirmKey = confirmationKey();
  dialog.innerHTML = `<h2 id="confirm-title">${issues ? '仍有风险，确认继续？' : '还未完成当前检查'}</h2><p class="hint">${issues ? '继续导出不会消除这些风险。' : '可以先检查，也可以跳过检查导出。跳过不代表文件适合送印。'}</p>${risks.length ? `<ul>${risks.map((i) => `<li>${esc(i.msg)}</li>`).join('')}</ul>` : S.settings.mode === 'cmyk' && !currentProfile() ? '<p class="hint">未选择 ICC，颜色仅能近似换算。</p>' : ''}<div class="dialog-actions"><button class="btn" data-act="export-cancel" autofocus>取消</button><button class="btn" data-act="route" data-v="check">${issues ? '查看检查' : '开始检查'}</button><button class="btn primary" data-act="export-confirm">${issues ? '接受风险并导出' : '跳过检查并导出'}</button></div>`;
  translateDom(dialog);
  dialog.showModal();
}

function busy(on: boolean, msg = '') {
  S.busy = on;
  $('overlay').classList.toggle('on', on);
  if (msg) $('ov-msg').textContent = tr(msg);
  if (!on) ($('ov-bar') as HTMLElement).style.width = '0';
  renderFoot();
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
  if (!S.frames.length || S.busy) return;
  busy(true, '准备导出…');
  try {
    if (s.blockLowPpi) {
      progress('检查图片分辨率…', 0.02);
      const key = checkKey();
      const res = await request<{ issues: Issue[]; images: ImageInfoNode[]; colors: ScannedColor[] }>('preflight', { opts: preflightOpts() }, 'preflight');
      if (key !== checkKey()) {
        notify('设置或选择已改变，请重新检查', true);
        return;
      }
      S.colors = res.colors;
      S.baseIssues = res.issues;
      S.issues = [...res.issues, ...colorIssues()];
      S.images = res.images;
      S.issuesKey = key;
      const low = res.issues.filter((i) => i.cat === 'resolution');
      if (low.length) {
        busy(false);
        S.route = 'check';
        S.checkTab = 'issues';
        S.sheet = '';
        render();
        notify(`有 ${low.length} 张图片分辨率不足，已停止导出（可在“检查”的检查标准里关闭此限制）`, true);
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
    S.route = 'export';
    S.sheet = '';
  } catch (e: any) {
    console.error(e);
    notify('导出失败：' + (e?.message || e), true);
  } finally {
    busy(false);
    render();
  }
}


// dev aid: lets the test harness walk every view and list untranslated strings
(window as any).__pk = { S, render, update, missing, setLang: (l: Lang) => { S.settings.lang = l; applyLang(); render(); } };

$('export-confirm').addEventListener('close', () => {
  if (S.route === 'export' && !S.sheet && !S.busy) $('foot').querySelector<HTMLButtonElement>('[data-act="export"]')?.focus();
});

render();
post('init');
