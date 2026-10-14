// Final print document assembly: places converted pages with bleed, adds printer's marks
// (crop, registration, colour bars, trim line), page boxes, links, bookmarks, metadata,
// PDF/X-1a / X-3 / X-4 output intent, and imposition (spreads, n-up, saddle-stitch booklet, duplex).

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHeader,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import { latin1ToBytes, fmt } from './lexer';
import { lookupDict } from './streams';

export const MM = 72 / 25.4;

export interface Sides {
  t: number;
  r: number;
  b: number;
  l: number;
}
export const uniform = (v: number): Sides => ({ t: v, r: v, b: v, l: v });
const minSides = (a: Sides, b: Sides): Sides => ({ t: Math.min(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b), l: Math.min(a.l, b.l) });
const maxSide = (s: Sides) => Math.max(s.t, s.r, s.b, s.l);
const scaleSides = (s: Sides, k: number): Sides => ({ t: s.t * k, r: s.r * k, b: s.b * k, l: s.l * k });

export interface PageSource {
  doc: PDFDocument; // converted single-page document
  trimW: number; // pt (at design scale)
  trimH: number; // pt
  srcBleed: Sides; // pt of bleed included around trim in the source page
  name: string;
  scale?: number; // output scale for large formats designed at 1:N (N)
}

export interface MarkOptions {
  cropMarks: boolean;
  regMarks: boolean;
  colorBars: boolean;
  trimLine?: boolean; // hairline frame on the trim edge
  markWeight: number; // pt
}

export type Imposition =
  | { kind: 'none' }
  | { kind: 'spreads' }
  | { kind: 'booklet'; rtl: boolean }
  | { kind: 'nup'; sheetW: number; sheetH: number; rows: number; cols: number; gutter: number; repeat: boolean; copies: number }
  | { kind: 'duplex'; sheetW: number; sheetH: number; rows: number; cols: number; gutter: number; copies: number };

export interface ComposeOptions extends MarkOptions {
  bleed: Sides; // pt of bleed to keep in output (per side)
  mode: 'cmyk' | 'rgb' | 'gray';
  pdfx: 'none' | 'x4' | 'x3' | 'x1a';
  outputIntent?: { bytes: Uint8Array; name: string; identifier: string };
  title: string;
  author?: string;
  subject?: string;
  keywords?: string;
  bookmarks?: boolean;
  keepLinks: boolean;
  imposition?: Imposition;
  spreads?: boolean; // legacy flag → imposition 'spreads'
  scale?: number; // output scale factor (1 = 100%)
}

const MARK_OFFSET = 3 * MM; // gap between trim and crop mark start (beyond bleed if larger)
const MARK_LEN = 5 * MM;

export function slugFor(o: { cropMarks: boolean; regMarks: boolean; colorBars: boolean }, bleed: number) {
  if (!o.cropMarks && !o.regMarks && !o.colorBars) return 0;
  const off = Math.max(bleed + 1, MARK_OFFSET);
  return off + MARK_LEN + (o.colorBars ? 3 * MM : 1.5 * MM);
}

interface Ctx {
  out: PDFDocument;
  o: ComposeOptions;
  regCS: PDFRef | null;
  embedCache: Map<PageSource, PDFRef>;
}

/** One placed page on a sheet: trim origin (x, y), visible bleed per side. Null source = blank page. */
interface Cell {
  src: PageSource | null;
  x: number;
  y: number;
  w: number;
  h: number;
  bleed: Sides;
}

