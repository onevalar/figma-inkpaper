# Inkpaper 纸墨 · 首发检查报告

2026-10-13。正式 ID、当前测试文件的旧数据迁移、PDF/X 本地检查已完成；界面已迁移为 Arc 组件（2026-10-14），在 Figma 真实环境中的界面验收需对 Arc 版本重做。Arc 界面完成真实 Figma 验收前，不建议提交审核；最终表单核对、协议接受及提交仍由用户执行。没有点击最终 Publish。

## 本轮验收

| 项目 | 结果 / 证据 |
|---|---|
| 正式身份 | 根清单和发布包均为 Figma 分配的 `1691712698137473867`。真实插件导出备份的 sourceId 与此一致 |
| 完整迁移 | 原 `presskit-print-export-local` 的 4 项存储（含 ICC 二进制、偏好和色板）与 16 个图层元数据导入正式身份后逐项相同；重新打开后 90×54 mm 名片、3 mm 出血、ICC、中文偏好与原文件名恢复。见 checks/migration-evidence.json |
| 私有备份 | release/private 已被 git 忽略；原旧版数据保留；其他文件通过 manifest.legacy.json 的同文件迁移流程处理，不宣称所有 Figma 文件自动迁移 |
| 迁移异常回归 | 非法二进制、错误文件、缺失图层、幂等导入、存储失败回滚均通过 test/migration.mjs |
| 导出保护 | 8 项成功/异常路径测试通过，包括 clone/包裹/实例分离/flatten/PDF 导出异常清理、刀线提取失败及文字转曲失败。失败时停止输出，不静默漏掉内容 |
| 导出回归 | run / features / features2 / raster / variants 五组完成，覆盖颜色、栅格、拼版、比例、标记与 PDF/X 等输出；执行成功不等于独立印刷认证 |
| 本地 PDF/X | 3 种输出与 10 类损坏条件检测通过，见 checks/pdfx-local-preflight.json。修复 PDF/X 同时写 TrimBox/ArtBox，拒绝无 ICC 或非 CMYK 的 PDF/X 输出 |
| 正式身份真实导出 | PDF/X-4 样张 checks/inkpaper-official-x4.pdf：qpdf 无语法/流错误，本地针对性预检无问题，TrimBox=90×54 mm、BleedBox=96×60 mm；显式 ArtBox 已移除，Poppler 渲染目视核对通过。见 checks/real-figma-pdfx.json |
| 真实界面 | **待重做**：以下带截图的验收是 Hero UI 版本（2026-10-13）。界面改为 Arc 后需在真实 Figma 中重新核对，并恢复原印刷偏好。临时验收 PDF/X-4 设置后曾恢复原文件名 t-rollup 与普通 PDF 偏好 |
| 界面组件库 | 2026-10-14 起使用 Arc（uiarc.dev，`@uiarc` 注册表），源码复制在 `src/components/arc`，保留其 LICENSE，开源许可页已列入。此前的定制 HeroUI v3 方案已弃用（本地备份分支 `local-herou-release-prep`，不得发布） |
| 组件回归 | 修复组合卡片高度、主按钮宽度、控件前景色、主题初始化，以及 React 保留文本导致的跨语言混杂。语言翻译在 React 渲染前完成 |
| 八种语言 | 设置页顺序切换 8 种语言后标题与返回按钮正确，回到简中正确；480 px 宽下无横向溢出。见 checks/components-locales.json （Hero UI 版本记录；Arc 版本待重新验证，原证据文件已不随仓库保留） |
| 交互与风险限制 | 输入文件名、复选框、单位换算 3 mm→0.3 cm、英文标签均验证。无 ICC 的 PDF/X 在导出前明确拒绝；启用最低分辨率限制后，接受风险仍停止输出并返回检查页。见 checks/components-low-ppi.jpg （Hero UI 版本记录；Arc 版本待重新验证，原证据文件已不随仓库保留） |
| 依赖与许可 | 完整许可内联并放入包内。安装树仍有已知漏洞，不能宣称 0 漏洞；正字节 esbuild 输出与 npm 直接公告交集为空，Tiptap/maplibre/katex 等未进入运行包。见 checks/npm-audit-components.json、checks/runtime-audit-scope.json |
| 隐私 | allowedDomains=["none"]，颜色转换与导出本地执行；如实说明插件存储、随文件分享的印刷元数据与主动迁移备份。不分发用户 ICC 或商业色库 |
| 支持 | 用户确认 onevalar@gmail.com，插件帮助、商店文案与隐私说明一致；不依赖公开返回 404 的旧仓库帮助链接 |
| 素材 | 图标 128/512 px、封面 1920×1080、3 张更新后的实际组件界面轮播；模拟样例明确标注，不当作真实 Figma 文件验收证据 |
| 发布包 | 四文件白名单：manifest.json、dist/code.js、dist/ui.html、THIRD_PARTY_NOTICES.txt；无 ICC 原文件、私有迁移备份、测试稿、node_modules、源码或账号数据。当前 SHA-256 见 package-report.json |

## 提交时仍需本人完成

1. 重新打开/核对发布表单，使用 LISTING.md、PRIVACY.md 和更新后的轮播图；不能假定此前关闭的未提交表单长期保存。
2. 确认署名、免费选项和支持邮箱；按登录方式完成 Figma 实际要求的账号验证，勿为了猜测的 MFA 要求贸然更改登录方式。
3. 本人阅读接受协议，并决定是否最终 Publish；随后等待 Figma 审核。此准备任务没有代为接受协议或提交。

## 验证边界与补充测试

商业 PDF/X 验证器不是 Figma 上架条件。本轮未完成 callas/Acrobat 独立认证，也未做印刷厂打样；不能把本地检查宣传为完整 ISO 认证或保证送印。

真实 Figma 新身份检查以本报告的名片、迁移与输出证据为准。缺字体、团队库组件、极大文件、跨页复杂图层、用户中途关闭及全部画布工具仍是补充压力/边界测试，未以模拟测试冒充已在 Figma 逐项完成。详细扩展场景保留在 REAL_FIGMA_CHECKLIST.md。

原 test/fixtures/test.pdf 的 JPEG 对象 27 损坏；RGB 测试输出继承 qpdf 警告，未掩盖为通过。本轮正式 Figma 样张没有该问题。详见 checks/pdf-structure.json。
