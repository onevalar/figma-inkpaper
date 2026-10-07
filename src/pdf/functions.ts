// Evaluate PDF functions (types 0, 2, 3, 4) so gradients can be resampled into the output colour space.

import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFObject, PDFRawStream, PDFStream } from 'pdf-lib';
import { decodeStream } from './streams';
import { bytesToLatin1 } from './lexer';

export type Fn = (inp: number[]) => number[];

const nums = (ctx: PDFContext, o: PDFObject | undefined): number[] | undefined => {
  const a = o ? ctx.lookup(o) : undefined;
  if (!(a instanceof PDFArray)) return undefined;
  return a.asArray().map((x) => (ctx.lookup(x) as PDFNumber).asNumber());
};

export function buildFunction(ctx: PDFContext, obj: PDFObject): Fn {
  const o = ctx.lookup(obj);
  if (o instanceof PDFArray) {
    // array of 1-out functions → concat outputs
    const fns = o.asArray().map((x) => buildFunction(ctx, x));
    return (inp) => fns.flatMap((f) => f(inp));
  }
  const dict = o instanceof PDFDict ? o : (o as PDFRawStream).dict;
  const type = (ctx.lookup(dict.get(PDFName.of('FunctionType'))) as PDFNumber).asNumber();
  const domain = nums(ctx, dict.get(PDFName.of('Domain'))) || [0, 1];
  const range = nums(ctx, dict.get(PDFName.of('Range')));
  const clipIn = (inp: number[]) => inp.map((x, i) => Math.min(domain[i * 2 + 1], Math.max(domain[i * 2], x)));
  const clipOut = (out: number[]) =>
    range ? out.map((x, i) => Math.min(range[i * 2 + 1], Math.max(range[i * 2], x))) : out;

  if (type === 2) {
    const c0 = nums(ctx, dict.get(PDFName.of('C0'))) || [0];
    const c1 = nums(ctx, dict.get(PDFName.of('C1'))) || [1];
    const N = (ctx.lookup(dict.get(PDFName.of('N'))) as PDFNumber).asNumber();
    return (inp) => {
      const x = clipIn(inp)[0];
      const p = Math.pow(x, N);
      return clipOut(c0.map((a, i) => a + p * (c1[i] - a)));
    };
  }
  if (type === 3) {
    const fns = (ctx.lookup(dict.get(PDFName.of('Functions'))) as PDFArray).asArray().map((f) => buildFunction(ctx, f));
    const bounds = nums(ctx, dict.get(PDFName.of('Bounds'))) || [];
    const encode = nums(ctx, dict.get(PDFName.of('Encode'))) || [];
    return (inp) => {
      const x = clipIn(inp)[0];
      let k = 0;
      while (k < bounds.length && x >= bounds[k]) k++;
      const lo = k === 0 ? domain[0] : bounds[k - 1];
      const hi = k === bounds.length ? domain[1] : bounds[k];
      const e0 = encode[k * 2] ?? 0;
      const e1 = encode[k * 2 + 1] ?? 1;
      const t = hi === lo ? e0 : e0 + ((x - lo) * (e1 - e0)) / (hi - lo);
      return clipOut(fns[k](([t])));
    };
  }
  if (type === 0) {
    const stream = o as PDFRawStream;
    const data = decodeStream(ctx, stream);
    const size = nums(ctx, dict.get(PDFName.of('Size')))!;
    const bps = (ctx.lookup(dict.get(PDFName.of('BitsPerSample'))) as PDFNumber).asNumber();
    const m = size.length;
    const encode = nums(ctx, dict.get(PDFName.of('Encode'))) || size.flatMap((s) => [0, s - 1]);
    const decode = nums(ctx, dict.get(PDFName.of('Decode'))) || range!;
    const nOut = range!.length / 2;
    const maxv = Math.pow(2, bps) - 1;
    const sample = (idx: number[]): number[] => {
      let off = 0;
      let mul = 1;
      for (let i = 0; i < m; i++) {
        off += idx[i] * mul;
        mul *= size[i];
      }
      const out: number[] = [];
      for (let j = 0; j < nOut; j++) {
        const bit = (off * nOut + j) * bps;
        let v = 0;
        for (let b = 0; b < bps; b++) {
          const bi = bit + b;
          v = (v << 1) | ((data[bi >> 3] >> (7 - (bi & 7))) & 1);
        }
        out.push(decode[j * 2] + (v / maxv) * (decode[j * 2 + 1] - decode[j * 2]));
      }
      return out;
    };
    return (inp) => {
      const x = clipIn(inp);
      // multilinear interpolation
      const e = x.map((xi, i) => {
        const d0 = domain[i * 2];
        const d1 = domain[i * 2 + 1];
        const v = encode[i * 2] + ((xi - d0) * (encode[i * 2 + 1] - encode[i * 2])) / (d1 - d0 || 1);
        return Math.min(size[i] - 1, Math.max(0, v));
      });
      const base = e.map(Math.floor);
      const frac = e.map((v, i) => v - base[i]);
      const out = new Array(nOut).fill(0);
      for (let corner = 0; corner < 1 << m; corner++) {
        let w = 1;
        const idx: number[] = [];
        for (let i = 0; i < m; i++) {
          const hiSide = (corner >> i) & 1;
          const ii = Math.min(size[i] - 1, base[i] + hiSide);
          idx.push(ii);
          w *= hiSide ? frac[i] : 1 - frac[i];
        }
        if (w === 0) continue;
        const s = sample(idx);
        for (let j = 0; j < nOut; j++) out[j] += w * s[j];
      }
      return clipOut(out);
    };
  }
  if (type === 4) {
    const code = bytesToLatin1(decodeStream(ctx, o as PDFRawStream));
    const prog = compilePS(code);
    return (inp) => clipOut(runPS(prog, clipIn(inp)).slice(-(range!.length / 2)));
  }
  throw new Error('Unsupported function type ' + type);
}