export async function compose(sources: PageSource[], o: ComposeOptions): Promise<PDFDocument> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const ctx = out.context;
  const regCS =
    o.mode === 'cmyk'
      ? ctx.register(
          ctx.obj([PDFName.of('Separation'), PDFName.of('All'), PDFName.of('DeviceCMYK'), ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 1, 1, 1], N: 1 })]),
        )
      : null;
  const c: Ctx = { out, o, regCS, embedCache: new Map() };
  const imp: Imposition = o.imposition && o.imposition.kind !== 'none' ? o.imposition : o.spreads ? { kind: 'spreads' } : { kind: 'none' };
  const bookmarks: { title: string; page: PDFPage }[] = [];

  if (imp.kind === 'none') {
    for (const s of sources) {
      const page = await sheetFromRow(c, [s], minSides(o.bleed, scaleSides(s.srcBleed, s.scale || 1)), s.scale || 1);
      bookmarks.push({ title: s.name, page });
    }
  } else if (imp.kind === 'spreads' || imp.kind === 'booklet') {
    const rows: (PageSource | null)[][] = [];
    if (imp.kind === 'spreads') {
      rows.push([sources[0]]);
      for (let i = 1; i < sources.length; i += 2) rows.push(sources.slice(i, i + 2));
    } else {
      // saddle stitch: pad to a multiple of 4, then outer/inner pairs per sheet side
      const n = Math.ceil(sources.length / 4) * 4;
      const pages: (PageSource | null)[] = [...sources, ...new Array(n - sources.length).fill(null)];
      for (let sh = 0; sh < n / 4; sh++) {
        const front = [pages[n - 1 - 2 * sh], pages[2 * sh]];
        const back = [pages[2 * sh + 1], pages[n - 2 - 2 * sh]];
        rows.push(imp.rtl ? front.reverse() : front, imp.rtl ? back.reverse() : back);
      }
    }
    let i = 0;
    for (const row of rows) {
      const real = row.filter(Boolean) as PageSource[];
      const b = real.reduce((acc, s) => minSides(acc, scaleSides(s.srcBleed, s.scale || 1)), o.bleed);
      const page = await sheetFromRow(c, row, b, real[0]?.scale || 1);
      const label = imp.kind === 'booklet' ? `第 ${Math.floor(i / 2) + 1} 张 ${i % 2 ? '反面' : '正面'}` : real.map((s) => s.name).join(' + ');
      bookmarks.push({ title: label, page });
      i++;
    }
  } else {
    // n-up / duplex on a press sheet
    const ref = sources[0];
    const cellW = ref.trimW * (ref.scale || 1);
    const cellH = ref.trimH * (ref.scale || 1);
    const margin = 12 * MM;
    const g = imp.gutter;
    const fitCols = Math.max(1, Math.floor((imp.sheetW - 2 * margin + g) / (cellW + g)));
    const fitRows = Math.max(1, Math.floor((imp.sheetH - 2 * margin + g) / (cellH + g)));
    const cols = imp.cols > 0 ? imp.cols : fitCols;
    const rows = imp.rows > 0 ? imp.rows : fitRows;
    const per = cols * rows;
    const gridW = cols * cellW + (cols - 1) * g;
    const gridH = rows * cellH + (rows - 1) * g;
    const x0 = (imp.sheetW - gridW) / 2;
    const y0 = (imp.sheetH - gridH) / 2;
    // bleed between cells limited to half the gutter
    const inner = Math.min(maxSide(o.bleed), g / 2);
    const cellAt = (i: number, mirror: boolean) => {
      const r = Math.floor(i / cols);
      let col = i % cols;
      if (mirror) col = cols - 1 - col;
      return { x: x0 + col * (cellW + g), y: y0 + (rows - 1 - r) * (cellH + g), col, r };
    };
    const sideBleed = (col: number, r: number, s: PageSource): Sides =>
      minSides(
        {
          l: col === 0 ? o.bleed.l : inner,
          r: col === cols - 1 ? o.bleed.r : inner,
          t: r === 0 ? o.bleed.t : inner,
          b: r === rows - 1 ? o.bleed.b : inner,
        },
        scaleSides(s.srcBleed, s.scale || 1),
      );
    const makeSheet = async (items: (PageSource | null)[], mirror: boolean, title: string) => {
      const cells: Cell[] = items.map((s, i) => {
        const p = cellAt(i, mirror);
        return { src: s, x: p.x, y: p.y, w: cellW, h: cellH, bleed: s ? sideBleed(p.col, p.r, s) : uniform(0) };
      });
      const page = await drawSheet(c, imp.sheetW, imp.sheetH, cells, { x: x0, y: y0, w: gridW, h: gridH, cols, rows, cellW, cellH, g });
      bookmarks.push({ title, page });
    };
    if (imp.kind === 'nup') {
      const seq: PageSource[] = [];
      if (imp.repeat) {
        for (const s of sources) {
          const sheets = Math.max(1, Math.ceil(Math.max(1, imp.copies) / per));
          for (let k = 0; k < sheets; k++) await makeSheet(new Array(per).fill(s), false, `${s.name}（${per} 拼）`);
        }
      } else {
        for (const s of sources) for (let k = 0; k < Math.max(1, imp.copies); k++) seq.push(s);
        for (let i = 0; i < seq.length; i += per) await makeSheet(seq.slice(i, i + per), false, `第 ${i / per + 1} 版`);
      }
    } else {
      // duplex: odd pages = fronts, even pages = backs; back sheet mirrored for long-edge flip
      const fronts: PageSource[] = [];
      const backs: (PageSource | null)[] = [];
      for (let i = 0; i < sources.length; i += 2)
        for (let k = 0; k < Math.max(1, imp.copies); k++) {
          fronts.push(sources[i]);
          backs.push(sources[i + 1] || null);
        }
      for (let i = 0; i < fronts.length; i += per) {
        await makeSheet(fronts.slice(i, i + per), false, `第 ${i / per + 1} 版 正面`);
        await makeSheet(backs.slice(i, i + per), true, `第 ${i / per + 1} 版 反面`);
      }
    }
  }

  // ---- metadata ----
  const now = new Date();
  out.setTitle(o.title, { showInWindowTitleBar: true });
  if (o.author) out.setAuthor(o.author);
  if (o.subject) out.setSubject(o.subject);
  if (o.keywords) out.setKeywords(o.keywords.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
  out.setCreator('Inkpaper for Figma');
  out.setProducer('Inkpaper for Figma (pdf-lib)');
  out.setCreationDate(now);
  out.setModificationDate(now);
  const id = randomHex(16);
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);

  if (o.bookmarks && bookmarks.length > 1) addBookmarks(out, bookmarks);

  if (o.pdfx !== 'none' && o.outputIntent && o.mode !== 'rgb') {
    // ISO 15930 requires exactly one of TrimBox and ArtBox, never both.
    for (const page of out.getPages()) page.node.delete(PDFName.of('ArtBox'));
    const info = ctx.lookup(ctx.trailerInfo.Info) as PDFDict;
    info.set(PDFName.of('Trapped'), PDFName.of('False'));
    if (o.pdfx === 'x4') {
      ctx.header = PDFHeader.forVersion(1, 6);
      info.set(PDFName.of('GTS_PDFXVersion'), PDFString.of('PDF/X-4'));
    } else {
      // PDF/X-1a:2001 and PDF/X-3:2002 are based on PDF 1.3: no transparency, no XMP needed
      ctx.header = PDFHeader.forVersion(1, 3);
      info.set(PDFName.of('GTS_PDFXVersion'), PDFString.of(o.pdfx === 'x1a' ? 'PDF/X-1:2001' : 'PDF/X-3:2002'));
      if (o.pdfx === 'x1a') info.set(PDFName.of('GTS_PDFXConformance'), PDFString.of('PDF/X-1a:2001'));
      for (const p of out.getPages()) p.node.delete(PDFName.of('Group'));
    }
    const icc = ctx.flateStream(o.outputIntent.bytes, { N: o.mode === 'gray' ? 1 : 4 });
    const oi = ctx.obj({
      Type: 'OutputIntent',
      S: 'GTS_PDFX',
      OutputConditionIdentifier: PDFString.of(o.outputIntent.identifier),
      OutputCondition: PDFString.of(o.outputIntent.name),
      Info: PDFString.of(o.outputIntent.name),
      RegistryName: PDFString.of('http://www.color.org'),
      DestOutputProfile: ctx.register(icc),
    });
    out.catalog.set(PDFName.of('OutputIntents'), ctx.obj([ctx.register(oi)]));
    if (o.pdfx === 'x4') {
      const xmp = xmpPacket({ title: o.title, author: o.author, subject: o.subject, keywords: o.keywords, date: now, id });
      out.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream(utf8(xmp), { Type: 'Metadata', Subtype: 'XML' })));
    }
  }
  return out;
}

