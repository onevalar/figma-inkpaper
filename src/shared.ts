// Types and constants shared between the Figma main thread and the UI.

export const MM = 72 / 25.4; // Figma px == PDF pt

export interface PaperPreset {
  id: string;
  name: string;
  w: number; // mm
  h: number; // mm
  group: string;
}

export const PAPER_PRESETS: PaperPreset[] = [
  { id: 'a1', name: 'A1', w: 594, h: 841, group: 'A 系列' },
  { id: 'a2', name: 'A2', w: 420, h: 594, group: 'A 系列' },
  { id: 'a3', name: 'A3', w: 297, h: 420, group: 'A 系列' },
  { id: 'a4', name: 'A4', w: 210, h: 297, group: 'A 系列' },
  { id: 'a5', name: 'A5', w: 148, h: 210, group: 'A 系列' },
  { id: 'a6', name: 'A6', w: 105, h: 148, group: 'A 系列' },
  { id: 'b3', name: 'B3 (ISO)', w: 353, h: 500, group: 'B 系列' },
  { id: 'b4', name: 'B4 (ISO)', w: 250, h: 353, group: 'B 系列' },
  { id: 'b5', name: 'B5 (ISO)', w: 176, h: 250, group: 'B 系列' },
  { id: 'jb4', name: 'B4 (JIS)', w: 257, h: 364, group: 'B 系列' },
  { id: 'jb5', name: 'B5 (JIS)', w: 182, h: 257, group: 'B 系列' },
  { id: 'k16', name: '大16开', w: 210, h: 285, group: '国内开本' },
  { id: 'k16s', name: '正16开', w: 185, h: 260, group: '国内开本' },
  { id: 'k32', name: '大32开', w: 140, h: 203, group: '国内开本' },
  { id: 'letter', name: 'Letter', w: 215.9, h: 279.4, group: '北美' },
  { id: 'legal', name: 'Legal', w: 215.9, h: 355.6, group: '北美' },
  { id: 'tabloid', name: 'Tabloid', w: 279.4, h: 431.8, group: '北美' },
  { id: 'ledger', name: 'Ledger', w: 431.8, h: 279.4, group: '北美' },
  { id: 'bc-cn', name: '名片（中国 90×54）', w: 90, h: 54, group: '名片 / 卡片' },
  { id: 'bc-us', name: '名片（美式 3.5×2in）', w: 88.9, h: 50.8, group: '名片 / 卡片' },
  { id: 'bc-eu', name: '名片（欧式 85×55）', w: 85, h: 55, group: '名片 / 卡片' },
  { id: 'postcard', name: '明信片 148×100', w: 148, h: 100, group: '名片 / 卡片' },
  { id: 'postcard-us', name: '明信片（美式 6×4in）', w: 152.4, h: 101.6, group: '名片 / 卡片' },
  { id: 'dl', name: 'DL 宣传单 99×210', w: 99, h: 210, group: '宣传品' },
  { id: 'poster-s', name: '海报 420×570', w: 420, h: 570, group: '宣传品' },
  { id: 'poster-m', name: '海报 500×700', w: 500, h: 700, group: '宣传品' },
  { id: 'poster-l', name: '海报 600×900', w: 600, h: 900, group: '宣传品' },
  { id: 'rollup', name: '易拉宝 800×2000', w: 800, h: 2000, group: '宣传品' },
  { id: 'xbanner', name: 'X 展架 600×1600', w: 600, h: 1600, group: '宣传品' },
  { id: 'xbanner2', name: 'X 展架 800×1800', w: 800, h: 1800, group: '宣传品' },
  { id: 'poster-6090', name: '海报 600×900（60×90）', w: 600, h: 900, group: '宣传品' },
  { id: 'trifold-a4', name: 'A4 三折页（展开）', w: 297, h: 210, group: '宣传品' },
  { id: 'hangtag', name: '吊牌 50×90', w: 50, h: 90, group: '包装 / 标签' },
  { id: 'necklabel', name: '领标 40×20', w: 40, h: 20, group: '包装 / 标签' },
  { id: 'sticker100', name: '贴纸 100×100', w: 100, h: 100, group: '包装 / 标签' },
  { id: 'sticker50', name: '圆形贴纸 50×50', w: 50, h: 50, group: '包装 / 标签' },
  { id: 'tshirt', name: 'T 恤胸前印花 300×400', w: 300, h: 400, group: '包装 / 标签' },
  { id: 'hoodie', name: '卫衣背后印花 350×450', w: 350, h: 450, group: '包装 / 标签' },
  { id: 'invite', name: '邀请函 210×140', w: 210, h: 140, group: '名片 / 卡片' },
  { id: 'ticket', name: '门票 200×70', w: 200, h: 70, group: '名片 / 卡片' },
  { id: 'menu-a3', name: '菜单 A3 对折', w: 297, h: 420, group: '宣传品' },
  { id: 'sra3', name: 'SRA3 320×450', w: 320, h: 450, group: 'A 系列' },
];

