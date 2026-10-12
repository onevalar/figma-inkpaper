// Browser regression coverage for the real bundled React/Arc UI, including real PDF downloads.
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
const settle = () => evaluate('return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));');
function inFrame(...args) {
  browser('frame', '#ui');
  try { return browser(...args); } finally { browser('frame', 'main'); }
}
const click = (selector) => { inFrame('click', selector); settle(); };
const route = (name) => click(`nav button[data-v="${name}"]`);
function choose(id, label) {
  inFrame('click', `[id="${id}"]`);
  wait('d.querySelector("[role=listbox]")');
  evaluate(`const option = [...d.querySelectorAll('[role=option]')].find(e => e.textContent.trim() === ${JSON.stringify(label)}); if (!option) throw new Error('Missing option'); option.focus();`);
  browser('press', 'Enter');
  wait('!d.querySelector("[role=listbox]")');
  settle();
}
function fill(id, value) {
  inFrame('fill', `[id="${id}"]`, String(value));
  browser('press', 'Tab');
  settle();
}
function toggle(path, enabled) {
  const selector = `[id="setting-${path}"]`;
  if (evaluate(`return d.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked');`) !== String(enabled)) click(selector);
}
function segment(label, option) {
  // Arc uses native buttons with aria-pressed inside its labelled group.
  assert.ok(evaluate(`return !!d.querySelector('[role="group"][aria-label="${label}"]');`));
  inFrame('find', 'role', 'button', 'click', '--name', option, '--exact');
  settle();
}
function disclosure(title) {
  inFrame('find', 'role', 'button', 'click', '--name', title);
  settle();
}
const text = () => evaluate('return d.body.innerText;');
const value = (path) => evaluate(`return d.getElementById(${JSON.stringify('setting-' + path)}).value;`);
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('✓', name); }