async function embedRef(c: Ctx, s: PageSource): Promise<PDFRef> {
  let r = c.embedCache.get(s);
  if (!r) {
    const [emb] = await c.out.embedPdf(s.doc, [0]);
    r = emb.ref;
    c.embedCache.set(s, r);
  }
  return r;
}

/** A sheet holding one page or a horizontal row of pages (spreads / booklet), with marks around it.
 *  `b` is the visible bleed in output points; `k` the design → output scale of the pages. */
async function sheetFromRow(c: Ctx, row: (PageSource | null)[], b: Sides, k: number): Promise<PDFPage> {
  const real = row.filter(Boolean) as PageSource[];
  const trimW = row.reduce((a, s) => a + (s ? s.trimW : real[0].trimW), 0) * k;
  const trimH = Math.max(...real.map((s) => s.trimH)) * k;
  const slug = slugFor(c.o, maxSide(b));
  const W = trimW + b.l + b.r + 2 * slug;
  const H = trimH + b.t + b.b + 2 * slug;
  const tx = slug + b.l;
  const ty = slug + b.b;
  const cells: Cell[] = [];
  let ox = 0;
  row.forEach((s, i) => {
    const w = (s ? s.trimW : real[0].trimW) * k;
    const bl = row.length === 1 || i === 0 ? b.l : 0;
    const br = row.length === 1 || i === row.length - 1 ? b.r : 0;
    cells.push({ src: s, x: tx + ox, y: ty + (trimH - (s ? s.trimH * k : trimH)), w, h: s ? s.trimH * k : trimH, bleed: { l: bl, r: br, t: b.t, b: b.b } });
    ox += w;
  });
  const page = await drawSheet(c, W, H, cells, null);
  page.setBleedBox(tx - b.l, ty - b.b, trimW + b.l + b.r, trimH + b.t + b.b);
  page.setTrimBox(tx, ty, trimW, trimH);
  page.setArtBox(tx, ty, trimW, trimH);
  // printer's marks around the whole row
  const m: string[] = [];
  marks(c, m, { x: tx, y: ty, w: trimW, h: trimH }, maxSide(b), cells.slice(0, -1).map((cl) => cl.x + cl.w));
  appendContent(c, page, m);
  return page;
}

