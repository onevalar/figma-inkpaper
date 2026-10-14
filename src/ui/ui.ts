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
import { tr, setLang, detectLang, missing, Lang } from '../i18n/i18n';
import { DOC_KINDS } from './views';
import { renderApp } from './app';

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
  confirmOpen: false,
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
  progressMessage: '处理中…',
  progressValue: 0,
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
      render();
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
  // default names follow the interface language
  const DEFAULT_NAMES = ['印刷文档', 'Print document', '印刷ドキュメント', '인쇄 문서', 'Documento de impresión', 'Druckdokument', 'Document d’impression', '印刷文件'];
  if (DEFAULT_NAMES.includes(S.settings.doc.name)) S.settings.doc.name = tr('印刷文档');
}

// ---------------- rendering / routes ----------------

export function render() {
  if (S.confirmOpen && (S.route !== 'export' || S.sheet || S.confirmKey !== confirmationKey())) S.confirmOpen = false;
  renderApp();
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

// ---------- output metadata ----------

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

function impLabel(k: ImpKind): [string, string] {
  return ({ none: ['不拼版', '一页一个成品'], spreads: ['对页跨页', '画册校对用'], booklet: ['骑马钉画册', '自动排页，可从右往左'], nup: ['一版多拼', '名片、贴纸、卡片'], duplex: ['正反面拼版', '双面卡片，背面自动镜像'] } as Record<ImpKind, [string, string]>)[k];
}

const MORE_KEYS = ['bleedSidesOn', 'bleedSides', 'autoBleed', 'trimLine', 'markWeight', 'dielineMode', 'dielineNames', 'dielineFile', 'spotPolicy', 'keepSpots', 'textOutline', 'compression', 'imageCompression', 'jpegQuality', 'maxPpi', 'bookmarks', 'keepLinks', 'alsoDigital', 'output', 'scalePct'] as const;

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

document.addEventListener('click', (ev) => {
  if (!(ev.target instanceof Element)) return;
  const el = ev.target.closest<HTMLElement>('[data-act]');
  if (!el) return;
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return; // handled by change events
  if (ev.target.closest('[data-stop]') && el.dataset.act === 'expand') return;
  const act = el.dataset.act!;
  if (el.tagName === 'A') ev.preventDefault();
  void dispatchAction(act, el.dataset.v || '', el.dataset, el);
});

export async function dispatchAction(act: string, v: string = '', data: Record<string, string | undefined> = {}, source?: HTMLElement) {
  const s = S.settings;
  switch (act) {
    case 'route':
      if (S.route === 'welcome') s.onboarded = true;
      S.route = v as Route;
      if (v === 'check' && source?.closest('.quality,[role=dialog]')) S.checkTab = 'issues';
      S.sheet = '';
      S.sheetStack = [];
      render();
      onEnter();
      if (S.route === 'export' && S.frames.length) post('thumbs', { ids: S.frames.map((f) => f.id) });
      break;
    case 'sheet':
      if (v === 'imposition') S.impBackup = structuredClone(s.imp);
      if (data.root) {
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
      S.confirmOpen = false;
      render();
      break;
    case 'export-confirm':
      if (S.confirmKey !== confirmationKey()) return;
      S.confirmOpen = false;
      render();
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
      const to = from + Number(data.dir);
      if (from < 0 || to < 0 || to >= S.order.length) return;
      S.order.splice(to, 0, S.order.splice(from, 1)[0]);
      render();
      break;
    }
    case 'tg':
      update(data.path!, !getPath(data.path!));
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
      update(data.path!, JSON.parse(v));
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
      const hex = data.hex!;
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
      const hex = data.hex!;
      const sw = nearestSpot(hex);
      if (!sw) return;
      setOverride(hex, (o) => ({ ...o, spot: { name: sw.name, tint: 100, alt: sw.cmyk || o.spot?.alt || { c: 0, m: 0, y: 0, k: 0 } } }));
      notify(`最接近的是 ${sw.name}`);
      break;
    }
    case 'reset-color':
      delete s.colorFinishing[data.hex!];
      setOverride(data.hex!, () => null);
      break;
    case 'tmode':
      if (s.textOutline !== 'perNode') update('textOutline', 'perNode');
      post('set-text-mode', { ids: [v], mode: data.m });
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
    case 'migration-export': {
      const reply = await request<{ backup: any }>('migration-export', {}, 'migration-backup');
      download('Inkpaper-private-migration.json', new TextEncoder().encode(JSON.stringify(reply.backup)), 'application/json');
      notify('迁移备份已导出，包含 ICC 和本文件印刷信息，请私下保存');
      break;
    }
    case 'migration-import': {
      const f = await pickFile('.json,application/json');
      if (!f) break;
      if (f.size > 24 * 1024 * 1024) throw new Error('迁移文件过大');
      const backup = JSON.parse(await f.text());
      const reply = await request<{ result: any }>('migration-import', { backup }, 'migration-imported');
      notify(`迁移完成并校验：${reply.result.storageKeys} 项存储，${reply.result.nodeCount} 个图层。请重新打开插件。`);
      break;
    }
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
      post('rescale-dpi', { dpi: +($('rescale-dpi') as HTMLInputElement).value });
      break;
  }
}

