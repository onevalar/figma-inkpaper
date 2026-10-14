/// <reference types="@figma/plugin-typings" />
// Inkpaper — Figma main thread. Reads/modifies the document; all PDF / colour work happens in the UI iframe.

import {
  MM,
  FrameMeta,
  FrameInfo,
  Issue,
  ScannedColor,
  TextNodeInfo,
  ImageInfoNode,
  ExportRequest,
  ExportedFrame,
  Sides,
  uni,
  dielineSpotFor,
} from '../shared';
import { exportMigration, importMigration } from './migration';
import { tr, setLang } from '../i18n/i18n';

const META_KEY = 'presskit'; // legacy key name, kept so existing print frames are still recognised
const TEXT_KEY = 'pk_text';
const LABEL_KEY = 'pk_label_for';

const notify = (text: string, opts?: NotificationOptions) => figma.notify(tr(text), opts);

figma.showUI(__html__, { width: 480, height: 740, themeColors: true, title: 'Inkpaper 纸墨' });

// ---------------- helpers ----------------

type Exportable = FrameNode | ComponentNode | InstanceNode | GroupNode | SectionNode;
const isFrameLike = (n: BaseNode): n is FrameNode | ComponentNode | InstanceNode => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE';
const isExportable = (n: BaseNode): n is Exportable => isFrameLike(n) || n.type === 'GROUP' || n.type === 'SECTION';

function getMeta(n: BaseNode): FrameMeta | null {
  const raw = n.getPluginData(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Bleed of a print frame per side, in mm. */
const bleedOf = (m: FrameMeta): Sides => m.bleedSides || uni(m.bleed);

function frameInfo(n: Exportable): FrameInfo {
  return { id: n.id, name: n.name, w: n.width, h: n.height, meta: getMeta(n) };
}

/** What the user is working on: selected top-level frames / groups / sections, else print frames on the page. */
function targetFrames(): Exportable[] {
  const sel = figma.currentPage.selection;
  const out: Exportable[] = [];
  const seen = new Set<string>();
  for (const n of sel) {
    let cur: BaseNode | null = n;
    let top: Exportable | null = null;
    while (cur && cur.type !== 'PAGE') {
      if (isExportable(cur) && (cur.parent?.type === 'PAGE' || cur.parent?.type === 'SECTION')) top = cur;
      cur = cur.parent;
    }
    if (!top && isExportable(n)) top = n;
    if (top && !seen.has(top.id)) {
      seen.add(top.id);
      out.push(top);
    }
  }
  if (out.length) return out;
  return figma.currentPage.children.filter((c) => isFrameLike(c) && getMeta(c)) as FrameNode[];
}

function post(type: string, data: any = {}) {
  figma.ui.postMessage({ type, ...data });
}

function sendSelection() {
  const measure = figma.currentPage.selection.slice(0, 20).map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    w: 'width' in n ? n.width : 0,
    h: 'height' in n ? n.height : 0,
    fontSize: n.type === 'TEXT' && n.fontSize !== figma.mixed ? n.fontSize : undefined,
    strokeWeight: 'strokeWeight' in n && typeof (n as any).strokeWeight === 'number' && visiblePaints((n as any).strokes).length ? (n as any).strokeWeight : undefined,
    cornerRadius: 'cornerRadius' in n && typeof (n as any).cornerRadius === 'number' ? (n as any).cornerRadius : undefined,
    hasImage: 'fills' in n && visiblePaints((n as any).fills).some((p) => p.type === 'IMAGE'),
  }));
  post('selection', { frames: targetFrames().map(frameInfo), explicit: figma.currentPage.selection.length > 0, measure });
}

const hexOf = (c: RGB) =>
  '#' +
  [c.r, c.g, c.b]
    .map((x) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
const rgbOf = (hex: string): RGB => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 });

function nextFreeX(): number {
  let x = 0;
  for (const c of figma.currentPage.children) x = Math.max(x, c.x + c.width);
  return x + 200;
}

function visiblePaints(p: ReadonlyArray<Paint> | PluginAPI['mixed'] | undefined): Paint[] {
  if (!p || p === figma.mixed) return [];
  return (p as Paint[]).filter((x) => x.visible !== false);
}

// ---------------- document creation ----------------

interface CreateDocOpts {
  name: string;
  trimW: number; // mm (real size)
  trimH: number;
  bleed: Sides; // mm
  margin: number;
  safety: number;
  pages: number;
  facing: boolean;
  fold: 'none' | 'half' | 'tri' | 'z' | 'gate';
  scale?: number; // design at 1:N
}

function applyGuides(f: FrameNode, m: FrameMeta) {
  const k = 1 / (m.scale || 1);
  const b = bleedOf(m);
  const L = b.l * MM * k, T = b.t * MM * k;
  const W = m.trimW * MM * k;
  const H = m.trimH * MM * k;
  const guides: Guide[] = [];
  const add = (axis: 'X' | 'Y', off: number) => guides.push({ axis, offset: Math.round(off * 100) / 100 });
  add('X', L);
  add('X', L + W);
  add('Y', T);
  add('Y', T + H);
  if (m.safety > 0) {
    const s = m.safety * MM * k;
    add('X', L + s);
    add('X', L + W - s);
    add('Y', T + s);
    add('Y', T + H - s);
  }
  for (const fd of m.folds || []) add(fd.axis, (fd.axis === 'X' ? L : T) + fd.at * MM * k);
  f.guides = guides;
  const grids: LayoutGrid[] = [];
  if (m.margin > 0) {
    const col: RGBA = { r: 0.2, g: 0.5, b: 1, a: 0.06 };
    grids.push({ pattern: 'COLUMNS', alignment: 'STRETCH', count: 1, gutterSize: 0, offset: L + m.margin * MM * k, visible: true, color: col });
    grids.push({ pattern: 'ROWS', alignment: 'STRETCH', count: 1, gutterSize: 0, offset: T + m.margin * MM * k, visible: true, color: col });
  }
  f.layoutGrids = grids;
}

function foldsFor(kind: CreateDocOpts['fold'], w: number): FrameMeta['folds'] {
  switch (kind) {
    case 'half':
      return [{ axis: 'X', at: w / 2 }];
    case 'tri': // roll fold: inner panel 2 mm narrower
      return [{ axis: 'X', at: (w + 2) / 3 }, { axis: 'X', at: ((w + 2) / 3) * 2 }];
    case 'z':
      return [{ axis: 'X', at: w / 3 }, { axis: 'X', at: (w / 3) * 2 }];
    case 'gate':
      return [{ axis: 'X', at: w / 4 }, { axis: 'X', at: (w / 4) * 3 }];
    default:
      return [];
  }
}