interface Grid {
  x: number;
  y: number;
  w: number;
  h: number;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  g: number;
}

/** Draw a sheet of placed pages. `grid` (n-up) adds crop marks on every cell edge outside the grid. */
async function drawSheet(c: Ctx, W: number, H: number, cells: Cell[], grid: Grid | null): Promise<PDFPage> {
  const { out, o } = c;
  const ctx = out.context;
  const scale = o.scale && o.scale > 0 ? o.scale : 1;
  const page = out.addPage([W * scale, H * scale]);
  page.setMediaBox(0, 0, W * scale, H * scale);
  const res = ctx.obj({}) as PDFDict;
  const xo = ctx.obj({}) as PDFDict;
  res.set(PDFName.of('XObject'), xo);
  if (c.regCS) res.set(PDFName.of('ColorSpace'), ctx.obj({ Reg: c.regCS }));
  const lines: string[] = [];
  if (scale !== 1) lines.push(`${fmt(scale)} 0 0 ${fmt(scale)} 0 0 cm`);
  const annots: PDFRef[] = [];
  let n = 0;
  for (const cell of cells) {
    if (!cell.src) continue;
    const s = cell.src;
    const ref = await embedRef(c, s);
    const name = 'Pg' + n++;
    xo.set(PDFName.of(name), ref);
    const sk = s.scale || 1;
    lines.push('q');
    lines.push(`${fmt(cell.x - cell.bleed.l)} ${fmt(cell.y - cell.bleed.b)} ${fmt(cell.w + cell.bleed.l + cell.bleed.r)} ${fmt(cell.h + cell.bleed.t + cell.bleed.b)} re W n`);
    lines.push(`${fmt(sk)} 0 0 ${fmt(sk)} ${fmt(cell.x - s.srcBleed.l * sk)} ${fmt(cell.y - s.srcBleed.b * sk)} cm`);
    lines.push(`/${name} Do`);
    lines.push('Q');
    if (o.keepLinks && o.pdfx === 'none') annots.push(...copyLinks(s, out, cell.x - s.srcBleed.l * sk, cell.y - s.srcBleed.b * sk, sk, scale));
  }
  if (grid) {
    // crop marks for every column / row edge, drawn outside the grid only
    const m: string[] = [];
    const off = MARK_OFFSET;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < grid.cols; i++) xs.push(grid.x + i * (grid.cellW + grid.g), grid.x + i * (grid.cellW + grid.g) + grid.cellW);
    for (let i = 0; i < grid.rows; i++) ys.push(grid.y + i * (grid.cellH + grid.g), grid.y + i * (grid.cellH + grid.g) + grid.cellH);
    if (o.cropMarks) {
      m.push('q', setReg(c, false), `${fmt(o.markWeight)} w 0 J`);
      for (const x of xs) {
        m.push(`${fmt(x)} ${fmt(grid.y - off)} m ${fmt(x)} ${fmt(grid.y - off - MARK_LEN)} l S`);
        m.push(`${fmt(x)} ${fmt(grid.y + grid.h + off)} m ${fmt(x)} ${fmt(grid.y + grid.h + off + MARK_LEN)} l S`);
      }
      for (const y of ys) {
        m.push(`${fmt(grid.x - off)} ${fmt(y)} m ${fmt(grid.x - off - MARK_LEN)} ${fmt(y)} l S`);
        m.push(`${fmt(grid.x + grid.w + off)} ${fmt(y)} m ${fmt(grid.x + grid.w + off + MARK_LEN)} ${fmt(y)} l S`);
      }
      m.push('Q');
    }
    if (o.trimLine) {
      m.push('q', setReg(c, false), `${fmt(o.markWeight)} w`);
      for (const cl of cells) if (cl.src) m.push(`${fmt(cl.x)} ${fmt(cl.y)} ${fmt(cl.w)} ${fmt(cl.h)} re S`);
      m.push('Q');
    }
    marks(c, m, { x: grid.x, y: grid.y, w: grid.w, h: grid.h }, 0, [], true);
    lines.push(...m);
    page.setTrimBox(0, 0, W * scale, H * scale);
    page.setBleedBox(0, 0, W * scale, H * scale);
  }
  const content = ctx.flateStream(latin1ToBytes(lines.join('\n') + '\n'));
  page.node.set(PDFName.of('Contents'), ctx.register(content));
  page.node.set(PDFName.of('Resources'), res);
  if (o.mode !== 'rgb') page.node.set(PDFName.of('Group'), ctx.obj({ Type: 'Group', S: 'Transparency', CS: o.mode === 'gray' ? 'DeviceGray' : 'DeviceCMYK', I: false, K: false }));
  if (annots.length) page.node.set(PDFName.of('Annots'), ctx.obj(annots));
  // remember the drawing scale so boxes set later can be scaled too
  (page as any).__pkScale = scale;
  return page;
}

