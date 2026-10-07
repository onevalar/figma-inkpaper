// Interface translation. Source strings are the Simplified Chinese UI text; every rendered text node,
// placeholder and tooltip is looked up here. Keys may contain {0}…{9} for dynamic values.

import { DICT, LANGS, COL, Lang } from './dict';
import { ZH_TW } from './zh-tw.generated';

export { LANGS };
export type { Lang };

let lang: Lang = 'zh-CN';
const exact = new Map<string, string>();
let patterns: { re: RegExp; out: string }[] = [];
export const missing = new Set<string>(); // source strings without a translation (dev aid)

const CJK = /[㐀-鿿]/;

export function detectLang(): Lang {
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN';
  const l = nav.toLowerCase();
  if (l.startsWith('zh')) return /tw|hk|mo|hant/.test(l) ? 'zh-TW' : 'zh-CN';
  for (const code of ['en', 'ja', 'ko', 'es', 'de', 'fr'] as Lang[]) if (l.startsWith(code)) return code;
  return 'en';
}

export function getLang() {
  return lang;
}

export function setLang(l: Lang) {
  lang = l;
  exact.clear();
  patterns = [];
  missing.clear();
  if (l === 'zh-CN') return;
  const col = COL[l];
  for (const row of DICT) {
    const src = row[0].trim();
    const raw = l === 'zh-TW' ? ZH_TW[row[0]] : col !== undefined ? row[col] : undefined;
    if (!raw) continue;
    const out = raw.trim();
    if (/\{#?\d\}/.test(src)) {
      // {n} = any text, {#n} = a number
      const re = new RegExp(
        '^' +
          src
            .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
            .replace(/\{#(\d)\}/g, '(?<g$1>[\\d.,]+)')
            .replace(/\{(\d)\}/g, '(?<g$1>[\\s\\S]+?)') +
          '$',
      );
      patterns.push({ re, out });
    } else exact.set(src, out);
  }
  // longer (more specific) patterns first
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);
}

/** Translate one string (exact match, then patterns; captured values are translated recursively). */
export function tr(s: string, track = true): string {
  if (lang === 'zh-CN' || !s || !CJK.test(s)) return s;
  const key = s.trim();
  const hit = exact.get(key);
  if (hit !== undefined) return s.replace(key, hit);
  for (const p of patterns) {
    const m = p.re.exec(key);
    if (m) {
      const out = p.out.replace(/\{#?(\d)\}/g, (_, i) => {
        const v = m.groups?.['g' + i] ?? '';
        return tr(v, false); // captured values are often user content
      });
      return s.replace(key, out);
    }
  }
  if (track) missing.add(key);
  return s;
}

/** Translate all text nodes and user-facing attributes under `root`. */
export function translateDom(root: Node) {
  if (lang === 'zh-CN') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const t of nodes) {
    if (t.parentElement?.closest('[data-notr]')) continue;
    const v = t.nodeValue || '';
    if (CJK.test(v)) t.nodeValue = tr(v);
  }
  if (root instanceof Element || root instanceof Document) {
    (root as ParentNode).querySelectorAll('[placeholder],[title]').forEach((el) => {
      for (const a of ['placeholder', 'title']) {
        const v = el.getAttribute(a);
        if (v && CJK.test(v)) el.setAttribute(a, tr(v));
      }
    });
  }
}