function createDocument(o: CreateDocOpts, at?: { x: number; y: number }): FrameNode[] {
  const scale = o.scale && o.scale > 1 ? o.scale : 1;
  const meta: FrameMeta = {
    trimW: o.trimW,
    trimH: o.trimH,
    bleed: Math.max(o.bleed.t, o.bleed.r, o.bleed.b, o.bleed.l),
    bleedSides: o.bleed,
    margin: o.margin,
    safety: o.safety,
    folds: foldsFor(o.fold, o.trimW),
    scale,
  };
  const fw = ((o.trimW + o.bleed.l + o.bleed.r) * MM) / scale;
  const fh = ((o.trimH + o.bleed.t + o.bleed.b) * MM) / scale;
  const x = at ? at.x : nextFreeX();
  const y = at ? at.y : 0;
  const created: FrameNode[] = [];
  for (let i = 0; i < o.pages; i++) {
    const f = figma.createFrame();
    f.name = (o.pages > 1 ? `${o.name} · 第 ${i + 1} 页` : o.name) + (scale > 1 ? `（1:${scale}）` : '');
    f.resize(fw, fh);
    f.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    f.clipsContent = true;
    if (o.facing && o.pages > 1) {
      // spread layout: page 1 alone on the right, then pairs
      const spreadIdx = Math.floor((i + 1) / 2);
      const isLeft = i > 0 && i % 2 === 1;
      f.x = x + spreadIdx * (fw * 2 + 120) + (isLeft ? 0 : fw);
    } else f.x = x + i * (fw + 80);
    f.y = y;
    f.setPluginData(META_KEY, JSON.stringify(meta));
    applyGuides(f, meta);
    figma.currentPage.appendChild(f);
    created.push(f);
  }
  return created;
}

// ---------------- bleed for frames that were designed at trim size ----------------

function extendToBleed(f: FrameNode | ComponentNode, b: Sides /* px */, extendEdges: boolean): number {
  const W = f.width;
  const H = f.height;
  f.resizeWithoutConstraints(W + b.l + b.r, H + b.t + b.b);
  let extended = 0;
  for (const c of f.children) {
    if ('layoutPositioning' in c && f.layoutMode !== 'NONE' && c.layoutPositioning !== 'ABSOLUTE') continue;
    c.x += b.l;
    c.y += b.t;
    if (!extendEdges || c.type === 'TEXT' || c.type === 'GROUP' || !('resizeWithoutConstraints' in c)) continue;
    if ('rotation' in c && Math.abs(c.rotation) > 0.01) continue;
    const L = c.x - b.l;
    const T = c.y - b.t;
    const R = L + c.width;
    const B = T + c.height;
    let nx = c.x, ny = c.y, nw = c.width, nh = c.height;
    if (L <= 0.5 && b.l) { nx -= b.l + Math.max(0, L); nw += b.l + Math.max(0, L); }
    if (R >= W - 0.5 && b.r) nw += b.r + Math.max(0, W - R);
    if (T <= 0.5 && b.t) { ny -= b.t + Math.max(0, T); nh += b.t + Math.max(0, T); }
    if (B >= H - 0.5 && b.b) nh += b.b + Math.max(0, H - B);
    if (nw !== c.width || nh !== c.height) {
      (c as any).resizeWithoutConstraints(nw, nh);
      c.x = nx;
      c.y = ny;
      extended++;
    }
  }
  return extended;
}

function convertFrames(bleed: Sides, extendEdges: boolean) {
  const frames = targetFrames();
  let n = 0;
  const skipped: string[] = [];
  let grown = 0;
  for (const f of frames) {
    const old = getMeta(f);
    if (old) {
      // already a print frame: only add whatever bleed is still missing on each side
      if (f.type !== 'FRAME' && f.type !== 'COMPONENT') continue;
      if (f.type === 'FRAME' && f.layoutMode !== 'NONE') continue;
      const cur = bleedOf(old);
      const d: Sides = { t: Math.max(0, bleed.t - cur.t), r: Math.max(0, bleed.r - cur.r), b: Math.max(0, bleed.b - cur.b), l: Math.max(0, bleed.l - cur.l) };
      if (!(d.t || d.r || d.b || d.l)) continue;
      const k = old.scale || 1;
      extendToBleed(f, { t: (d.t * MM) / k, r: (d.r * MM) / k, b: (d.b * MM) / k, l: (d.l * MM) / k }, extendEdges);
      const nb: Sides = { t: cur.t + d.t, r: cur.r + d.r, b: cur.b + d.b, l: cur.l + d.l };
      const meta: FrameMeta = { ...old, bleedSides: nb, bleed: Math.max(nb.t, nb.r, nb.b, nb.l) };
      f.setPluginData(META_KEY, JSON.stringify(meta));
      if (f.type === 'FRAME') applyGuides(f, meta);
      grown++;
      continue;
    }
    if (f.type !== 'FRAME' && f.type !== 'COMPONENT') {
      skipped.push(f.name);
      continue;
    }
    if (f.type === 'FRAME' && f.layoutMode !== 'NONE') {
      skipped.push(f.name);
      continue;
    }
    const meta: FrameMeta = { trimW: f.width / MM, trimH: f.height / MM, bleed: Math.max(bleed.t, bleed.r, bleed.b, bleed.l), bleedSides: bleed, margin: 0, safety: 3, folds: [] };
    extendToBleed(f, { t: bleed.t * MM, r: bleed.r * MM, b: bleed.b * MM, l: bleed.l * MM }, extendEdges);
    f.setPluginData(META_KEY, JSON.stringify(meta));
    if (f.type === 'FRAME') applyGuides(f, meta);
    n++;
  }
  if (grown && n) notify(`已为 ${n} 个画板加上出血，为 ${grown} 个画板补足出血`);
  else if (grown) notify(`已为 ${grown} 个画板补足出血`);
  else notify(n ? `已为 ${n} 个画板加上出血` + (skipped.length ? `；跳过 ${skipped.length} 个自动布局 / 编组画板（导出时会自动处理）` : '') : '没有需要转换的画板');
  sendSelection();
}

// ---------------- scanning ----------------