try {
  browser('open', url.href);
  browser('set', 'viewport', '1280', '900', '2');
  browser('set', 'media', 'light', 'reduced-motion');
  wait('d.querySelector(".quality")');
  check('Navigation stays freely switchable and does not imply completion', () => {
    route('prepare'); route('export');
    assert.deepEqual(evaluate('return [...d.querySelectorAll("nav .num")].map(e => e.textContent);'), ['1', '2', '3']);
    assert.match(text(), /未检查/);
  });
  check('Adding bleed explains its canvas impact and uses the Prepare values', () => {
    route('prepare');
    const sectionText = () => evaluate('return d.querySelector("[data-act=convert-doc]").closest("section").innerText;');
    const disabled = () => evaluate('return d.querySelector("[data-act=convert-doc]").disabled;');
    assert.match(sectionText(), /为现有画板添加出血/);
    assert.match(sectionText(), /会修改原稿/);
    assert.equal(evaluate('return d.querySelector("[data-act=convert-doc]").textContent;'), '添加出血');
    assert.equal(disabled(), false);
    evaluate('window.bleedRequests = []; window.captureBleed = ev => { const m = ev.data?.pluginMessage; if (m?.type === "convert-frames") window.bleedRequests.push(m); }; window.addEventListener("message", window.captureBleed);');
    const originalBleed = value('doc.bleed');
    fill('setting-doc.bleed', 4.5); click('[data-act="convert-doc"]');
    wait('window.bleedRequests.length === 1');
    assert.deepEqual(evaluate('return window.bleedRequests[0];'), { type: 'convert-frames', bleed: { t: 4.5, r: 4.5, b: 4.5, l: 4.5 }, extend: true });
    disclosure('更多尺寸选项'); toggle('doc.sidesOn', true);
    const sides = ['t', 'r', 'b', 'l'];
    const originalSides = sides.map(side => value(`doc.sides.${side}`));
    [0, 2.5, 4, 1].forEach((n, i) => fill(`setting-doc.sides.${sides[i]}`, n));
    click('[data-act="convert-doc"]'); wait('window.bleedRequests.length === 2');
    assert.deepEqual(evaluate('return window.bleedRequests[1];'), { type: 'convert-frames', bleed: { t: 0, r: 2.5, b: 4, l: 1 }, extend: true });
    originalSides.forEach((n, i) => fill(`setting-doc.sides.${sides[i]}`, n));
    toggle('doc.sidesOn', false); fill('setting-doc.bleed', originalBleed); disclosure('更多尺寸选项');
    evaluate('send({ type: "selection", frames: [], measure: [] });'); settle();
    assert.equal(disabled(), true); assert.match(sectionText(), /先在 Figma 中选择/);
    evaluate('send({ type: "selection", frames: frames.filter(f => f.meta), measure: [] });'); settle();
    assert.equal(disabled(), true); assert.match(sectionText(), /已有印刷设置/); assert.match(sectionText(), /补足出血请到「导出」/);
    assert.equal(evaluate('return window.bleedRequests.length;'), 2);
    evaluate('window.removeEventListener("message", window.captureBleed); send({ type: "selection", frames, measure: [] });'); settle(); route('export');
  });
  check('Language and units change without changing physical bleed', () => {
    click('header [data-v="settings"]');
    choose('lang', 'English');
    wait('d.documentElement.lang === "en"');
    assert.match(text(), /Preferences/);
    choose('setting-unit', 'cm');
    click('.sheet-h .back');
    assert.equal(Number(value('bleedMm')), 0.3);
    click('header [data-v="settings"]');
    choose('setting-unit', 'mm'); choose('lang', '简体中文');
  });
  check('Long labels and inputs stay inside a narrow plugin window', () => {
    evaluate('ui.style.width = "390px";');
    choose('lang', 'Deutsch');
    settle();
    assert.equal(evaluate('return d.documentElement.scrollWidth <= d.documentElement.clientWidth;'), true);
    const layout = evaluate('return [...d.querySelectorAll("nav .step")].map(e => { const a=e.getBoundingClientRect(),b=d.querySelector(".header-actions").getBoundingClientRect(); return a.right<=b.left || a.bottom<=b.top || a.top>=b.bottom; });');
    assert.ok(layout.every(Boolean));
    click('.sheet-h .back');
    const inputs = evaluate('const view=d.getElementById("view"), edge=view.getBoundingClientRect().right-parseFloat(d.defaultView.getComputedStyle(view).paddingRight); return [...view.querySelectorAll("input:not([type=hidden],[type=file])")].map(e=>e.getBoundingClientRect().right<=edge+0.5);');
    assert.ok(inputs.length > 0 && inputs.every(Boolean));
    click('header [data-v="settings"]');
    evaluate('ui.style.width = "100%";'); choose('lang', '简体中文');
  });
  check('Resources work without selection or CMYK and return to Settings', () => {
    click('.settings-link[data-v="profile"]'); segment('输出色彩', 'RGB');
    click('.sheet-h .back');
    assert.equal(evaluate('return d.querySelector(".sheet-h .title").textContent;'), '设置');
    evaluate('send({ type: "selection", frames: [], measure: [] });'); settle();
    click('.settings-link[data-v="resources"]');
    assert.ok(evaluate('return !!d.querySelector("[data-act=import-lib]");'));
    fill('map-name', '测试品牌色'); click('[data-act="save-map"]');
    assert.equal(evaluate('return d.querySelector("#map-select").value;'), '测试品牌色');
    click('[data-act="del-map"]'); click('.sheet-h .back');
    click('.settings-link[data-v="transfer"]'); assert.match(text(), /不含 ICC 和色板/);
    click('.sheet-h .back'); click('.settings-link[data-v="profile"]');
    inFrame('find', 'role', 'radio', 'click', '--name', '数码快印', '--exact'); settle();
    inFrame('find', 'role', 'radio', 'click', '--name', '胶印 · 铜版纸', '--exact'); settle();
    click('.sheet-h .back'); click('.sheet-h .back');
    evaluate('send({ type: "selection", frames, measure: [] });'); settle(); route('export');
  });
  check('Canvas tools expand by keyboard and stay separate from output rules', () => {
    evaluate('send({ type: "selection", frames, measure: [{ id: "2:1", name: "尺寸样例", type: "RECTANGLE", w: 144, h: 72 }] });'); settle();
    click('header [data-v="tools"]');
    assert.equal(evaluate('return d.querySelectorAll(".tools h3 button").length;'), 7);
    assert.doesNotMatch(text(), /刀线与工艺识别规则/);
    evaluate('d.querySelector(".tools h3 button").focus();'); browser('press', 'Enter'); settle();
    assert.equal(Number(evaluate('return d.getElementById("measure-2:1-w").value;')), 50.8);
    assert.equal(Number(evaluate('return d.getElementById("measure-2:1-h").value;')), 25.4);
    disclosure('按 CMYK 数值上色');
    wait('d.querySelector("[data-act=pick-apply]") && !d.getElementById("measure-2:1-w")');
    assert.equal(evaluate('return !!d.getElementById("measure-2:1-w");'), false);
    assert.ok(evaluate('return !!d.querySelector("[data-act=pick-apply]");'));
    click('.sheet-h .back');
  });
  check('Advanced settings stay connected to the full settings panel', () => {
    disclosure('专业设置'); choose('setting-compression', '强力');
    click('[data-act="sheet"][data-v="more"]');
    assert.match(evaluate('return d.querySelector("[role=group][aria-label=图片压缩] button[aria-pressed=true]").textContent;'), /强力/);
    assert.match(text(), /刀线与工艺识别规则/);
    click('.sheet-h .back');
    assert.match(evaluate('return d.getElementById("setting-compression").textContent;'), /强力/);
    choose('setting-compression', '均衡');
    assert.doesNotMatch(evaluate('return d.querySelector(".advanced").textContent;'), /已自定义/);
    choose('setting-compression', '自定义'); click('[data-act="sheet"][data-v="more"]');
    fill('setting-jpegQuality', 89); click('.sheet-h .back');
    assert.match(evaluate('return d.getElementById("setting-compression").textContent;'), /自定义/);
    assert.match(evaluate('return d.querySelector(".advanced").textContent;'), /已自定义/);
    choose('setting-compression', '强力'); disclosure('专业设置');
    assert.match(evaluate('return d.querySelector(".advanced").textContent;'), /已自定义/);
    assert.match(evaluate('return d.querySelector(".profile").textContent;'), /未选择 ICC/);
  });
  check('Advanced expansion and choices survive reopening', () => {
    disclosure('专业设置'); wait('store.pk_settings?.advancedOpen === true && store.pk_settings.compression === "strong"');
    evaluate('ui.contentWindow.location.reload();');
    wait('d.getElementById("setting-compression")?.textContent.includes("强力")');
    disclosure('专业设置'); route('prepare'); route('export');
    assert.equal(evaluate('return !!d.getElementById("setting-compression");'), false);
    assert.match(evaluate('return d.querySelector(".advanced").textContent;'), /已自定义/);
  });
  check('Page ordering has a keyboard alternative to dragging', () => {
    disclosure('查看与排序');
    evaluate(`d.querySelector('[data-act=page-move][data-dir="1"]').focus();`); browser('press', 'Enter'); settle();
    assert.deepEqual(evaluate('return [...d.querySelectorAll(".page-select")].map(e => e.title);'), ['名片 正面', 'A4 海报']);
    disclosure('查看与排序');
  });
  check('Skipping a check requires a cancellable, focus-trapping confirmation', () => {
    click('[data-act="export"]'); wait('d.querySelector("[role=dialog]")');
    assert.match(evaluate('return d.querySelector("[role=dialog]").textContent;'), /跳过检查并导出/);
    assert.equal(evaluate('return d.activeElement.textContent;'), '取消');
    for (let i = 0; i < 6; i++) {
      browser('press', 'Tab');
      assert.equal(evaluate('return !!d.activeElement.closest("[role=dialog]");'), true);
    }
    browser('press', 'Escape');
    wait('!d.querySelector("[role=dialog]") && d.activeElement.dataset.act === "export"');
    assert.equal(evaluate('return window.exportRequests.length;'), 0);
  });
  route('check'); wait('d.querySelector(".issue-card")');
  check('Missing ICC and low resolution remain risks, not a made-up score', () => {
    assert.match(text(), /2 项风险需要处理或确认/); assert.match(text(), /152 ppi/); assert.match(text(), /没有选择 ICC/);
    assert.doesNotMatch(text(), /可以印刷|不影响印刷/);
  });
  check('Details and notes open on demand while risks and action consequences stay visible', () => {
    assert.match(text(), /152 ppi，要求 ≥ 250 ppi/);
    assert.match(text(), /会修改原稿；放大不会增加细节/);
    assert.doesNotMatch(text(), /印刷会模糊|「A4 海报」没有出血|最近一次快照/);
    evaluate('d.querySelector(".issue-list > .issue-card:first-child button[aria-controls]").focus();');
    browser('press', 'Enter'); settle();
    assert.match(text(), /图片「主视觉」实际分辨率 152 ppi，低于 250 ppi，印刷会模糊/);
    browser('press', 'Enter'); settle();
    assert.doesNotMatch(text(), /印刷会模糊/);
    disclosure('1 个提示');
    assert.match(text(), /没有出血/); assert.match(text(), /导出时自动延伸/);
    disclosure('1 个提示');
    disclosure('检查范围与图片');
    assert.match(text(), /最近一次快照/); assert.match(text(), /主视觉/);
    disclosure('检查范围与图片');
  });
  disclosure('检查标准'); toggle('blockLowPpi', true);
  route('export'); click('[data-act="export"]'); click('[data-act="export-confirm"]');
  wait('d.querySelector("h1")?.textContent === "检查印刷质量"');
  check('Accepting risks cannot bypass the optional low-resolution block', () => {
    assert.equal(evaluate('return window.exportRequests.length;'), 0); assert.match(text(), /152 ppi/);
  });
  toggle('blockLowPpi', false);
  evaluate('mock.holdChecks = true;'); click('[data-act="preflight"]'); wait('mock.pendingChecks.length === 1');
  evaluate('mock.ppi = 320; send({ type: "selection", frames, measure: [] });'); wait('mock.pendingChecks.length === 2');
  evaluate('send(mock.pendingChecks[1]);'); wait('d.body.innerText.includes("1 项风险需要处理或确认")');
  evaluate('send(mock.pendingChecks[0]); mock.holdChecks = false;'); settle();
  check('An older reply cannot replace the latest completed check', () => {
    assert.doesNotMatch(text(), /152 ppi/); assert.match(text(), /1 项风险需要处理或确认/);
  });
  route('export'); fill('setting-bleedMm', 2); wait('d.body.innerText.includes("需重新检查")');
  check('Changing output settings invalidates the previous check', () => {
    click('[data-act="export"]'); assert.match(evaluate('return d.querySelector("[role=dialog]").textContent;'), /还未完成当前检查/);
    click('[data-act="export-cancel"]'); wait('!d.querySelector("[role=dialog]")');
  });
  evaluate('mock.failCheck = true;'); route('check'); wait('d.body.innerText.includes("检查未完成，请重试")');
  evaluate('mock.failCheck = false;'); click('[data-act="preflight"]'); wait('d.querySelector(".issue-card")');
  check('A failed check can be retried', () => assert.match(text(), /1 项风险需要处理或确认/));
  fill('setting-minPpi', 350); wait('d.body.innerText.includes("需要更新检查结果")');
  check('Check standards remain editable after changing one', () => {
    assert.equal(Number(value('minPpi')), 350); fill('setting-minTextPt', 7); assert.equal(Number(value('minTextPt')), 7);
  });
  click('#check-standards [data-act="preflight"]'); wait('d.querySelector(".issue-card")');
  assert.match(text(), /320 ppi，要求 ≥ 350 ppi/);
  click('.issue-list > .issue-card:first-child button[aria-controls]');
  assert.match(text(), /320 ppi，低于 350 ppi/); assert.match(text(), /字号 ≥ 7 pt/);
  fill('setting-minPpi', 250); route('export'); toggle('cropMarks', false); fill('setting-title', '工作台回归样例');
  click('[data-act="export"]'); click('[data-act="export-confirm"]'); wait('window.lastBytes?.length > 0');
  const pdf = await PDFDocument.load(new Uint8Array(evaluate('return Array.from(window.lastBytes);')));
  check('Real export preserves page order, filename and exact page boxes', () => {
    assert.equal(evaluate('return window.downloads[0].name;'), '工作台回归样例.pdf'); assert.equal(pdf.getPageCount(), 2);
    const mm = 72 / 25.4, first = pdf.getPage(0);
    assert.ok(Math.abs(first.getTrimBox().width - 90 * mm) < 0.01);
    assert.ok(Math.abs(first.getTrimBox().height - 54 * mm) < 0.01);
    assert.ok(Math.abs(first.getBleedBox().width - 94 * mm) < 0.01);
    assert.ok(Math.abs(first.getBleedBox().height - 58 * mm) < 0.01);
    assert.ok(Math.abs(pdf.getPage(1).getTrimBox().width - 210 * mm) < 0.01);
  });
  check('Typing decimal print dimensions does not reset the draft mid-entry', () => {
    inFrame('fill', '#setting-bleedMm', '');
    for (const key of ['2', '.', '3', '5']) browser('press', key);
    assert.equal(value('bleedMm'), '2.35');
    browser('press', 'Tab');
    wait('store.pk_settings.bleedMm === 2.35');
  });
  check('Color editing preserves spaces in spot names and exact CMYK overrides', () => {
    route('check');
    inFrame('find', 'role', 'tab', 'click', '--name', '颜色');
    wait('d.querySelectorAll(".color-list [role=radio]").length === 5');
    inFrame('find', 'role', 'radio', 'click', '--name', '#E30613'); settle();
    segment('颜色', '专色');
    inFrame('fill', '[id="spot-#E30613"]', '');
    for (const part of ['PANTONE', '186', 'C']) {
      if (part !== 'PANTONE') browser('press', 'Space');
      inFrame('type', '[id="spot-#E30613"]', part);
    }
    browser('press', 'Tab');
    wait('store.pk_settings.overrides["#E30613"]?.spot?.name === "PANTONE 186 C"');
    inFrame('find', 'role', 'radio', 'click', '--name', '#00A0E9'); settle();
    segment('颜色', '自定义 CMYK'); fill('color-#00A0E9-c', 35.7);
    wait('store.pk_settings.overrides["#00A0E9"]?.cmyk?.c === 35.7');
    evaluate('d.querySelector(".cedit [role=slider]").focus();'); browser('press', 'End');
    wait('store.pk_settings.overrides["#00A0E9"]?.cmyk?.c === 100');
    assert.equal(evaluate('return d.getElementById("spot-#E30613");'), null);
  });
  console.log(`PASS: ${checks} workbench regression checks; downloaded PDF has 2 pages and expected page boxes.`);
} finally { browser('close'); }