// ---- PostScript calculator (type 4) ----
type PSNode = number | boolean | string | { if: PSNode[]; else?: PSNode[] };

function compilePS(src: string): PSNode[] {
  const toks = src.replace(/[{}]/g, (m) => ` ${m} `).split(/\s+/).filter(Boolean);
  let i = 0;
  const parseBlock = (): PSNode[] => {
    const out: PSNode[] = [];
    while (i < toks.length) {
      const t = toks[i++];
      if (t === '{') {
        const b1 = parseBlock();
        // look ahead for if / ifelse pattern
        if (toks[i] === '{') {
          i++;
          const b2 = parseBlock();
          if (toks[i] === 'ifelse') {
            i++;
            out.push({ if: b1, else: b2 });
          }
        } else if (toks[i] === 'if') {
          i++;
          out.push({ if: b1 });
        } else out.push(...b1); // outer program braces
      } else if (t === '}') return out;
      else if (t === 'true' || t === 'false') out.push(t === 'true');
      else if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) out.push(parseFloat(t));
      else out.push(t);
    }
    return out;
  };
  return parseBlock();
}

function runPS(prog: PSNode[], input: number[]): number[] {
  const st: any[] = [...input];
  const exec = (p: PSNode[]) => {
    for (const n of p) {
      if (typeof n === 'number' || typeof n === 'boolean') {
        st.push(n);
        continue;
      }
      if (typeof n === 'object') {
        const c = st.pop();
        if (c) exec(n.if);
        else if (n.else) exec(n.else);
        continue;
      }
      const b = () => st.pop();
      switch (n) {
        case 'add': { const y = b(), x = b(); st.push(x + y); break; }
        case 'sub': { const y = b(), x = b(); st.push(x - y); break; }
        case 'mul': { const y = b(), x = b(); st.push(x * y); break; }
        case 'div': { const y = b(), x = b(); st.push(y === 0 ? 0 : x / y); break; }
        case 'idiv': { const y = b(), x = b(); st.push(y === 0 ? 0 : Math.trunc(x / y)); break; }
        case 'mod': { const y = b(), x = b(); st.push(y === 0 ? 0 : x % y); break; }
        case 'neg': st.push(-b()); break;
        case 'abs': st.push(Math.abs(b())); break;
        case 'ceiling': st.push(Math.ceil(b())); break;
        case 'floor': st.push(Math.floor(b())); break;
        case 'round': st.push(Math.round(b())); break;
        case 'truncate': st.push(Math.trunc(b())); break;
        case 'sqrt': st.push(Math.sqrt(Math.max(0, b()))); break;
        case 'sin': st.push(Math.sin((b() * Math.PI) / 180)); break;
        case 'cos': st.push(Math.cos((b() * Math.PI) / 180)); break;
        case 'atan': { const y = b(), x = b(); let a = (Math.atan2(x, y) * 180) / Math.PI; if (a < 0) a += 360; st.push(a); break; }
        case 'exp': { const y = b(), x = b(); st.push(Math.pow(x, y)); break; }
        case 'ln': st.push(Math.log(b())); break;
        case 'log': st.push(Math.log10(b())); break;
        case 'cvi': st.push(Math.trunc(b())); break;
        case 'cvr': break;
        case 'dup': st.push(st[st.length - 1]); break;
        case 'pop': b(); break;
        case 'exch': { const y = b(), x = b(); st.push(y, x); break; }
        case 'copy': { const k = b(); st.push(...st.slice(st.length - k)); break; }
        case 'index': { const k = b(); st.push(st[st.length - 1 - k]); break; }
        case 'roll': {
          const j = b(), k = b();
          if (k > 0) {
            const part = st.splice(st.length - k, k);
            const s = ((j % k) + k) % k;
            st.push(...part.slice(k - s), ...part.slice(0, k - s));
          }
          break;
        }
        case 'eq': { const y = b(), x = b(); st.push(x === y); break; }
        case 'ne': { const y = b(), x = b(); st.push(x !== y); break; }
        case 'gt': { const y = b(), x = b(); st.push(x > y); break; }
        case 'ge': { const y = b(), x = b(); st.push(x >= y); break; }
        case 'lt': { const y = b(), x = b(); st.push(x < y); break; }
        case 'le': { const y = b(), x = b(); st.push(x <= y); break; }
        case 'and': { const y = b(), x = b(); st.push(typeof x === 'boolean' ? x && y : x & y); break; }
        case 'or': { const y = b(), x = b(); st.push(typeof x === 'boolean' ? x || y : x | y); break; }
        case 'xor': { const y = b(), x = b(); st.push(typeof x === 'boolean' ? x !== y : x ^ y); break; }
        case 'not': { const x = b(); st.push(typeof x === 'boolean' ? !x : ~x); break; }
        case 'bitshift': { const s = b(), x = b(); st.push(s >= 0 ? x << s : x >> -s); break; }
        default: break;
      }
    }
  };
  exec(prog);
  return st.map(Number);
}

