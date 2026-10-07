// Content-stream tokenizer / serializer.
// Every token keeps its raw source text so untouched operations are written back byte-exact.

export type TokType = 'num' | 'name' | 'str' | 'arr' | 'dict' | 'bool' | 'null' | 'op';

export interface Tok {
  t: TokType;
  raw: string; // latin1 source text
  v?: number | string | boolean;
}

export interface Op {
  op: string; // operator, or '' for trailing operands / inline image block
  args: Tok[];
  raw?: string; // verbatim text (inline images)
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

export function bytesToLatin1(b: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + CH)));
  }
  return s;
}

export function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function parseContent(src: string): Op[] {
  const ops: Op[] = [];
  let args: Tok[] = [];
  let i = 0;
  const n = src.length;

  const skipWs = () => {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (WS.has(c)) i++;
      else if (c === 0x25) {
        // comment
        while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      } else break;
    }
  };

  const readLiteralString = (): string => {
    const start = i;
    let depth = 0;
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    return src.slice(start, i);
  };

  const readToken = (): Tok | null => {
    skipWs();
    if (i >= n) return null;
    const c = src[i];
    const start = i;
    if (c === '(') return { t: 'str', raw: readLiteralString() };
    if (c === '<') {
      if (src[i + 1] === '<') {
        // dictionary (inline, e.g. BDC properties) — capture balanced raw text
        let depth = 0;
        while (i < n) {
          if (src[i] === '<' && src[i + 1] === '<') {
            depth++;
            i += 2;
          } else if (src[i] === '>' && src[i + 1] === '>') {
            depth--;
            i += 2;
            if (depth === 0) break;
          } else if (src[i] === '(') readLiteralString();
          else i++;
        }
        return { t: 'dict', raw: src.slice(start, i) };
      }
      const e = src.indexOf('>', i);
      i = e < 0 ? n : e + 1;
      return { t: 'str', raw: src.slice(start, i) };
    }
    if (c === '[') {
      let depth = 0;
      while (i < n) {
        const ch = src[i];
        if (ch === '(') {
          readLiteralString();
          continue;
        }
        if (ch === '[') depth++;
        else if (ch === ']') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
      return { t: 'arr', raw: src.slice(start, i) };
    }
    if (c === '/') {
      i++;
      while (i < n && !WS.has(src.charCodeAt(i)) && !DELIM.has(src.charCodeAt(i))) i++;
      return { t: 'name', raw: src.slice(start, i), v: src.slice(start + 1, i) };
    }
    // regular token
    while (i < n && !WS.has(src.charCodeAt(i)) && !DELIM.has(src.charCodeAt(i))) i++;
    if (i === start) {
      // stray delimiter like ')' '>' ']' — consume to avoid infinite loop
      i++;
      return { t: 'op', raw: src.slice(start, i), v: src.slice(start, i) };
    }
    const raw = src.slice(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) return { t: 'num', raw, v: parseFloat(raw) };
    if (raw === 'true' || raw === 'false') return { t: 'bool', raw, v: raw === 'true' };
    if (raw === 'null') return { t: 'null', raw };
    return { t: 'op', raw, v: raw };
  };

  while (true) {
    const tok = readToken();
    if (!tok) break;
    if (tok.t !== 'op') {
      args.push(tok);
      continue;
    }
    const op = tok.raw;
    if (op === 'BI') {
      // inline image: BI <dict pairs> ID <binary> EI
      const start = i - 2;
      const idIdx = findInlineDataStart(src, i);
      const eiIdx = findEI(src, idIdx);
      i = eiIdx + 2;
      ops.push({ op: 'BI', args: [], raw: src.slice(start, i) });
      args = [];
      continue;
    }
    ops.push({ op, args });
    args = [];
  }
  if (args.length) ops.push({ op: '', args });
  return ops;
}

function findInlineDataStart(src: string, from: number): number {
  const re = /\sID[\s]/g;
  re.lastIndex = from - 1;
  const m = re.exec(src);
  return m ? m.index + 4 : src.length;
}

function findEI(src: string, from: number): number {
  let j = from;
  while (j < src.length) {
    const k = src.indexOf('EI', j);
    if (k < 0) return src.length - 2;
    const before = src.charCodeAt(k - 1);
    const after = k + 2 >= src.length ? 0x20 : src.charCodeAt(k + 2);
    if (WS.has(before) && (WS.has(after) || after === undefined)) return k;
    j = k + 2;
  }
  return src.length - 2;
}

export function serialize(ops: Op[]): string {
  const parts: string[] = [];
  for (const o of ops) {
    if (o.raw !== undefined) {
      parts.push(o.raw);
      continue;
    }
    const a = o.args.map((t) => t.raw).join(' ');
    parts.push(o.op ? (a ? a + ' ' + o.op : o.op) : a);
  }
  return parts.join('\n') + '\n';
}

export const num = (v: number): Tok => ({ t: 'num', raw: fmt(v), v });
export const name = (v: string): Tok => ({ t: 'name', raw: '/' + v, v });

export function fmt(v: number): string {
  if (!isFinite(v)) return '0';
  const r = Math.round(v * 10000) / 10000;
  let s = r.toFixed(4);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

export function mkOp(op: string, ...args: Tok[]): Op {
  return { op, args };
}