async function scanColors(frames: SceneNode[]): Promise<ScannedColor[]> {
  const map = new Map<string, ScannedColor>();
  const nameCache = new Map<string, string>();
  const add = (c: RGB, where: string, node: SceneNode, grad = false, name?: string, smallText = false) => {
    const hex = hexOf(c);
    let e = map.get(hex);
    if (!e) {
      e = { hex, count: 0, where: [], sampleNode: node.id, inGradient: false, names: [] };
      map.set(hex, e);
    }
    e.count++;
    if (!e.where.includes(where)) e.where.push(where);
    if (grad) e.inGradient = true;
    if (smallText) e.inSmallText = true;
    if (name && !e.names!.includes(name)) e.names!.push(name);
  };
  const paintName = async (p: SolidPaint, styleId?: string | symbol): Promise<string | undefined> => {
    const vid = (p as any).boundVariables?.color?.id as string | undefined;
    const key = vid || (typeof styleId === 'string' && styleId ? styleId : '');
    if (!key) return undefined;
    if (nameCache.has(key)) return nameCache.get(key);
    let nm = '';
    try {
      if (vid) nm = (await figma.variables.getVariableByIdAsync(vid))?.name || '';
      else nm = (await figma.getStyleByIdAsync(key as string))?.name || '';
    } catch {
      /* library not available */
    }
    nameCache.set(key, nm);
    return nm || undefined;
  };
  const scanPaints = async (paints: Paint[], where: string, node: SceneNode, styleId?: string | symbol, small = false) => {
    for (const p of paints) {
      if (p.type === 'SOLID') add(p.color, where, node, false, await paintName(p, styleId), small);
      else if (p.type.startsWith('GRADIENT')) for (const s of (p as GradientPaint).gradientStops) add(s.color, 'gradient', node, true);
    }
  };
  const visit = async (n: SceneNode) => {
    if (!n.visible) return;
    if (n.type === 'TEXT') {
      for (const s of n.getStyledTextSegments(['fills', 'fillStyleId', 'fontSize'])) await scanPaints(visiblePaints(s.fills), 'text', n, s.fillStyleId, s.fontSize < 12);
    } else if ('fills' in n) await scanPaints(visiblePaints(n.fills as any), 'fill', n, (n as any).fillStyleId);
    if ('strokes' in n && (n as any).strokeWeight !== 0) await scanPaints(visiblePaints(n.strokes), 'stroke', n, (n as any).strokeStyleId);
    if ('effects' in n) for (const e of n.effects) if (e.visible && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')) add(e.color, 'effect', n);
    if ('children' in n) for (const c of n.children) await visit(c);
  };
  for (const f of frames) await visit(f);
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function textNodes(frames: SceneNode[]): TextNodeInfo[] {
  const out: TextNodeInfo[] = [];
  for (const f of frames) {
    if (!('findAllWithCriteria' in f)) continue;
    for (const t of (f as FrameNode).findAllWithCriteria({ types: ['TEXT'] })) {
      if (!t.visible) continue;
      const fonts = new Set<string>();
      for (const s of t.getStyledTextSegments(['fontName'])) fonts.add(`${s.fontName.family} ${s.fontName.style}`);
      const size = t.fontSize === figma.mixed ? Math.min(...t.getStyledTextSegments(['fontSize']).map((s) => s.fontSize)) : t.fontSize;
      out.push({
        id: t.id,
        frame: f.name,
        name: t.name,
        preview: t.characters.slice(0, 40),
        fonts: [...fonts],
        size,
        hasEffects: t.effects.some((e) => e.visible),
        missingFont: t.hasMissingFont,
        mode: (t.getPluginData(TEXT_KEY) as 'live' | 'outline') || 'live',
      });
    }
  }
  return out;
}

// ---------------- preflight ----------------

interface PreflightOpts {
  minPpi: number;
  minStrokePt: number;
  minTextPt: number;
  dieline: ExportRequest['dieline'];
  pureBlackToK: boolean;
}

async function preflight(frames: Exportable[], o: PreflightOpts) {
  const issues: Issue[] = [];
  const images: ImageInfoNode[] = [];
  const imgSizeCache = new Map<string, { width: number; height: number }>();
  if (figma.root.documentColorProfile === 'DISPLAY_P3')
    issues.push({ level: 'warning', cat: 'color', msg: '文档色彩配置是 Display P3。导出时会先转成 sRGB，自定义颜色映射按 sRGB 色值匹配。' });

  for (const f of frames) {
    const meta = getMeta(f);
    const k = meta?.scale || 1; // design scale 1:k
    const bs = meta ? bleedOf(meta) : uni(0);
    const trim = { x: (bs.l * MM) / k, y: (bs.t * MM) / k, w: meta ? (meta.trimW * MM) / k : f.width, h: meta ? (meta.trimH * MM) / k : f.height };
    const safety = ((meta?.safety ?? 3) * MM) / k;
    if (!meta) issues.push({ level: 'info', cat: 'geometry', frame: f.name, nodeId: f.id, msg: `「${f.name}」没有出血。可在「准备」里添加，或导出时自动延伸边缘元素。`, fix: 'autoBleed' });

    const fx = f.absoluteTransform[0][2];
    const fy = f.absoluteTransform[1][2];
    const all = 'findAll' in f ? (f as FrameNode).findAll((n) => n.visible) : [];
    let dielineCount = 0;
    for (const n of all) {
      const bb = n.absoluteBoundingBox;
      if (!bb) continue;
      const L = bb.x - fx, T = bb.y - fy, R = L + bb.width, B = T + bb.height;

      if (o.dieline.mode !== 'off') {
        const spot = dielineSpotFor(n.name, o.dieline.mode === 'manual' ? o.dieline.manualNames : []);
        if (spot && (o.dieline.mode === 'auto' || o.dieline.manualNames.length)) {
          dielineCount++;
          if (['CutContour', 'Fold', 'Score', 'Perforation'].includes(spot) && 'fills' in n && visiblePaints(n.fills as any).length && n.type !== 'FRAME')
            issues.push({ level: 'warning', cat: 'spot', frame: f.name, nodeId: n.id, msg: `刀版层「${n.name}」有填充色，刀线应只用描边。` });
        }
      }

      if (n.type === 'TEXT') {
        if (n.hasMissingFont) issues.push({ level: 'error', cat: 'text', frame: f.name, nodeId: n.id, msg: `「${n.name}」字体缺失，导出会被替换。` });
        const size = (n.fontSize === figma.mixed ? Math.min(...n.getStyledTextSegments(['fontSize']).map((s) => s.fontSize)) : n.fontSize) * k;
        if (size < o.minTextPt) issues.push({ level: 'warning', cat: 'text', frame: f.name, nodeId: n.id, msg: `「${n.name}」字号 ${size.toFixed(1)}pt，小于 ${o.minTextPt}pt，印刷可能看不清。` });
        if (L < trim.x + safety || T < trim.y + safety || R > trim.x + trim.w - safety || B > trim.y + trim.h - safety)
          if (R > trim.x && B > trim.y && L < trim.x + trim.w && T < trim.y + trim.h)
            issues.push({ level: 'warning', cat: 'geometry', frame: f.name, nodeId: n.id, msg: `文字「${n.characters.slice(0, 12)}」进入了安全区（距裁切线 < ${(safety * k / MM).toFixed(0)}mm），裁切时可能被切掉。` });
        if (n.effects.some((e) => e.visible)) issues.push({ level: 'info', cat: 'transparency', frame: f.name, nodeId: n.id, msg: `文字「${n.characters.slice(0, 12)}」带阴影/模糊效果，会以透明效果输出。` });
        // dark text that is not pure black prints as 4-colour black → fuzzy small text
        for (const seg of n.getStyledTextSegments(['fills', 'fontSize'])) {
          for (const p of visiblePaints(seg.fills)) {
            if (p.type !== 'SOLID') continue;
            const { r, g, b } = p.color;
            const isPure = r < 0.004 && g < 0.004 && b < 0.004;
            const dark = Math.max(r, g, b) < 0.16;
            if (dark && (!isPure || !o.pureBlackToK) && seg.fontSize * k < 14)
              issues.push({ level: 'warning', cat: 'color', frame: f.name, nodeId: n.id, msg: `小字「${n.characters.slice(0, 12)}」颜色 ${hexOf(p.color)} 接近黑色但不是纯黑，会印成四色叠加，容易发虚。`, fix: 'k100:' + hexOf(p.color) });
          }
        }
      } else if ('effects' in n && (n as any).effects?.some((e: Effect) => e.visible)) {
        issues.push({ level: 'info', cat: 'transparency', frame: f.name, nodeId: n.id, msg: `「${n.name}」带阴影 / 模糊效果，会被 Figma 转成图像输出（PDF/X-1a 下整页转图）。` });
      }

      // edges: object touches the trim edge but doesn't reach the bleed edge
      if (meta && n.parent === f && 'fills' in n && visiblePaints(n.fills as any).length) {
        const touches = (a: number, edge: number) => Math.abs(a - edge) < 1.5;
        const bad =
          (touches(L, trim.x) && L > 0.5 && bs.l > 0) ||
          (touches(T, trim.y) && T > 0.5 && bs.t > 0) ||
          (touches(R, trim.x + trim.w) && R < f.width - 0.5 && bs.r > 0) ||
          (touches(B, trim.y + trim.h) && B < f.height - 0.5 && bs.b > 0);
        if (bad) issues.push({ level: 'error', cat: 'geometry', frame: f.name, nodeId: n.id, msg: `「${n.name}」贴着裁切线但没延伸到出血区，裁切后可能露白边。` });
      }

      if ('strokes' in n && visiblePaints(n.strokes).length) {
        const w = (n as any).strokeWeight;
        if (typeof w === 'number' && w > 0 && w * k < o.minStrokePt)
          issues.push({ level: 'warning', cat: 'geometry', frame: f.name, nodeId: n.id, msg: `「${n.name}」描边 ${+(w * k).toFixed(2)}pt 太细（< ${o.minStrokePt}pt），印刷可能断线。`, fix: 'minStroke' });
      }

      if ('blendMode' in n && n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH')
        issues.push({ level: 'info', cat: 'transparency', frame: f.name, nodeId: n.id, msg: `「${n.name}」使用了混合模式（${n.blendMode}），需 PDF/X-4。` });

      if ('annotations' in n && (n as any).annotations?.length)
        issues.push({ level: 'info', cat: 'annotation', frame: f.name, nodeId: n.id, msg: `「${n.name}」带有开发注释，注释不会进入印刷文件。` });

      if ('fills' in n) {
        for (const p of visiblePaints(n.fills as any)) {
          if (p.type !== 'IMAGE' || !p.imageHash) continue;
          let size = imgSizeCache.get(p.imageHash);
          if (!size) {
            const img = figma.getImageByHash(p.imageHash);
            if (!img) continue;
            size = await img.getSizeAsync();
            imgSizeCache.set(p.imageHash, size);
          }
          const ppi = Math.round(effectivePpi(n as any, p as ImagePaint, size) / k);
          images.push({ id: n.id, frame: f.name, name: n.name, px: `${size.width}×${size.height}`, ppi });
          if (ppi < o.minPpi)
            issues.push({ level: ppi < o.minPpi * 0.5 ? 'error' : 'warning', cat: 'resolution', frame: f.name, nodeId: n.id, msg: `图片「${n.name}」实际分辨率 ${ppi} ppi，低于 ${o.minPpi} ppi，印刷会模糊。`, fix: 'upscale' });
        }
      }
    }
    if (o.dieline.mode !== 'off')
      issues.push({
        level: dielineCount ? 'pass' : 'info',
        cat: 'spot',
        frame: f.name,
        msg: dielineCount ? `「${f.name}」识别到 ${dielineCount} 个刀版/工艺层，导出为专色分版。` : `「${f.name}」没有识别到刀版/工艺层（图层名需以 Cut、刀版、Fold、烫金等关键词开头）。`,
      });
  }
  return { issues, images };
}

function effectivePpi(n: { width: number; height: number }, p: ImagePaint, size: { width: number; height: number }) {
  const nw = n.width, nh = n.height;
  let scale: number; // display px per image px
  if (p.scaleMode === 'FIT') scale = Math.min(nw / size.width, nh / size.height);
  else if (p.scaleMode === 'TILE') scale = p.scalingFactor ?? 1;
  else if (p.scaleMode === 'CROP' && p.imageTransform) {
    const t = p.imageTransform;
    scale = Math.max(nw / (size.width * Math.abs(t[0][0]) || 1), nh / (size.height * Math.abs(t[1][1]) || 1));
  } else scale = Math.max(nw / size.width, nh / size.height);
  return 72 / scale;
}

// ---------------- export ----------------

async function exportFrames(req: ExportRequest): Promise<ExportedFrame[]> {
  const out: ExportedFrame[] = [];
  const nodes = (await Promise.all(req.frameIds.map((id) => figma.getNodeByIdAsync(id)))).filter(Boolean) as SceneNode[];
  const finishing = req.colorFinishing || {};
  let i = 0;
  for (const f of nodes) {
    if (!isExportable(f)) continue;
    post('progress', { msg: `从 Figma 导出：${f.name}`, frac: (i / nodes.length) * 0.4 });
    const meta = getMeta(f);
    const scale = meta?.scale || 1;
    const reqB = req.bleedSides || uni(req.bleedMm);
    const bPx: Sides = { t: reqB.t * MM, r: reqB.r * MM, b: reqB.b * MM, l: reqB.l * MM };
    const needBleedClone = !meta && req.autoBleed && (bPx.t || bPx.r || bPx.b || bPx.l) > 0 && f.type !== 'SECTION';
    const sentinels: ExportedFrame['sentinels'] = [];
    const vectorStrokes: ExportedFrame['vectorStrokes'] = [];
    let hairlinesFixed = 0;
    const raster = req.format === 'PNG';
    const needDieline = req.dieline.mode !== 'off' || Object.keys(finishing).length > 0;
    const needHairline = !raster && req.minStrokePt > 0 && hasThinStroke(f, req.minStrokePt / scale);
    const needOutline = !raster && (req.textOutline === 'all' || (req.textOutline === 'perNode' && hasOutlineText(f)));
    let target: SceneNode = f;
    let clone: SceneNode | null = null;
    try {
      if (f.type !== 'SECTION' && (needBleedClone || needDieline || needOutline || needHairline)) {
        let c = f.clone() as Exportable;
        clone = c; // Own the temporary node before any Figma operation can throw.
        figma.currentPage.appendChild(c);
        c.x = -100000;
        c.y = -100000;
        if (c.type === 'INSTANCE') {
          c = c.detachInstance();
          clone = c;
        }
        if (needBleedClone) {
          if (c.type === 'FRAME' && c.layoutMode === 'NONE') {
            extendToBleed(c, bPx, true);
            clone = c;
          } else if (c.type === 'COMPONENT') {
            extendToBleed(c, bPx, true);
            clone = c;
          } else {
            // auto-layout frames and groups: wrap so the background extends into the bleed
            const wrap = figma.createFrame();
            // Keep both nodes reachable for cleanup if wrapping fails.
            try {
              wrap.resize(c.width + bPx.l + bPx.r, c.height + bPx.t + bPx.b);
              wrap.fills = c.type === 'FRAME' ? clonePaints(c.fills) : [];
              wrap.clipsContent = true;
              wrap.x = c.x;
              wrap.y = c.y;
              figma.currentPage.appendChild(wrap);
              wrap.appendChild(c);
              c.x = bPx.l;
              c.y = bPx.t;
              clone = wrap;
            } catch (error) {
              if (!wrap.removed) wrap.remove();
              throw error;
            }
          }
        } else clone = c;
        if (needOutline || needDieline || needHairline)
          for (const inst of ('findAllWithCriteria' in c ? (c as FrameNode).findAllWithCriteria({ types: ['INSTANCE'] }) : [])) if (!inst.removed) inst.detachInstance();

        if (needDieline) {
          const spotIdx = new Map<string, number>();
          const nameSpot = (n: SceneNode) => (req.dieline.mode === 'off' || (req.dieline.mode === 'manual' && !req.dieline.manualNames.length) ? null : dielineSpotFor(n.name, req.dieline.mode === 'manual' ? req.dieline.manualNames : []));
          const all = 'findAll' in c ? (c as FrameNode).findAll() : [];
          const matched = all.filter((n) => nameSpot(n));
          const roots = matched.filter((n) => !matched.some((m) => m !== n && isAncestor(m, n)));
          const sentinelFor = (spot: string) => {
            if (!spotIdx.has(spot)) spotIdx.set(spot, spotIdx.size);
            const col: RGB = { r: 254 / 255, g: (1 + spotIdx.get(spot)!) / 255, b: 253 / 255 };
            const hex = hexOf(col);
            if (!sentinels.some((x) => x.hex === hex)) sentinels.push({ hex, spotName: spot });
            return col;
          };
          const handleLeaf = (leaf: SceneNode, spotForStroke: string | null, spotForFill: string | null) => {
            if (leaf.removed || !leaf.visible) return;
            const hasStroke = !!spotForStroke && 'strokes' in leaf && visiblePaints(leaf.strokes).length > 0 && strokeWeightOf(leaf) > 0;
            const hasFill = !!spotForFill && 'fills' in leaf && visiblePaints((leaf as any).fills).length > 0;
            if (hasStroke) {
              if (!raster) {
                // true centre-line path for cutting plotters (Figma would outline the stroke)
                const geo = strokeGeometry(leaf, clone!);
                if (!geo?.length) throw new Error(`无法提取「${leaf.name}」的刀线或工艺路径，请检查图层后重试。`);
                vectorStrokes.push({ spotName: spotForStroke!, weight: strokeWeightOf(leaf) * scale, dash: [...((leaf as any).dashPattern || [])].map((d: number) => d * scale), paths: geo });
              }
              const otherFill = 'fills' in leaf && visiblePaints((leaf as any).fills).length > 0;
              if (otherFill) (leaf as any).strokes = [];
              else {
                leaf.remove();
                return;
              }
            }
            if (hasFill) {
              if (raster) leaf.remove();
              else recolor(leaf, { type: 'SOLID', color: sentinelFor(spotForFill!) });
            }
          };
          for (const n of roots) {
            const spot = nameSpot(n)!;
            for (const leaf of leavesOf(n)) handleLeaf(leaf, spot, spot);
          }
          // colour-based finishing: strokes / fills of a given HEX become a finishing separation
          if (Object.keys(finishing).length) {
            for (const n of 'findAll' in c ? (c as FrameNode).findAll() : []) {
              if (n.removed || 'children' in n) continue;
              const sp = 'strokes' in n ? visiblePaints(n.strokes).find((p) => p.type === 'SOLID' && finishing[hexOf((p as SolidPaint).color)]) : undefined;
              const fp = 'fills' in n ? visiblePaints((n as any).fills).find((p) => p.type === 'SOLID' && finishing[hexOf((p as SolidPaint).color)]) : undefined;
              if (!sp && !fp) continue;
              handleLeaf(n, sp ? finishing[hexOf((sp as SolidPaint).color)] : null, fp ? finishing[hexOf((fp as SolidPaint).color)] : null);
            }
          }
        }
        if (needHairline) {
          for (const n of 'findAll' in c ? (c as FrameNode).findAll() : []) {
            if (n.removed || !('strokes' in n) || !visiblePaints(n.strokes).length) continue;
            const w = strokeWeightOf(n);
            if (w > 0 && w * scale < req.minStrokePt) {
              (n as any).strokeWeight = req.minStrokePt / scale;
              hairlinesFixed++;
            }
          }
        }
        if (needOutline) {
          for (const t of (c as FrameNode).findAllWithCriteria({ types: ['TEXT'] })) {
            const mode = req.textOutline === 'all' ? 'outline' : t.getPluginData(TEXT_KEY);
            if (mode === 'outline' && !t.removed && t.visible) {
              try {
                figma.flatten([t]);
              } catch {
                throw new Error(`无法将「${t.name}」文字转曲，请检查字体和图层后重试。`);
              }
            }
          }
        }
        target = clone!;
      }
      const tn = target as FrameNode;
      const srcBleedMm: Sides = meta ? bleedOf(meta) : needBleedClone ? reqB : uni(0);
      const srcBleed: Sides = { t: (srcBleedMm.t * MM) / scale, r: (srcBleedMm.r * MM) / scale, b: (srcBleedMm.b * MM) / scale, l: (srcBleedMm.l * MM) / scale };
      const base: Omit<ExportedFrame, 'pdf'> = {
        id: f.id,
        name: f.name,
        trimW: meta ? (meta.trimW * MM) / scale : f.width,
        trimH: meta ? (meta.trimH * MM) / scale : f.height,
        srcBleed: needBleedClone && !meta ? { t: bPx.t, r: bPx.r, b: bPx.b, l: bPx.l } : srcBleed,
        scale,
        sentinels,
        vectorStrokes,
        pageH: tn.height,
        hairlinesFixed,
      };
      if (raster) {
        const png = await renderPng(tn, ((req.pngDpi || 300) / 72) * scale);
        out.push({ ...base, pdf: new Uint8Array(0), png });
      } else {
        const pdf = await tn.exportAsync({ format: 'PDF', colorProfile: 'SRGB' } as ExportSettingsPDF);
        const png = req.rasterDpi ? await renderPng(tn, (req.rasterDpi / 72) * scale) : undefined;
        out.push({ ...base, pdf, png });
      }
    } finally {
      if (clone && !clone.removed) clone.remove();
    }
    i++;
  }
  return out;
}

/** PNG render with a pixel-size guard (Figma refuses huge exports). */
async function renderPng(n: SceneNode, scale: number): Promise<Uint8Array> {
  const max = 16000;
  const s = Math.min(scale, max / Math.max(1, n.width), max / Math.max(1, n.height));
  if (s < scale) post('notice', { text: `「${n.name}」尺寸太大，位图分辨率已自动降到 ${Math.round(s * 72)} dpi` });
  return n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: s }, colorProfile: 'SRGB' } as ExportSettingsImage);
}