/** Build a sampled (type 0) function stream from a JS function — 1 or 2 inputs. */
export function makeSampledFunction(
  ctx: PDFContext,
  fn: Fn,
  domain: number[],
  nOut: number,
  samplesPerDim: number,
): PDFStream {
  const m = domain.length / 2;
  const size = new Array(m).fill(samplesPerDim);
  const total = Math.pow(samplesPerDim, m);
  const data = new Uint8Array(total * nOut);
  for (let idx = 0; idx < total; idx++) {
    const inp: number[] = [];
    let rem = idx;
    for (let i = 0; i < m; i++) {
      const k = rem % samplesPerDim;
      rem = Math.floor(rem / samplesPerDim);
      inp.push(domain[i * 2] + (k / (samplesPerDim - 1)) * (domain[i * 2 + 1] - domain[i * 2]));
    }
    const out = fn(inp);
    for (let j = 0; j < nOut; j++) data[idx * nOut + j] = Math.round(Math.max(0, Math.min(1, out[j])) * 255);
  }
  const range: number[] = [];
  for (let j = 0; j < nOut; j++) range.push(0, 1);
  return ctx.flateStream(data, {
    FunctionType: 0,
    Domain: domain,
    Range: range,
    Size: size,
    BitsPerSample: 8,
  });
}