document.addEventListener('change', onChange);

function onChange(ev: Event) {
  const el = ev.target as HTMLInputElement;
  changeValue({ ...el.dataset, id: el.id, nodeId: el.dataset.id }, el.type === 'checkbox' || el.dataset.t === 'bool' ? el.checked : el.value);
}

export function changeValue(target: { id?: string; act?: string; bind?: string; t?: string; u?: string; hex?: string; k?: string; nodeId?: string }, value: string | number | boolean): void {
  const act = target.act;
  if (target.id === 'lang') {
    S.settings.lang = String(value) as Settings['lang'];
    saveSettings();
    applyLang();
    render();
    return;
  }
  if (target.id === 'pdf-password') {
    S.password = String(value);
    render();
    return;
  }
  if (target.bind) {
    const t = target.t;
    let v: any = t === 'bool' ? Boolean(value) : t === 'num' ? Number(value) : value;
    if (target.u) v = +fromUnit(Number(value)).toFixed(3);
    update(target.bind, v);
    return;
  }
  const s = S.settings;
  if (act === 'preset') {
    const id = String(value);
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
    const m = allMaps().find((x) => x.name === String(value).replace(/（本文件）$/, ''));
    s.activeMap = m ? m.name : '';
    s.overrides = m ? structuredClone(m.overrides) : {};
    s.colorFinishing = m?.finishing ? structuredClone(m.finishing) : {};
    saveSettings();
    refreshEngine();
  } else if (act === 'cmyk') {
    const hex = target.hex!;
    const k = target.k as keyof CMYK;
    const val = Math.max(0, Math.min(100, Number(value)));
    setOverride(hex, (o) => {
      if (o.spot) o.spot.alt = { ...o.spot.alt, [k]: val };
      else o.cmyk = { ...(o.cmyk || { c: 0, m: 0, y: 0, k: 0 }), [k]: val };
      return o;
    });
  } else if (act === 'spotname') {
    const lib = S.lib.find((l) => l.name === String(value).trim());
    setOverride(target.hex!, (o) => {
      if (o.spot) {
        o.spot.name = String(value).trim() || 'Spot';
        if (lib?.cmyk) o.spot.alt = { ...lib.cmyk };
      }
      return o;
    });
  } else if (act === 'tint') {
    setOverride(target.hex!, (o) => {
      if (o.spot) o.spot.tint = Number(value);
      return o;
    });
  } else if (act === 'overprint') {
    setOverride(target.hex!, (o) => ({ ...o, overprint: Boolean(value) }));
  } else if (act === 'finish-name') {
    s.colorFinishing[target.hex!] = String(value);
    saveSettings();
    render();
  } else if (act === 'mz') {
    const k = target.k!;
    const val = Number(value);
    const px = (mmv: number) => (mmv * 72) / 25.4;
    const keepRatio = (s as any).keepRatio;
    const data: any = { ids: [target.nodeId], keepRatio };
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
document.addEventListener('change', async (ev) => {
  const inp = ev.target as HTMLInputElement;
  if (inp.id !== 'file-icc') return;
  await importIccFiles([...(inp.files || [])]);
  inp.value = '';
});
// .icc files dropped anywhere on the panel
document.addEventListener('dragover', (ev) => {
  if (ev.dataTransfer?.types.includes('Files')) {
    ev.preventDefault();
  }
});
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
  S.confirmKey = confirmationKey();
  S.confirmOpen = true;
  render();
}

function busy(on: boolean, msg = '') {
  S.busy = on;
  if (msg) S.progressMessage = msg;
  if (!on) S.progressValue = 0;
  render();
}
function progress(msg: string, frac: number) {
  S.progressMessage = msg;
  S.progressValue = frac;
  render();
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
  if (s.format === 'pdf' && s.mode !== 'rgb' && s.pdfx !== 'none' && (s.mode !== 'cmyk' || !currentProfile())) {
    notify('PDF/X 需要 CMYK 模式和 ICC 配置文件。请在印刷方案中导入 ICC，或在专业设置中选择普通 PDF。', true);
    return;
  }
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

export function startUi() {
  render();
  post('init');
}

export {
  S, DEFAULTS, RICH_PRESETS, MORE_KEYS, BUILTIN_PROFILES,
  getPath, update, toUnit, fromUnit, UNIT_NAMES, hexToRgb, fmtC,
  cmykFor, currentProfile, allMaps, frameSize, orderedFrames,
  selectionKey, checkKey, currentIssues, confirmationKey,
  applyProfile, profileName, profileDirty, nupGrid, impSheets,
  impLabel, exportLabel, readiness, colorIssues, paintPreview, engine,
};
export type { ImpKind, CheckTab };
