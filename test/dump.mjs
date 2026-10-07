import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFArray, PDFRef } from 'pdf-lib';
import * as pako from 'pako';
import fs from 'fs';
const doc = await PDFDocument.load(fs.readFileSync(process.argv[2]));
for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
  let dict = obj instanceof PDFRawStream ? obj.dict : obj;
  let s = `${ref} ${obj.constructor.name} ` + (dict instanceof PDFDict ? dict.toString().replace(/\s+/g,' ').slice(0,400) : String(obj).slice(0,300));
  console.log(s);
  if (obj instanceof PDFRawStream) {
    const st = dict.get(PDFName.of('Subtype'));
    if (st && (st.toString()==='/Image')) continue;
    let data = obj.contents;
    const f = dict.get(PDFName.of('Filter'));
    if (f && f.toString().includes('FlateDecode')) { try { data = pako.inflate(data);} catch(e){} }
    const txt = Buffer.from(data).toString('latin1');
    if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(txt.slice(0,2000))) console.log('   >>> ' + txt.slice(0, +process.argv[3]||1500).replace(/\n/g,' | '));
  }
}