function setReg(c: Ctx, fill: boolean) {
  return c.regCS ? `/Reg ${fill ? 'cs' : 'CS'} 1 ${fill ? 'scn' : 'SCN'}` : c.o.mode === 'gray' ? `0 ${fill ? 'g' : 'G'}` : `0 0 0 ${fill ? 'rg' : 'RG'}`;
}

/** Crop marks (unless skipCrop), spine marks, registration targets, colour bars and trim line around a trim rect. */
function marks(c: Ctx, m: string[], t: { x: number; y: number; w: number; h: number }, bleed: number, spines: number[], skipCrop = false) {
  const o = c.o;
  const off = Math.max(bleed + 1, MARK_OFFSET);
  const seg = (ax: number, ay: number, bx: number, by: number) => m.push(`${fmt(ax)} ${fmt(ay)} m ${fmt(bx)} ${fmt(by)} l S`);
  if (o.cropMarks && !skipCrop) {
    m.push('q', setReg(c, false), `${fmt(o.markWeight)} w 0 J`);
    const x0 = t.x, x1 = t.x + t.w, y0 = t.y, y1 = t.y + t.h;
    for (const [x, sx] of [[x0, -1], [x1, 1]] as const)
      for (const [y, sy] of [[y0, -1], [y1, 1]] as const) {
        seg(x + sx * off, y, x + sx * (off + MARK_LEN), y);
        seg(x, y + sy * off, x, y + sy * (off + MARK_LEN));
      }
    for (const sx of spines) {
      seg(sx, y0 - off, sx, y0 - off - MARK_LEN);
      seg(sx, y1 + off, sx, y1 + off + MARK_LEN);
    }
    m.push('Q');
  }
  if (o.trimLine && !skipCrop) m.push('q', setReg(c, false), `${fmt(o.markWeight)} w ${fmt(t.x)} ${fmt(t.y)} ${fmt(t.w)} ${fmt(t.h)} re S`, 'Q');
  if (o.regMarks) {
    const roff = off + MARK_LEN / 2;
    const r = 2.2 * MM;
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    const targets: [number, number][] = [[cx, t.y - roff], [cx, t.y + t.h + roff], [t.x - roff, cy], [t.x + t.w + roff, cy]];
    m.push('q', setReg(c, false), `${fmt(o.markWeight)} w`);
    for (const [x, y] of targets) {
      m.push(circle(x, y, r * 0.75) + ' S');
      m.push(`${fmt(x - r)} ${fmt(y)} m ${fmt(x + r)} ${fmt(y)} l S ${fmt(x)} ${fmt(y - r)} m ${fmt(x)} ${fmt(y + r)} l S`);
      m.push(setReg(c, true), circle(x, y, r * 0.35) + ' f');
    }
    m.push('Q');
  }
  if (o.colorBars && o.mode !== 'rgb') {
    const sz = 4 * MM;
    let x = t.x + 12 * MM;
    const y = t.y + t.h + off + 1;
    const patches: number[][] =
      o.mode === 'gray'
        ? [[0.25], [0.5], [0.75], [1]]
        : [
            [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
            [1, 1, 0, 0], [1, 0, 1, 0], [0, 1, 1, 0], [1, 1, 1, 0],
            [0, 0, 0, 0.25], [0, 0, 0, 0.5], [0, 0, 0, 0.75],
            [0.5, 0, 0, 0], [0, 0.5, 0, 0], [0, 0, 0.5, 0],
          ];
    m.push('q');
    for (const p of patches) {
      if (x + sz > t.x + t.w - 12 * MM) break;
      m.push(`${p.map(fmt).join(' ')} ${p.length === 1 ? 'g' : 'k'} ${fmt(x)} ${fmt(y)} ${fmt(sz)} ${fmt(sz)} re f`);
      x += sz;
    }
    m.push('Q');
  }
}

function appendContent(c: Ctx, page: PDFPage, lines: string[]) {
  if (!lines.length) return;
  const ctx = c.out.context;
  const scale = (page as any).__pkScale || 1;
  const body = (scale !== 1 ? `q ${fmt(scale)} 0 0 ${fmt(scale)} 0 0 cm\n` : 'q\n') + lines.join('\n') + '\nQ\n';
  const extra = ctx.register(ctx.flateStream(latin1ToBytes(body)));
  const cur = page.node.get(PDFName.of('Contents'));
  page.node.set(PDFName.of('Contents'), ctx.obj(cur instanceof PDFArray ? [...cur.asArray(), extra] : [cur!, extra]));
  if (scale !== 1) {
    // boxes were set in unscaled units by the caller
    for (const box of ['BleedBox', 'TrimBox', 'ArtBox']) {
      const arr = page.node.get(PDFName.of(box));
      if (arr instanceof PDFArray) page.node.set(PDFName.of(box), ctx.obj(arr.asArray().map((v) => (v as PDFNumber).asNumber() * scale)));
    }
  }
}

function addBookmarks(out: PDFDocument, items: { title: string; page: PDFPage }[]) {
  const ctx = out.context;
  const outlinesRef = ctx.nextRef();
  const refs = items.map(() => ctx.nextRef());
  items.forEach((it, i) => {
    const d: Record<string, any> = {
      Title: PDFHexString.fromText(it.title),
      Parent: outlinesRef,
      Dest: [it.page.ref, PDFName.of('Fit')],
    };
    if (i > 0) d.Prev = refs[i - 1];
    if (i < items.length - 1) d.Next = refs[i + 1];
    ctx.assign(refs[i], ctx.obj(d));
  });
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: items.length }));
  out.catalog.set(PDFName.of('Outlines'), outlinesRef);
  out.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

