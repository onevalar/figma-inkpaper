// Explicit, local migration between the legacy and official plugin identities.
export const LEGACY_ID = 'presskit-print-export-local';
export const OFFICIAL_ID = '1691712698137473867';
const FILE_KEYS = new Set(['presskit', 'pk_text', 'pk_label_for', 'pk_pagenum', 'pk_maps']);
const NS = 'inkpaper_migration';
export interface MigrationBackup { format: 'inkpaper-migration'; version: 1; sourceId: string; documentToken: string; created: string; storage: Record<string, any>; nodes: { id: string; type: string; data: Record<string, string> }[] }
function encode(v: any): any {
  if (v instanceof Uint8Array) return { $inkpaperBytes: Array.from(v) };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encode(x)]));
  return v;
}
function decode(v: any): any {
  if (v && typeof v === 'object' && '$inkpaperBytes' in v) {
    if (Object.keys(v).length !== 1 || !Array.isArray(v.$inkpaperBytes) || !v.$inkpaperBytes.every((n: any)=>Number.isInteger(n)&&n>=0&&n<=255)) throw new Error('Invalid binary data');
    return new Uint8Array(v.$inkpaperBytes);
  }
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    if (Object.keys(v).some(k=>['__proto__','constructor','prototype'].includes(k))) throw new Error('Invalid object key');
    return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,decode(x)]));
  }
  return v;
}
function fileNodes(root: BaseNode): BaseNode[] {
  const result: BaseNode[] = []; const queue = [root];
  while(queue.length) {const n=queue.pop()!;result.push(n);if('children' in n) queue.push(...(n as ChildrenMixin).children);}
  return result;
}
export async function exportMigration(): Promise<MigrationBackup> {
  await figma.loadAllPagesAsync();
  let token = figma.root.getSharedPluginData(NS,'document-token');
  if (!token) {token=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);figma.root.setSharedPluginData(NS,'document-token',token);}
  const storage: Record<string,any> = {};
  for(const key of await figma.clientStorage.keysAsync()) if(key.startsWith('pk_')) storage[key]=encode(await figma.clientStorage.getAsync(key));
  const nodes=fileNodes(figma.root).map(n=>({id:n.id,type:n.type,data:Object.fromEntries(n.getPluginDataKeys().filter(k=>FILE_KEYS.has(k)).map(k=>[k,n.getPluginData(k)]))})).filter(n=>Object.keys(n.data).length);
  return {format:'inkpaper-migration',version:1,sourceId:figma.pluginId || '',documentToken:token,created:new Date().toISOString(),storage,nodes};
}
export async function importMigration(backup: MigrationBackup) {
  if(figma.pluginId!==OFFICIAL_ID || backup?.format!=='inkpaper-migration'||backup.version!==1||backup.sourceId!==LEGACY_ID) throw new Error('迁移文件或插件身份不匹配');
  if(JSON.stringify(backup).length>24*1024*1024 || !Array.isArray(backup.nodes) || backup.nodes.length>50000 || !backup.storage || typeof backup.storage!=='object')throw new Error('迁移文件格式或大小不正确');
  if(!backup.documentToken || figma.root.getSharedPluginData(NS,'document-token')!==backup.documentToken)throw new Error('请在导出迁移备份的同一 Figma 文件中导入');
  const storage=decode(backup.storage);
  if(Object.keys(storage).some(k=>!/^pk_[\w-]+$/.test(k)))throw new Error('Invalid storage key');
  await figma.loadAllPagesAsync();
  const seen=new Set<string>();
  const writes: {node:BaseNode;key:string;value:string;old:string}[]=[];
  for(const row of backup.nodes){
    if(seen.has(row.id))throw new Error('Duplicate node');seen.add(row.id);
    const node=await figma.getNodeByIdAsync(row.id);
    if(!node || node.type!==row.type)throw new Error('迁移备份中的图层不存在或类型已改变：'+row.id);
    for(const [key,value] of Object.entries(row.data)){
      if(!FILE_KEYS.has(key)||typeof value!=='string'||value.length>90000)throw new Error('Invalid plugin data');
      writes.push({node,key,value,old:node.getPluginData(key)});
    }
  }
  const storageKeys=Object.keys(storage),existing=new Set(await figma.clientStorage.keysAsync());
  const before=Object.fromEntries(await Promise.all(storageKeys.map(async k=>[k,await figma.clientStorage.getAsync(k)])));
  const receiptKey='inkpaper_migration_receipt_v1';
  if(writes.every(w=>w.old===w.value) && storageKeys.length && storageKeys.every(k=>JSON.stringify(encode(before[k]))===JSON.stringify(encode(storage[k]))))return {storageKeys:storageKeys.length,nodeCount:backup.nodes.length,verified:true,alreadyImported:true};
  const touchedStorage:string[]=[];const touchedNodes:typeof writes=[];
  try {
    for(const key of storageKeys){touchedStorage.push(key);await figma.clientStorage.setAsync(key,storage[key]);}
    for(const w of writes){touchedNodes.push(w);w.node.setPluginData(w.key,w.value);}
    for(const key of storageKeys)if(JSON.stringify(encode(await figma.clientStorage.getAsync(key)))!==JSON.stringify(encode(storage[key])))throw new Error('Storage verification failed: '+key);
    for(const w of writes)if(w.node.getPluginData(w.key)!==w.value)throw new Error('File metadata verification failed');
    await figma.clientStorage.setAsync(receiptKey,{created:new Date().toISOString(),sourceId:backup.sourceId,documentToken:backup.documentToken,storageKeys:storageKeys.length,nodeCount:backup.nodes.length,verified:true});
    return {storageKeys:storageKeys.length,nodeCount:backup.nodes.length,verified:true,alreadyImported:false};
  } catch(error) {
    const rollbackErrors:string[]=[];
    for(const w of touchedNodes.reverse())try{w.node.setPluginData(w.key,w.old);}catch{rollbackErrors.push(w.node.id+':'+w.key);}
    for(const key of touchedStorage.reverse())try{if(existing.has(key))await figma.clientStorage.setAsync(key,before[key]);else await figma.clientStorage.deleteAsync(key);}catch{rollbackErrors.push(key);}
    if(rollbackErrors.length)throw new Error('迁移失败且部分回退未完成，请保留旧版备份：'+rollbackErrors.join(', '));
    throw error;
  }
}