function strokeWeightOf(n: SceneNode): number {
  const w = (n as any).strokeWeight;
  if (typeof w === 'number') return w;
  return Math.max(...['strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight'].map((k) => (n as any)[k] || 0));
}

function hasThinStroke(f: SceneNode, min: number): boolean {
  if (!('findAll' in f)) return false;
  return (f as FrameNode).findAll((n) => n.visible && 'strokes' in n && visiblePaints(n.strokes).length > 0 && strokeWeightOf(n) > 0 && strokeWeightOf(n) < min).length > 0;
}

function isAncestor(a: BaseNode, b: BaseNode): boolean {
  for (let p = b.parent; p; p = p.parent) if (p === a || p.id === a.id) return true;
  return false;
}

function leavesOf(n: SceneNode): SceneNode[] {
  if ('children' in n && n.type !== 'BOOLEAN_OPERATION') return (n.children as SceneNode[]).flatMap(leavesOf);
  return [n];
}

type M = [[number, number, number], [number, number, number]];
const invert = (t: M): M => {
  const [[a, c, e], [b, d, f]] = t;
  const det = a * d - b * c || 1;
  return [
    [d / det, -c / det, (c * f - d * e) / det],
    [-b / det, a / det, (b * e - a * f) / det],
  ];
};
const compose = (p: M, q: M): M => [
  [p[0][0] * q[0][0] + p[0][1] * q[1][0], p[0][0] * q[0][1] + p[0][1] * q[1][1], p[0][0] * q[0][2] + p[0][1] * q[1][2] + p[0][2]],
  [p[1][0] * q[0][0] + p[1][1] * q[1][0], p[1][0] * q[0][1] + p[1][1] * q[1][1], p[1][0] * q[0][2] + p[1][1] * q[1][2] + p[1][2]],
];