/** Copy URI link annotations from a source page, offset (dx, dy) and scaled by k, then page scale. */
function copyLinks(src: PageSource, out: PDFDocument, dx: number, dy: number, k: number, pageScale: number): PDFRef[] {
  const ctx = out.context;
  const sctx = src.doc.context;
  const annots = sctx.lookup(src.doc.getPage(0).node.get(PDFName.of('Annots')));
  const list: PDFRef[] = [];
  if (!(annots instanceof PDFArray)) return list;
  for (const a of annots.asArray()) {
    const ad = lookupDict(sctx, a);
    if (!ad || ad.get(PDFName.of('Subtype'))?.toString() !== '/Link') continue;
    const act = lookupDict(sctx, ad.get(PDFName.of('A')));
    const uri = act && sctx.lookup(act.get(PDFName.of('URI')));
    if (!(uri instanceof PDFString || uri instanceof PDFHexString)) continue;
    const r = (sctx.lookup(ad.get(PDFName.of('Rect'))) as PDFArray).asArray().map((v) => (sctx.lookup(v) as PDFNumber).asNumber());
    const p = (x: number, y: number) => [(x * k + dx) * pageScale, (y * k + dy) * pageScale];
    const [x1, y1] = p(r[0], r[1]);
    const [x2, y2] = p(r[2], r[3]);
    list.push(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x1, y1, x2, y2], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(uri.decodeText()) } })));
  }
  return list;
}

