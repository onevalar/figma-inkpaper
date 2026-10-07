// PDF password protection: Standard security handler, AES-256 (V5 / R6, PDF 2.0 / ISO 32000-2).
// Uses pure-JS AES / SHA-2 (@noble, MIT): Figma's plugin iframe is not a secure context, so WebCrypto
// (crypto.subtle) is unavailable there.

import { cbc } from '@noble/ciphers/aes.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';

const rand = (n: number) => {
  const b = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
  return b;
};
const cat = (...a: Uint8Array[]) => {
  const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of a) {
    out.set(x, p);
    p += x.length;
  }
  return out;
};
async function aesCbc(key: Uint8Array, iv: Uint8Array, data: Uint8Array, pad: boolean): Promise<Uint8Array> {
  return cbc(key, iv, { disablePadding: !pad }).encrypt(data);
}

async function sha(alg: 'SHA-256' | 'SHA-384' | 'SHA-512', d: Uint8Array) {
  return alg === 'SHA-256' ? sha256(d) : alg === 'SHA-384' ? sha384(d) : sha512(d);
}

/** ISO 32000-2 Algorithm 2.B */
async function hash2B(pwd: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Uint8Array> {
  let K = await sha('SHA-256', cat(pwd, salt, udata));
  let round = 0;
  for (;;) {
    const seq = cat(pwd, K, udata);
    const K1 = new Uint8Array(seq.length * 64);
    for (let i = 0; i < 64; i++) K1.set(seq, i * seq.length);
    const E = await aesCbc(K.subarray(0, 16), K.subarray(16, 32), K1, false);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += E[i];
    const m = sum % 3;
    K = await sha(m === 0 ? 'SHA-256' : m === 1 ? 'SHA-384' : 'SHA-512', E);
    round++;
    if (round >= 64 && E[E.length - 1] <= round - 32) break;
  }
  return K.subarray(0, 32);
}

const pw = (s: string) => new TextEncoder().encode(s.normalize('NFKC')).subarray(0, 127);

export async function encryptDocument(doc: PDFDocument, userPassword: string, ownerPassword?: string) {
  // embed pending pages/fonts first so their streams get encrypted too
  await (doc as any).flush();
  const ctx = doc.context;
  const fileKey = rand(32);
  const upw = pw(userPassword);
  const opw = pw(ownerPassword || Array.from(rand(16), (b) => b.toString(16)).join(''));

  // Algorithm 8 — U / UE
  const uVal = rand(8), uKey = rand(8);
  const U = cat(await hash2B(upw, uVal, new Uint8Array(0)), uVal, uKey);
  const UE = await aesCbc(await hash2B(upw, uKey, new Uint8Array(0)), new Uint8Array(16), fileKey, false);
  // Algorithm 9 — O / OE
  const oVal = rand(8), oKey = rand(8);
  const O = cat(await hash2B(opw, oVal, U), oVal, oKey);
  const OE = await aesCbc(await hash2B(opw, oKey, U), new Uint8Array(16), fileKey, false);
  // Algorithm 10 — Perms (all permissions granted)
  const P = -4;
  const perms = new Uint8Array(16);
  new DataView(perms.buffer).setInt32(0, P, true);
  perms.set([0xff, 0xff, 0xff, 0xff], 4);
  perms.set([0x54, 0x61, 0x64, 0x62], 8); // 'T' (EncryptMetadata) 'adb'
  perms.set(rand(4), 12);
  const Perms = await aesCbc(fileKey, new Uint8Array(16), perms, false);

  const encBytes = async (b: Uint8Array) => {
    const iv = rand(16);
    return cat(iv, await aesCbc(fileKey, iv, b, true));
  };

  const encObj = async (o: PDFObject): Promise<PDFObject> => {
    if (o instanceof PDFString || o instanceof PDFHexString) return PDFHexString.of(toHex(await encBytes(o.asBytes())));
    if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) o.set(i, await encObj(o.get(i)));
      return o;
    }
    if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) o.set(k, await encObj(v));
      return o;
    }
    return o;
  };

  const encryptRef = ctx.register(
    ctx.obj({
      Filter: 'Standard',
      V: 5,
      R: 6,
      Length: 256,
      CF: { StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 } },
      StmF: 'StdCF',
      StrF: 'StdCF',
      O: PDFHexString.of(toHex(O)),
      U: PDFHexString.of(toHex(U)),
      OE: PDFHexString.of(toHex(OE)),
      UE: PDFHexString.of(toHex(UE)),
      Perms: PDFHexString.of(toHex(Perms)),
      P,
      EncryptMetadata: true,
    }),
  );

  const objs = ctx.enumerateIndirectObjects();
  for (const [ref, obj] of objs) {
    if (ref === encryptRef) continue;
    if (obj instanceof PDFStream) {
      await encObj(obj.dict);
      const contents = obj.getContents();
      const enc = await encBytes(contents);
      const ns = PDFRawStream.of(obj.dict, enc);
      ctx.assign(ref as PDFRef, ns);
    } else if (obj instanceof PDFString || obj instanceof PDFHexString) {
      ctx.assign(ref as PDFRef, await encObj(obj));
    } else await encObj(obj);
  }
  ctx.trailerInfo.Encrypt = encryptRef;
}

function toHex(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export { PDFName };