/** Vector paths of a shape in the export root's coordinate space, as [a b c d e f] + SVG data. */
function strokeGeometry(leaf: SceneNode, root: SceneNode): { d: string; m: number[] }[] | null {
  let temporary: SceneNode | null = null;
  try {
    // clone() parents the copy to the page; put it next to the original so it keeps the same position
    const dup = leaf.clone();
    temporary = dup;
    const parent = leaf.parent as (BaseNode & ChildrenMixin) | null;
    if (parent && 'appendChild' in parent) parent.appendChild(dup);
    if (parent && 'layoutMode' in parent && (parent as FrameNode).layoutMode !== 'NONE') (dup as any).layoutPositioning = 'ABSOLUTE';
    (dup as any).relativeTransform = (leaf as any).relativeTransform;
    const v = leaf.type === 'VECTOR' ? (dup as VectorNode) : figma.flatten([dup], parent as any);
    temporary = v;
    const rel = compose(invert(root.absoluteTransform as M), v.absoluteTransform as M);
    const m = [rel[0][0], rel[1][0], rel[0][1], rel[1][1], rel[0][2], rel[1][2]];
    const paths = v.vectorPaths.map((p) => ({ d: p.data, m }));
    return paths;
  } catch {
    return null;
  } finally {
    if (temporary && !temporary.removed) temporary.remove();
  }
}

