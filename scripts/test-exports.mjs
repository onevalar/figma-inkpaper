import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
fs.mkdirSync('test/out', { recursive: true });
fs.mkdirSync('release/checks', { recursive: true });
for (const name of ['run', 'features', 'features2', 'raster', 'variants']) {
  const r = spawnSync(process.execPath, [`test/${name}.mjs`], { encoding: 'utf8' });
  fs.writeFileSync(`release/checks/${name}.log`, (r.stdout || '') + (r.stderr || ''));
  if (r.status !== 0) { console.error(name, r.stderr); process.exit(r.status || 1); }
  console.log(`PASS ${name} (execution; separate structural validation still required)`);
}
