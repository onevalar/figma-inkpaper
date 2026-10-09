// Browser regression coverage for the real bundled UI. Start a static server at the repo root first.
// Usage: node build.mjs && node test/workbench.mjs http://localhost:4173/test/harness.html
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';

const session = 'ink-workbench-test';
const url = new URL(process.argv[2] || 'http://localhost:4173/test/harness.html');
url.searchParams.set('no-icc', '1');
function browser(...args) {
  const result = JSON.parse(execFileSync('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  assert.equal(result.success, true, result.error?.message);
  return result.data?.result;
}
const evaluate = (code) => browser('eval', `(() => { const d = document.getElementById('ui').contentDocument; ${code} })()`);
const wait = (condition) => browser('wait', '--fn', `(() => { const d = document.getElementById('ui').contentDocument; return !!(${condition}); })()`);
const click = (selector) => evaluate(`d.querySelector(${JSON.stringify(selector)}).click();`);
const route = (name) => click(`nav button[data-v="${name}"]`);
const change = (path, value) => evaluate(`const el = d.querySelector('[data-bind="${path}"]'); ${typeof value === 'boolean' ? `el.checked = ${value};` : `el.value = ${JSON.stringify(String(value))};`} el.dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));`);
const text = () => evaluate('return d.body.innerText;');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('✓', name); }

try {
  browser('open', url.href);
  wait('d.querySelector(".quality")');
  check('Navigation is freely switchable and never implies completion', () => {
    route('prepare'); route('export');
    assert.deepEqual(evaluate('return [...d.querySelectorAll("nav .n")].map(e => e.textContent);'), ['1', '2', '3']);
    assert.match(text(), /未检查/);
  });
  check('Settings change language and units without changing physical bleed', () => {
    click('header [data-v="settings"]');
    evaluate(`const el = d.querySelector('#lang'); el.value = 'en'; el.dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));`);
    wait('d.documentElement.lang === "en"');
    assert.match(text(), /Preferences/);
    change('unit', 'cm');
    click('.sheet-h .back');
    assert.equal(evaluate('return d.querySelector("[data-bind=bleedMm]").value;'), '0.3');
    click('header [data-v="settings"]');
    change('unit', 'mm');
    evaluate(`const el = d.querySelector('#lang'); el.value = 'zh-CN'; el.dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));`);
    wait('d.documentElement.lang === "zh-CN"');
  });
  check('Long navigation labels stay on one line without overlapping utilities', () => {
    evaluate(`ui.style.width = '362px'; const el = d.querySelector('#lang'); el.value = 'de'; el.dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));`);
    wait('d.documentElement.lang === "de"');
    const layout = evaluate('return [...d.querySelectorAll(".step")].map((e,i,a)=>{ const n=e.children[0].getBoundingClientRect(),t=e.children[1].getBoundingClientRect(),next=(a[i+1]||d.querySelector(".header-actions")).getBoundingClientRect();return { sameLine: Math.abs(n.y+n.height/2-t.y-t.height/2)<1, overlap: t.right>next.x }; });');
    assert.ok(layout.every((e) => e.sameLine && !e.overlap));
    evaluate(`ui.style.width = '100%'; const el = d.querySelector('#lang'); el.value = 'zh-CN'; el.dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));`);
    wait('d.documentElement.lang === "zh-CN"');
  });
  check('Resources work without selection or CMYK, and back returns to Settings', () => {
    click('.settings-link[data-v="profile"]');
    click('[data-path="mode"][data-v=\'"rgb"\']');
    click('.sheet-h .back');
    assert.equal(evaluate('return d.querySelector(".sheet-h .title").textContent;'), '设置');
    evaluate('send({ type: "selection", frames: [], measure: [] });');
    click('.settings-link[data-v="resources"]');
    assert.ok(evaluate('return !!d.querySelector("[data-act=import-lib]");'));
    evaluate('d.querySelector("#map-name").value = "测试品牌色";');
    click('[data-act="save-map"]');
    assert.equal(evaluate('return d.querySelector("#map-select").value;'), '测试品牌色');
    click('[data-act="del-map"]');
    click('.sheet-h .back');
    click('.settings-link[data-v="transfer"]');
    assert.match(text(), /不含 ICC 和色板/);
    click('.sheet-h .back');
    click('.settings-link[data-v="profile"]');
    click('[data-act="profile"][data-v="digital"]');
    click('[data-act="profile"][data-v="coated"]');
    click('.sheet-h .back'); click('.sheet-h .back');
    evaluate('send({ type: "selection", frames, measure: [] });');
    route('export');
  });
  check('Canvas tools support keyboard expansion and keep output rules separate', () => {
    evaluate('send({ type: "selection", frames, measure: [{ id: "2:1", name: "尺寸样例", type: "RECTANGLE", w: 144, h: 72 }] });');
    click('header [data-v="tools"]');
    assert.equal(evaluate('return d.querySelectorAll("button[data-act=tool]").length;'), 7);
    assert.doesNotMatch(text(), /刀线与工艺识别规则/);
    evaluate('d.querySelector("[data-act=tool][data-v=measure]").focus();');
    browser('press', 'Enter');
    assert.equal(evaluate('return d.querySelector("[data-act=mz][data-k=w]").value;'), '50.8');
    assert.equal(evaluate('return d.querySelector("[data-act=mz][data-k=h]").value;'), '25.4');
    click('[data-act="tool"][data-v="pick"]');
    assert.equal(evaluate('return !!d.querySelector("#tool-measure");'), false);
    assert.ok(evaluate('return !!d.querySelector("[data-act=pick-apply]");'));
    click('.sheet-h .back');
  });
  check('Advanced settings stay connected to the full settings panel', () => {
    click('[data-act="more-open"]');
    change('compression', 'strong');
    click('[data-act="sheet"][data-v="more"]');
    assert.equal(evaluate('return d.querySelector("[data-bind=compression] button[aria-pressed=true]")?.textContent || d.querySelector("[data-path=compression][aria-pressed=true]")?.textContent;'), '强力');
    assert.match(text(), /刀线与工艺识别规则/);
    click('[data-act="sheet"][data-v=""]');
    assert.equal(evaluate('return d.querySelector("[data-bind=compression]").value;'), 'strong');
    change('compression', 'balanced');
    assert.doesNotMatch(evaluate('return d.querySelector("[data-act=more-open]").textContent;'), /已自定义/);
    change('compression', 'custom');
    click('[data-act="sheet"][data-v="more"]');
    change('jpegQuality', 89);
    click('[data-act="sheet"][data-v=""]');
    assert.equal(evaluate('return d.querySelector("[data-bind=compression]").value;'), 'custom');
    assert.match(evaluate('return d.querySelector("[data-act=more-open]").textContent;'), /已自定义/);
    change('compression', 'strong');
    click('[data-act="more-open"]');
    assert.match(evaluate('return d.querySelector("[data-act=more-open]").textContent;'), /已自定义/);
    assert.match(evaluate('return d.querySelector(".profile").textContent;'), /未选择 ICC/);
  });
  check('Advanced expansion and choices survive reopening, not only navigation', () => {
    click('[data-act="more-open"]');
    wait('store.pk_settings?.advancedOpen === true');
    evaluate('ui.contentWindow.location.reload();');
    wait('d.querySelector("#export-advanced [data-bind=compression]")?.value === "strong"');
    click('[data-act="more-open"]');
    route('prepare'); route('export');
    assert.equal(evaluate('return !!d.querySelector("#export-advanced");'), false);
    assert.match(evaluate('return d.querySelector("[data-act=more-open]").textContent;'), /已自定义/);
  });
  check('Page order has a keyboard alternative to dragging', () => {
    click('[data-act="pages-open"]');
    evaluate(`d.querySelector('[data-act="page-move"][data-dir="1"]').focus();`);
    browser('press', 'Enter');
    assert.deepEqual(evaluate('return [...d.querySelectorAll(".page-select")].map(e => e.title);'), ['名片 正面', 'A4 海报']);
    click('[data-act="pages-open"]');
  });
  check('Skipping a check requires a cancellable confirmation', () => {
    click('[data-act="export"]');
    assert.match(evaluate('return d.querySelector("dialog").textContent;'), /跳过检查并导出/);
    assert.equal(evaluate('return d.activeElement.textContent;'), '取消');
    browser('press', 'Escape');
    wait('!d.querySelector("dialog").open && d.activeElement.dataset.act === "export"');
    assert.equal(evaluate('return d.querySelector("dialog").open;'), false);
    assert.equal(evaluate('return d.activeElement.dataset.act;'), 'export');
    assert.equal(evaluate('return window.exportRequests.length;'), 0);
  });
  route('check');
  wait('d.querySelector(".issue-card")');
  check('Missing ICC and low resolution are risks, not an invented print-ready score', () => {
    assert.match(text(), /2 项风险需要处理或确认/);
    assert.match(text(), /152 ppi/);
    assert.match(text(), /没有选择 ICC/);
    assert.doesNotMatch(text(), /可以印刷|不影响印刷/);
  });
  click('[data-act="std-open"]');
  change('blockLowPpi', true);
  route('export'); click('[data-act="export"]'); click('[data-act="export-confirm"]');
  wait('d.querySelector("h1")?.textContent === "检查印刷质量"');
  check('Accepting risks cannot bypass the optional low-resolution export block', () => {
    assert.equal(evaluate('return window.exportRequests.length;'), 0);
    assert.match(text(), /152 ppi/);
  });
  change('blockLowPpi', false);
  evaluate('mock.holdChecks = true;');
  click('[data-act="preflight"]');
  wait('mock.pendingChecks.length === 1');
  evaluate('mock.ppi = 320; send({ type: "selection", frames, measure: [] });');
  wait('mock.pendingChecks.length === 2');
  evaluate('send(mock.pendingChecks[1]);');
  wait('d.body.innerText.includes("1 项风险需要处理或确认")');
  evaluate('send(mock.pendingChecks[0]); mock.holdChecks = false;');
  check('An older reply cannot replace the latest completed check', () => {
    assert.doesNotMatch(text(), /152 ppi/);
    assert.match(text(), /1 项风险需要处理或确认/);
  });
  route('export'); change('bleedMm', 2);
  wait('d.body.innerText.includes("需重新检查")');
  check('Changing output settings invalidates the old check', () => {
    click('[data-act="export"]');
    assert.match(evaluate('return d.querySelector("dialog").textContent;'), /还未完成当前检查/);
    click('[data-act="export-cancel"]');
  });
  evaluate('mock.failCheck = true;');
  route('check');
  wait('d.body.innerText.includes("检查未完成，请重试")');
  evaluate('mock.failCheck = false;');
  click('[data-act="preflight"]');
  wait('d.querySelector(".issue-card")');
  check('A failed check can be retried', () => assert.match(text(), /1 项风险需要处理或确认/));
  change('minPpi', 350);
  wait('d.body.innerText.includes("需要更新检查结果")');
  check('Changing a check standard keeps the other standards editable', () => {
    assert.equal(evaluate('return d.querySelector("[data-bind=minPpi]")?.value;'), '350');
    change('minTextPt', 7);
    assert.equal(evaluate('return d.querySelector("[data-bind=minTextPt]").value;'), '7');
  });
  click('.well [data-act="preflight"]');
  wait('d.querySelector(".issue-card")');
  assert.match(text(), /320 ppi，低于 350 ppi/);
  assert.match(text(), /字号 ≥ 7 pt/);
  change('minPpi', 250);
  route('export'); change('cropMarks', false); change('title', '工作台回归样例');
  click('[data-act="export"]'); click('[data-act="export-confirm"]');
  wait('window.lastBytes?.length > 0');
  const pdf = await PDFDocument.load(new Uint8Array(evaluate('return Array.from(window.lastBytes);')));
  check('Real export applies page order, filename and bleed settings', () => {
    assert.equal(evaluate('return window.downloads[0].name;'), '工作台回归样例.pdf');
    assert.equal(pdf.getPageCount(), 2);
    const mm = 72 / 25.4;
    const first = pdf.getPage(0);
    assert.ok(Math.abs(first.getTrimBox().width - 90 * mm) < 0.01);
    assert.ok(Math.abs(first.getTrimBox().height - 54 * mm) < 0.01);
    assert.ok(Math.abs(first.getBleedBox().width - 94 * mm) < 0.01);
    assert.ok(Math.abs(first.getBleedBox().height - 58 * mm) < 0.01);
    assert.ok(Math.abs(pdf.getPage(1).getTrimBox().width - 210 * mm) < 0.01);
  });
  console.log(`PASS: ${checks} workbench regression checks; downloaded PDF has 2 pages and expected page boxes.`);
} finally {
  browser('close');
}