function hasOutlineText(f: SceneNode): boolean {
  if (!('findAllWithCriteria' in f)) return false;
  return (f as FrameNode).findAllWithCriteria({ types: ['TEXT'] }).some((t) => t.getPluginData(TEXT_KEY) === 'outline');
}

function clonePaints(p: ReadonlyArray<Paint> | PluginAPI['mixed']): Paint[] {
  return p === figma.mixed ? [] : JSON.parse(JSON.stringify(p));
}

function recolor(n: SceneNode, paint: SolidPaint) {
  if ('opacity' in n) (n as any).opacity = 1;
  if ('fills' in n && n.type !== 'FRAME') {
    const fl = n.fills;
    if (fl !== figma.mixed && fl.length) (n as any).fills = [paint];
    else if (n.type === 'TEXT') (n as TextNode).fills = [paint];
  }
  if ('strokes' in n && n.strokes.length) (n as any).strokes = [paint];
  if ('effects' in n) (n as any).effects = [];
  if ('children' in n) for (const c of (n as any).children as SceneNode[]) recolor(c, paint);
}

// ---------------- tools ----------------

async function loadFontFor(t?: TextNode): Promise<FontName> {
  const candidates: FontName[] = [];
  if (t && t.fontName !== figma.mixed) candidates.push(t.fontName);
  candidates.push({ family: 'PingFang SC', style: 'Regular' }, { family: 'Noto Sans SC', style: 'Regular' }, { family: 'Inter', style: 'Regular' });
  for (const f of candidates) {
    try {
      await figma.loadFontAsync(f);
      return f;
    } catch {
      /* try next */
    }
  }
  return { family: 'Inter', style: 'Regular' };
}

/** Fill / stroke the selection with a colour (and remember its exact CMYK via the UI's override). */
function applyColor(hex: string, target: 'fill' | 'stroke') {
  const paint: SolidPaint = { type: 'SOLID', color: rgbOf(hex) };
  let n = 0;
  for (const node of figma.currentPage.selection) {
    if (target === 'stroke' && 'strokes' in node) {
      (node as any).strokes = [paint];
      n++;
    } else if ('fills' in node) {
      (node as any).fills = [paint];
      n++;
    }
  }
  notify(n ? `已为 ${n} 个图层上色 ${hex}` : '请先选中要上色的图层');
}

function swatchInfo() {
  const items: { id: string; hex: string }[] = [];
  for (const n of figma.currentPage.selection) {
    const nodes = 'children' in n ? [n, ...(n as FrameNode).findAll()] : [n];
    for (const x of nodes) {
      if (x.type === 'TEXT' || !('fills' in x)) continue;
      const p = visiblePaints((x as any).fills).find((q) => q.type === 'SOLID') as SolidPaint | undefined;
      if (p && x.getPluginData(LABEL_KEY) === '' && !(x.parent && (x.parent as BaseNode).getPluginData?.(LABEL_KEY))) items.push({ id: x.id, hex: hexOf(p.color) });
    }
  }
  return items;
}

async function swatchLabels(items: { id: string; lines: string[] }[]) {
  const font = await loadFontFor();
  let n = 0;
  for (const it of items) {
    const node = (await figma.getNodeByIdAsync(it.id)) as SceneNode | null;
    if (!node || !node.parent) continue;
    // remove previous labels of this swatch
    for (const old of (node.parent as ChildrenMixin).children.filter((c) => c.getPluginData(LABEL_KEY) === node.id)) old.remove();
    const t = figma.createText();
    t.fontName = font;
    t.fontSize = Math.max(6, Math.min(12, ('width' in node ? node.width : 100) / 12));
    t.characters = it.lines.join('\n');
    t.fills = [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2 } }];
    t.name = tr('色卡标注');
    t.setPluginData(LABEL_KEY, node.id);
    (node.parent as ChildrenMixin).appendChild(t);
    if ('layoutPositioning' in t && 'layoutMode' in node.parent && (node.parent as FrameNode).layoutMode !== 'NONE') t.layoutPositioning = 'ABSOLUTE';
    t.x = node.x;
    t.y = node.y + ('height' in node ? node.height : 0) + 4;
    n++;
  }
  notify(n ? `已生成 ${n} 个色卡标注` : '没有找到纯色色块');
}