export const SHEET_PRESETS: { id: string; name: string; w: number; h: number }[] = [
  { id: 'a4', name: 'A4 210×297', w: 210, h: 297 },
  { id: 'a3', name: 'A3 297×420', w: 297, h: 420 },
  { id: 'sra3', name: 'SRA3 320×450', w: 320, h: 450 },
  { id: 'a3plus', name: 'A3+ 330×483', w: 330, h: 483 },
  { id: 'letter', name: 'Letter 8.5×11in', w: 215.9, h: 279.4 },
  { id: 'tabloid', name: 'Tabloid 11×17in', w: 279.4, h: 431.8 },
  { id: 'k8', name: '大度 8 开 420×570', w: 420, h: 570 },
  { id: 'k4', name: '大度 4 开 570×840', w: 570, h: 840 },
];

export type Unit = 'mm' | 'cm' | 'in' | 'pt' | 'px';
export const UNIT_TO_MM: Record<Unit, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 72 };

export interface Sides {
  t: number;
  r: number;
  b: number;
  l: number;
}
export const uni = (v: number): Sides => ({ t: v, r: v, b: v, l: v });

/** Stored on print frames (pluginData key "presskit", the plugin's former name). */
export interface FrameMeta {
  trimW: number; // mm
  trimH: number; // mm
  bleed: number; // mm (included in frame size; uniform value, see bleedSides)
  bleedSides?: Sides; // mm per side (overrides bleed)
  scale?: number; // designed at 1:N (large formats); output is scaled up by N
  margin: number; // mm (inside trim)
  safety: number; // mm (inside trim)
  folds?: { axis: 'X' | 'Y'; at: number }[]; // mm from trim origin
}

export interface FrameInfo {
  id: string;
  name: string;
  w: number; // px
  h: number;
  meta: FrameMeta | null;
}

export type IssueLevel = 'error' | 'warning' | 'info' | 'pass';
export type IssueCat = 'geometry' | 'color' | 'resolution' | 'transparency' | 'text' | 'annotation' | 'spot';

export interface Issue {
  level: IssueLevel;
  cat: IssueCat;
  msg: string;
  nodeId?: string;
  frame?: string;
  fix?: string; // id of an auto-fix available in export settings
}

export interface ScannedColor {
  hex: string;
  count: number;
  where: string[]; // 'fill' | 'stroke' | 'text' | 'gradient' | 'effect'
  sampleNode?: string;
  inGradient: boolean;
  names?: string[]; // colour style / variable names using this colour
  inSmallText?: boolean; // used by text below 12pt
}

export interface TextNodeInfo {
  id: string;
  frame: string;
  name: string;
  preview: string;
  fonts: string[];
  size: number;
  hasEffects: boolean;
  missingFont: boolean;
  mode: 'live' | 'outline';
}

export interface ImageInfoNode {
  id: string;
  frame: string;
  name: string;
  px: string; // "4000×3000"
  ppi: number;
}

export interface ExportRequest {
  frameIds: string[];
  bleedMm: number;
  autoBleed: boolean; // extend edge-touching layers for frames that have no bleed
  dieline: { mode: 'off' | 'auto' | 'manual'; manualNames: string[] };
  textOutline: 'perNode' | 'all' | 'none';
  minStrokePt: number; // 0 = off
  bleedSides?: Sides; // mm per side for frames without bleed (overrides bleedMm)
  colorFinishing?: Record<string, string>; // HEX → finishing spot (strokes become cut lines, fills a spot plate)
  format?: 'PDF' | 'PNG'; // PNG = raster output path
  pngDpi?: number; // PNG render resolution
  rasterDpi?: number; // also render a PNG (flattening for PDF/X-1a / X-3)
}

export interface ExportedFrame {
  id: string;
  name: string;
  pdf: Uint8Array;
  trimW: number; // pt
  trimH: number;
  srcBleed: Sides; // pt
  scale: number;
  png?: Uint8Array;
  sentinels: { hex: string; spotName: string }[];
  vectorStrokes: { spotName: string; weight: number; dash: number[]; paths: { d: string; m: number[] }[] }[];
  pageH: number;
  hairlinesFixed: number;
}

export const DIELINE_KEYWORDS: { key: RegExp; spot: string; alt: [number, number, number, number] }[] = [
  { key: /^\[?\s*(cut|刀|模切|die)/i, spot: 'CutContour', alt: [0, 100, 0, 0] },
  { key: /^\[?\s*(fold|折)/i, spot: 'Fold', alt: [100, 0, 0, 0] },
  { key: /^\[?\s*(score|crease|压痕|压线)/i, spot: 'Score', alt: [0, 0, 100, 0] },
  { key: /^\[?\s*(perf|打孔|撕)/i, spot: 'Perforation', alt: [50, 0, 100, 0] },
  { key: /^\[?\s*(varnish|uv|光油)/i, spot: 'Varnish', alt: [0, 30, 0, 0] },
  { key: /^\[?\s*(white|白墨)/i, spot: 'White', alt: [20, 0, 0, 0] },
  { key: /^\[?\s*(foil|烫金|烫银|hot.?stamp)/i, spot: 'Foil', alt: [0, 20, 60, 20] },
];

/** Layer names that *start with* a finishing keyword (e.g. "Cut", "刀版 外框", "[Foil] logo"). */
export function dielineSpotFor(name: string, manual: string[]): string | null {
  for (const m of manual) if (m && name.trim().toLowerCase().startsWith(m.toLowerCase())) return m;
  for (const d of DIELINE_KEYWORDS) if (d.key.test(name)) return d.spot;
  return null;
}
