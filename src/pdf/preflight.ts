// Targeted ISO 15930 checks. This is deliberately not advertised as independent certification.
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFNumber } from 'pdf-lib';
import { decodeStream } from './streams';
import { bytesToLatin1, parseContent } from './lexer';
export interface PreflightIssue { code:string; object:string; message:string }
export function preflightPdfX(doc:PDFDocument,flavor:'x4'|'x1a'|'x3'):PreflightIssue[]{
  const issues:PreflightIssue[]=[];const add=(code:string,object:string,message:string)=>issues.push({code,object,message});
  const lookup=(d:PDFDict,k:string)=>doc.context.lookup(d.get(PDFName.of(k)));
  const intents=doc.context.lookup(doc.catalog.get(PDFName.of('OutputIntents')));
  if(!(intents instanceof PDFArray)||intents.size()!==1)add('output-intent','catalog','PDF/X 需要一个明确的输出意图');
  else {
    const intent=doc.context.lookup(intents.get(0));
    if(!(intent instanceof PDFDict)||lookup(intent,'S')?.toString()!=='/GTS_PDFX')add('output-intent','catalog','输出意图类型不是 GTS_PDFX');
    else {
      const profile=lookup(intent,'DestOutputProfile');
      if(!(profile instanceof PDFRawStream))add('icc','catalog','未嵌入 ICC 输出配置文件');
      else {const b=decodeStream(doc.context,profile),n=lookup(profile.dict,'N');if(!(n instanceof PDFNumber)||n.asNumber()!==4||bytesToLatin1(b.subarray(16,20))!=='CMYK'||bytesToLatin1(b.subarray(36,40))!=='acsp')add('icc','catalog','ICC 签名、色空间或通道数不正确');}
    }
  }
  if(doc.context.trailerInfo.Encrypt)add('encryption','trailer','PDF/X 不允许加密');
  if(flavor==='x4' && !doc.catalog.get(PDFName.of('Metadata')))add('xmp','catalog','PDF/X-4 缺少 XMP 元数据');
  for(const [i,page]of doc.getPages().entries()){
    const label='page '+(i+1),hasTrim=page.node.has(PDFName.of('TrimBox')),hasArt=page.node.has(PDFName.of('ArtBox'));
    if(hasTrim===hasArt)add('page-boxes',label,'PDF/X 页面必须只定义 TrimBox 或 ArtBox 中的一种');
    const media=page.getMediaBox(),bleed=page.getBleedBox(),trim=hasTrim?page.getTrimBox():page.getArtBox();
    const contains=(a:any,b:any)=>a.x<=b.x+0.01&&a.y<=b.y+0.01&&a.x+a.width>=b.x+b.width-0.01&&a.y+a.height>=b.y+b.height-0.01;
    if(!contains(media,bleed)||!contains(bleed,trim)||trim.width<=0||trim.height<=0)add('page-boxes',label,'页面框的尺寸或包含关系不正确');
  }
  const contentRefs = new Set<string>();
  for (const page of doc.getPages()) {
    const contents=page.node.get(PDFName.of('Contents'));
    if(contents instanceof PDFArray) contents.asArray().forEach(r=>contentRefs.add(r.toString())); else if(contents)contentRefs.add(contents.toString());
  }
  for(const [ref,obj]of doc.context.enumerateIndirectObjects()){
    const d=obj instanceof PDFRawStream?obj.dict:obj instanceof PDFDict?obj:null;if(!d)continue;
    const label=ref.toString(),type=lookup(d,'Type')?.toString(),subtype=lookup(d,'Subtype')?.toString();
    if(type==='/Font' && !['/Type0','/Type3'].includes(subtype||'')){
      const fd=lookup(d,'FontDescriptor');
      if(!(fd instanceof PDFDict)||!['FontFile','FontFile2','FontFile3'].some(k=>lookup(fd,k)instanceof PDFRawStream))add('font-embedding',label,'存在未嵌入的字体，请改为文字转曲或检查字体导出');
    }
    for(const key of ['JS','JavaScript','EmbeddedFiles','RichMediaContent','XFA','OPI'])if(d.has(PDFName.of(key)))add('unsupported-content',label,'存在 PDF/X 不支持的动态、附件或外部内容：'+key);
    if(flavor!=='x4'){
      if(lookup(d,'S')?.toString()==='/Transparency')add('transparency',label,'PDF/X-1a、X-3 不允许透明组');
      const mask=lookup(d,'SMask');if(mask && mask.toString()!=='/None')add('transparency',label,'PDF/X-1a、X-3 不允许软蒙版');
      for(const key of ['ca','CA']){const v=lookup(d,key);if(v instanceof PDFNumber&&v.asNumber()!==1)add('transparency',label,'PDF/X-1a、X-3 不允许透明度');}
      const bm=lookup(d,'BM');if(bm&&bm.toString()!=='/Normal'&&bm.toString()!=='/Compatible')add('transparency',label,'PDF/X-1a、X-3 不允许混合模式');
    }
    if(flavor==='x1a' && lookup(d,'ColorSpace')?.toString()==='/DeviceRGB')add('rgb',label,'PDF/X-1a 不允许 RGB 图像');
    if(flavor==='x1a' && obj instanceof PDFRawStream && (subtype==='/Form'||contentRefs.has(label))){
      try {const b=decodeStream(doc.context,obj);if(!b.remaining && parseContent(bytesToLatin1(b)).some(x=>x.op==='rg'||x.op==='RG'))add('rgb',label,'PDF/X-1a 不允许 RGB 内容运算符');}catch{/* binary/font stream is not a page content stream */}
    }
  }
  return issues;
}