function circle(x: number, y: number, r: number) {
  const k = 0.5523 * r;
  const p = (a: number, b: number) => `${fmt(a)} ${fmt(b)}`;
  return [
    `${p(x + r, y)} m`,
    `${p(x + r, y + k)} ${p(x + k, y + r)} ${p(x, y + r)} c`,
    `${p(x - k, y + r)} ${p(x - r, y + k)} ${p(x - r, y)} c`,
    `${p(x - r, y - k)} ${p(x - k, y - r)} ${p(x, y - r)} c`,
    `${p(x + k, y - r)} ${p(x + r, y - k)} ${p(x + r, y)} c`,
  ].join(' ');
}

function randomHex(n: number) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return s;
}

function isoDate(d: Date) {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

function xmlEsc(s: string) {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

function xmpPacket(a: { title: string; author?: string; subject?: string; keywords?: string; date: Date; id: string }) {
  const d = isoDate(a.date);
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(a.title)}</rdf:li></rdf:Alt></dc:title>${
     a.author ? `\n   <dc:creator><rdf:Seq><rdf:li>${xmlEsc(a.author)}</rdf:li></rdf:Seq></dc:creator>` : ''
   }${a.subject ? `\n   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(a.subject)}</rdf:li></rdf:Alt></dc:description>` : ''}${
     a.keywords ? `\n   <pdf:Keywords>${xmlEsc(a.keywords.split(/[,，]/).map((s) => s.trim()).filter(Boolean).join(' '))}</pdf:Keywords>` : ''
   }
   <xmp:CreateDate>${d}</xmp:CreateDate>
   <xmp:ModifyDate>${d}</xmp:ModifyDate>
   <xmp:MetadataDate>${d}</xmp:MetadataDate>
   <xmp:CreatorTool>Inkpaper for Figma</xmp:CreatorTool>
   <pdf:Producer>Inkpaper for Figma (pdf-lib)</pdf:Producer>
   <pdf:Trapped>False</pdf:Trapped>
   <xmpMM:DocumentID>uuid:${a.id}</xmpMM:DocumentID>
   <xmpMM:InstanceID>uuid:${a.id}</xmpMM:InstanceID>
   <xmpMM:VersionID>1</xmpMM:VersionID>
   <xmpMM:RenditionClass>default</xmpMM:RenditionClass>
   <pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

export function utf8(s: string) {
  return new TextEncoder().encode(s);
}

export { PDFRawStream };