async function pageNumbers(o: { ids: string[]; format: string; start: number; skip: number; create: boolean; position: 'center' | 'outer' }) {
  const frames = (await Promise.all(o.ids.map((id) => figma.getNodeByIdAsync(id)))).filter((n) => n && isFrameLike(n)) as FrameNode[];
  const total = frames.length - o.skip;
  let n = 0;
  for (let i = o.skip; i < frames.length; i++) {
    const f = frames[i];
    const num = o.start + i - o.skip;
    const text = o.format.replace('{n}', String(num)).replace('{total}', String(total + o.start - 1));
    let nodes = f.findAllWithCriteria({ types: ['TEXT'] }).filter((t) => t.getPluginData('pk_pagenum') === '1' || /^(页码|頁碼|page ?number|#|\{n\})$/i.test(t.name.trim()) || t.name.trim() === tr('页码'));
    if (!nodes.length && o.create) {
      const meta = getMeta(f);
      const k = meta?.scale || 1;
      const b = meta ? bleedOf(meta) : uni(0);
      const t = figma.createText();
      const font = await loadFontFor();
      t.fontName = font;
      t.fontSize = 9 / k;
      t.name = tr('页码');
      t.setPluginData('pk_pagenum', '1');
      t.characters = text;
      f.appendChild(t);
      const trimB = f.height - (b.b * MM) / k;
      const safe = ((meta?.safety ?? 5) * MM) / k + 4 / k;
      t.y = trimB - safe - t.height;
      const odd = num % 2 === 1;
      if (o.position === 'center') t.x = (f.width - t.width) / 2;
      else t.x = odd ? f.width - (b.r * MM) / k - safe - t.width : (b.l * MM) / k + safe;
      nodes = [t];
    }
    for (const t of nodes) {
      await figma.loadFontAsync(t.fontName === figma.mixed ? (t.getRangeFontName(0, 1) as FontName) : t.fontName);
      t.characters = text;
      n++;
    }
  }
  notify(n ? `已更新 ${n} 个页码` : '没有找到名为「页码」的文字图层（可勾选“没有就自动添加”）');
}

/** Packaging dielines (mm): cut lines solid, fold lines dashed, named so the exporter picks them up. */
function boxDieline(o: { style: 'ste' | 'tray' | 'mailer'; w: number; d: number; h: number }) {
  const { w: W, d: D, h: H } = o;
  const cut: string[] = [];
  const fold: string[] = [];
  const P = (pts: [number, number][]) => 'M ' + pts.map(([x, y]) => `${(x * MM).toFixed(2)} ${(y * MM).toFixed(2)}`).join(' L ');
  const line = (x1: number, y1: number, x2: number, y2: number) => fold.push(P([[x1, y1], [x2, y2]]));
  if (o.style === 'ste') {
    // straight tuck end: glue | side | front | side | back
    const g = Math.min(15, W * 0.25);
    const x1 = g, x2 = g + D, x3 = g + D + W, x4 = g + 2 * D + W, x5 = g + 2 * D + 2 * W;
    const t = Math.min(15, D * 0.6); // tuck flap
    const dh = Math.min(D * 0.8, W * 0.6); // dust flap
    cut.push(P([[x1, 0], [0, 4], [0, H - 4], [x1, H]])); // glue flap
    cut.push(P([[x5, 0], [x5, H]]));
    // top: lid on back panel, dust flaps on sides, front edge straight
    cut.push(P([[x1, 0], [x1, -dh + 3], [x1 + 3, -dh], [x2 - 2, -dh], [x2, -2], [x2, 0], [x3, 0], [x3, -2], [x3 + 2, -dh], [x4 - 3, -dh], [x4, -dh + 3], [x4, -D], [x4 + 2, -D - t], [x5 - 2, -D - t], [x5, -D], [x5, 0]]));
    // bottom: lid on front panel (reverse tuck)
    cut.push(P([[x1, H], [x1, H + dh - 3], [x1 + 3, H + dh], [x2 - 2, H + dh], [x2, H + D], [x2 + 2, H + D + t], [x3 - 2, H + D + t], [x3, H + D], [x3, H + 2], [x3 + 2, H + dh], [x4 - 3, H + dh], [x4, H + dh - 3], [x4, H], [x5, H]]));
    for (const x of [x1, x2, x3, x4]) line(x, 0, x, H);
    line(x1, 0, x2, 0); line(x3, 0, x4, 0); line(x4, 0, x5, 0); line(x4, -D, x5, -D);
    line(x1, H, x2, H); line(x3, H, x4, H); line(x2, H, x3, H); line(x2, H + D, x3, H + D);
  } else {
    // tray / mailer base: cross layout with walls, corner glue tabs
    const lid = o.style === 'mailer';
    const x0 = H, y0 = H;
    const tab = Math.min(H * 0.8, 15);
    cut.push(P([[x0, y0 - H], [x0 + W, y0 - H]]));
    cut.push(P([[x0 + W, y0 - H], [x0 + W, y0 - H + 2], [x0 + W + tab, y0 - 2], [x0 + W + H, y0]]));
    cut.push(P([[x0 + W + H, y0], [x0 + W + H, y0 + D]]));
    cut.push(P([[x0 + W + H, y0 + D], [x0 + W + tab, y0 + D + 2], [x0 + W, y0 + D + H - 2], [x0 + W, y0 + D + H]]));
    cut.push(P([[x0, y0 - H], [x0, y0 - H + 2], [x0 - tab, y0 - 2], [x0 - H, y0], [x0 - H, y0 + D], [x0 - tab, y0 + D + 2], [x0, y0 + D + H - 2], [x0, y0 + D + H]]));
    if (lid) {
      // back wall carries the lid + front tuck
      const t = Math.min(H, 20);
      cut.push(P([[x0, y0 + D + H], [x0, y0 + D + H + D], [x0 + 3, y0 + D + H + D + t], [x0 + W - 3, y0 + D + H + D + t], [x0 + W, y0 + D + H + D], [x0 + W, y0 + D + H]]));
      line(x0, y0 + D + H, x0 + W, y0 + D + H);
      line(x0, y0 + D + H + D, x0 + W, y0 + D + H + D);
    } else cut.push(P([[x0, y0 + D + H], [x0 + W, y0 + D + H]]));
    line(x0, y0, x0 + W, y0); line(x0, y0 + D, x0 + W, y0 + D); line(x0, y0, x0, y0 + D); line(x0 + W, y0, x0 + W, y0 + D);
  }
  const mk = (name: string, paths: string[], color: RGB, dashed: boolean) => {
    const v = figma.createVector();
    v.vectorPaths = paths.map((data) => ({ windingRule: 'NONE', data }));
    v.strokes = [{ type: 'SOLID', color }];
    v.strokeWeight = 1;
    v.fills = [];
    if (dashed) v.dashPattern = [6, 3];
    v.name = name;
    return v;
  };
  // names must keep the Cut / Fold prefix so the exporter recognises them in every language
  const cutV = mk(tr('Cut 刀线'), cut, { r: 0.93, g: 0, b: 0.55 }, false);
  const foldV = mk(tr('Fold 折线'), fold, { r: 0, g: 0.62, b: 0.91 }, true);
  const label = tr({ ste: '插舌盒', tray: '托盘盒', mailer: '飞机盒' }[o.style]);
  const g = figma.group([cutV, foldV], figma.currentPage);
  g.name = tr(`刀版 · ${label} ${W}×${D}×${H}mm`);
  g.x = nextFreeX();
  g.y = 0;
  figma.currentPage.selection = [g];
  figma.viewport.scrollAndZoomIntoView([g]);
  notify(`已生成${label}刀版。把设计稿放在它下面，导出时开启“按图层名识别刀版”即可分出刀线 / 折线专色版`);
}

async function setImage(id: string, bytes: Uint8Array) {
  const n = (await figma.getNodeByIdAsync(id)) as SceneNode | null;
  if (!n || !('fills' in n)) return notify('请选中一个带图片的图层', { error: true });
  const img = figma.createImage(bytes);
  const fills = clonePaints((n as any).fills);
  let done = false;
  for (const p of fills) if (p.type === 'IMAGE' && !done) {
    (p as any).imageHash = img.hash; // keeps scaleMode, crop transform, filters
    done = true;
  }
  if (!done) fills.push({ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' } as ImagePaint);
  (n as any).fills = fills;
  notify('图片已替换，裁切和缩放方式保持不变');
}

async function imageBytes(id: string) {
  const n = (await figma.getNodeByIdAsync(id)) as SceneNode | null;
  const p = n && 'fills' in n ? (visiblePaints((n as any).fills).find((q) => q.type === 'IMAGE') as ImagePaint | undefined) : undefined;
  if (!p?.imageHash) return null;
  return figma.getImageByHash(p.imageHash)?.getBytesAsync() ?? null;
}

function rescaleFrames(dpi: number) {
  let n = 0;
  for (const f of targetFrames()) {
    if (!isFrameLike(f)) continue;
    f.rescale(72 / dpi);
    n++;
  }
  notify(n ? `已把 ${n} 个画板从 ${dpi} DPI 像素尺寸缩回实际尺寸（图片清晰度不变）` : '请先选中画板');
  sendSelection();
}

// ---------------- message router ----------------

figma.on('selectionchange', sendSelection);
figma.on('currentpagechange', sendSelection);

figma.ui.onmessage = async (msg: any) => {
  try {
    switch (msg.type) {
      case 'migration-export':
        post('migration-backup', { backup: await exportMigration() });
        break;
      case 'migration-import':
        post('migration-imported', { result: await importMigration(msg.backup) });
        sendSelection();
        break;
      case 'init': {
        const [settings, profiles, maps, presets] = await Promise.all(['pk_settings', 'pk_icc_list', 'pk_maps', 'pk_presets'].map((k) => figma.clientStorage.getAsync(k)));
        let fileMaps: any[] = [];
        try {
          fileMaps = JSON.parse(figma.root.getPluginData('pk_maps') || '[]');
        } catch {
          /* ignore */
        }
        post('init', { settings: settings || null, profiles: profiles || [], maps: maps || [], fileMaps, presets: presets || [], docProfile: figma.root.documentColorProfile, fileName: figma.root.name });
        sendSelection();
        break;
      }
      case 'create-doc': {
        const created = createDocument(msg.opts);
        figma.currentPage.selection = created;
        figma.viewport.scrollAndZoomIntoView(created);
        notify(`已创建 ${created.length} 个印刷页面。按 ⌘⇧4 可显示/隐藏参考网格`);
        sendSelection();
        break;
      }
      case 'csv-frames': {
        let x = nextFreeX();
        const all: FrameNode[] = [];
        for (const r of msg.rows) {
          const made = createDocument({ ...msg.base, ...r, bleed: r.bleed !== undefined ? uni(r.bleed) : msg.base.bleed }, { x, y: 0 });
          all.push(...made);
          x = Math.max(...made.map((f) => f.x + f.width)) + 120;
        }
        figma.currentPage.selection = all;
        figma.viewport.scrollAndZoomIntoView(all);
        notify(`已按 CSV 创建 ${all.length} 个画板`);
        sendSelection();
        break;
      }
      case 'convert-frames':
        convertFrames(msg.bleed, msg.extend);
        break;
      case 'scan-colors':
        post('colors', { colors: await scanColors(targetFrames()) });
        break;
      case 'scan-text':
        post('texts', { texts: textNodes(targetFrames()) });
        break;
      case 'set-text-mode': {
        for (const id of msg.ids as string[]) {
          const n = await figma.getNodeByIdAsync(id);
          if (n) n.setPluginData(TEXT_KEY, msg.mode === 'outline' ? 'outline' : '');
        }
        post('texts', { texts: textNodes(targetFrames()) });
        break;
      }
      case 'preflight': {
        const frames = targetFrames();
        const [result, colors] = await Promise.all([preflight(frames, msg.opts), scanColors(frames)]);
        post('preflight', { ...result, colors, reqId: msg.reqId });
        break;
      }
      case 'export':
        post('exported', { frames: await exportFrames(msg.req) });
        break;
      case 'thumbs': {
        for (const id of msg.ids as string[]) {
          const n = (await figma.getNodeByIdAsync(id)) as SceneNode | null;
          if (!n || !('exportAsync' in n)) continue;
          const png = await n.exportAsync({ format: 'PNG', constraint: { type: 'HEIGHT', value: 96 } });
          post('thumb', { id, png });
        }
        break;
      }
      case 'render': {
        const n = (await figma.getNodeByIdAsync(msg.id)) as SceneNode | null;
        if (!n || !('exportAsync' in n)) break;
        const s = Math.min(4, msg.maxPx / Math.max(n.width, n.height));
        const png = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: s }, colorProfile: 'SRGB' } as ExportSettingsImage);
        post('rendered', { id: n.id, name: n.name, png });
        break;
      }
      case 'select-node': {
        const n = await figma.getNodeByIdAsync(msg.id);
        if (n && 'visible' in n) {
          let p: BaseNode | null = n;
          while (p && p.type !== 'PAGE') p = p.parent;
          if (p && p.type === 'PAGE' && p !== figma.currentPage) await figma.setCurrentPageAsync(p);
          figma.currentPage.selection = [n as SceneNode];
          figma.viewport.scrollAndZoomIntoView([n as SceneNode]);
        }
        break;
      }
      case 'resize-node': {
        for (const id of msg.ids as string[]) {
          const n = (await figma.getNodeByIdAsync(id)) as SceneNode | null;
          if (!n) continue;
          if ((msg.w || msg.h) && 'resize' in n) {
            const w = msg.w || (msg.keepRatio && msg.h ? (n.width * msg.h) / n.height : n.width);
            const h = msg.h || (msg.keepRatio && msg.w ? (n.height * msg.w) / n.width : n.height);
            (n as any).resize(Math.max(0.01, w), Math.max(0.01, h));
          }
          if (msg.fontSize && n.type === 'TEXT') {
            for (const f of n.getStyledTextSegments(['fontName'])) await figma.loadFontAsync(f.fontName);
            n.fontSize = msg.fontSize;
          }
          if (msg.strokeWeight !== undefined && 'strokeWeight' in n) (n as any).strokeWeight = msg.strokeWeight;
          if (msg.cornerRadius !== undefined && 'cornerRadius' in n) (n as any).cornerRadius = msg.cornerRadius;
        }
        sendSelection();
        break;
      }
      case 'apply-color':
        applyColor(msg.hex, msg.target);
        break;
      case 'swatch-info':
        post('swatch-info', { items: swatchInfo() });
        break;
      case 'swatch-labels':
        await swatchLabels(msg.items);
        break;
      case 'page-numbers':
        await pageNumbers(msg.opts);
        break;
      case 'box-dieline':
        boxDieline(msg.opts);
        break;
      case 'get-image': {
        const bytes = await imageBytes(msg.id);
        post('image-bytes', { id: msg.id, bytes });
        break;
      }
      case 'set-image':
        await setImage(msg.id, msg.bytes);
        sendSelection();
        break;
      case 'rescale-dpi':
        rescaleFrames(msg.dpi);
        break;
      case 'file-maps-set':
        figma.root.setPluginData('pk_maps', JSON.stringify(msg.maps));
        break;
      case 'store-set':
        await figma.clientStorage.setAsync(msg.key, msg.value);
        break;
      case 'store-get':
        post('store-value', { key: msg.key, value: await figma.clientStorage.getAsync(msg.key), reqId: msg.reqId });
        break;
      case 'store-delete':
        await figma.clientStorage.deleteAsync(msg.key);
        break;
      case 'set-lang':
        setLang(msg.lang);
        break;
      case 'notify':
        figma.notify(msg.text, { error: !!msg.error, timeout: msg.timeout || 4000 });
        break;
      case 'resize':
        figma.ui.resize(msg.w, msg.h);
        break;
      case 'close':
        figma.closePlugin();
        break;
    }
  } catch (e: any) {
    post('error', { message: String(e?.message || e), during: msg.type, reqId: msg.reqId });
  }
};
