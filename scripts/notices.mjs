import fs from 'node:fs';
import path from 'node:path';
const packages = ['@noble/ciphers', '@noble/hashes', 'lcms-wasm', 'pako', 'pdf-lib', '@pdf-lib/standard-fonts', '@pdf-lib/upng', 'pdf-lib/node_modules/pako', 'tslib'];
export function generateNotices(meta) {
  const paths = new Set(packages.map(name => `node_modules/${name}`));
  if (meta) for (const output of Object.values(meta.outputs)) for (const [input, info] of Object.entries(output.inputs)) {
    if (!info.bytesInOutput || !input.includes('node_modules/')) continue;
    let dir = path.dirname(input);
    while (dir !== '.' && !fs.existsSync(`${dir}/package.json`)) dir = path.dirname(dir);
    if (dir !== '.') paths.add(dir);
  }
  const sections = [...paths].sort().map(base => {
    const name = base.replace(/^node_modules\//, '');
    const pkg = JSON.parse(fs.readFileSync(`${base}/package.json`, 'utf8'));
    const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find(n => fs.existsSync(`${base}/${n}`));
    if (!file) {
      // Some packages ship no license file; record what package.json declares instead of failing the build.
      const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name || 'unknown';
      const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || 'unknown';
      console.warn(`notices: ${name} ships no license file; using package.json metadata`);
      return `${pkg.name} ${pkg.version} (${pkg.license})\nNo license file is shipped with this package. License declared in package.json: ${pkg.license}. Author: ${author}. Repository: ${repo}`;
    }
    return `${pkg.name} ${pkg.version} (${pkg.license})\n${fs.readFileSync(`${base}/${file}`, 'utf8')}${fs.existsSync(`${base}/CopyrightNotice.txt`) ? '\n' + fs.readFileSync(`${base}/CopyrightNotice.txt`, 'utf8') : ''}`;
  });
  sections.push(`Arc components (source copied into src/components/arc)\n${fs.readFileSync('src/components/arc/LICENSE', 'utf8')}`);
  sections.push(`LittleCMS (bundled by lcms-wasm; upstream source reference c2a54017d73080f97c5cd34a78ff2fb51564aade)\n${fs.readFileSync('scripts/lcms-LICENSE.txt', 'utf8')}\nAdditional notice from src/cmssm.c:\nCopyright 2001, softSurfer (www.softsurfer.com)\nThis code may be freely used and modified for any purpose\nproviding that this copyright notice is included with it.\nSoftSurfer makes no warranty for this code, and cannot be held\nliable for any real or imagined damage resulting from its use.\nUsers of this code must verify correctness for their application.`);
  const text = 'Inkpaper — Third-party notices\n\n' + sections.join('\n\n' + '-'.repeat(72) + '\n\n') + '\n';
  fs.writeFileSync('THIRD_PARTY_NOTICES.txt', text);
  return text;
}
