# Inkpaper 纸墨 · 免费上架准备

2026-10-13。首发代码与材料已准备。未接受发布协议、未点击最终 Publish、未提交审核。支持邮箱：onevalar@gmail.com。

## 当前清单和构建

根 `manifest.json` 和 `release/package/manifest.json` 均使用 Figma 实际分配的正式 ID `1691712698137473867`。真实运行身份已通过导出的备份核对。界面使用 Arc 组件（源码在 `src/components/arc`，许可见该目录 LICENSE），样式与脚本均内联，不依赖 CDN。

```sh
npm run build
npm run typecheck
npm test
node test/migration.mjs
npm run test:exports
node test/pdfx-preflight.mjs
npm run release:prepare
node scripts/preview.mjs
```

导出回归需要自己合法取得的 `test/fixtures/JapanColor2001Coated.icc`；不分发该文件。发布包 `release/inkpaper-1.0.0-release.zip` 只包含 manifest、code.js、ui.html 和第三方许可。Figma 从 manifest 指向的构建文件提交；ZIP 是可展开导入的准备包，不是上传入口。

## 提交资料

- 商店文案：[release/LISTING.md](release/LISTING.md)。
- 隐私说明：[release/PRIVACY.md](release/PRIVACY.md)。
- 128 px 图标、1920×1080 封面和 3 张更新后的轮播图：`release/assets/`。
- 检查证据：[release/AUDIT.md](release/AUDIT.md)。

此前发布表单已关闭，不能假定草稿字段仍保留。重新核对名称、免费选项、个人发布身份、onevalar@gmail.com、分类和图片；使用本轮更新的截图。协议由本人阅读接受，最终 Publish 由本人执行或另行明确授权。提交后仍需等待 Figma 审核，不承诺固定审核时间。

## 旧版数据迁移

当前测试文件已经从 `presskit-print-export-local` 迁移到正式 ID：4 项存储和 16 个图层元数据逐项相同，含 ICC 二进制；重新打开后中文偏好、ICC、尺寸与文件名恢复。证据见 `release/checks/migration-evidence.json`。旧数据未删除。

其他旧 Figma 文件需要逐文件迁移：在旧 ID 的 `manifest.legacy.json` 中打开文件，设置 → 旧版数据迁移 → 导出完整迁移备份；在同一文件中运行正式 ID，再导入备份并重新打开。备份包含 ICC、色板、偏好和图层私有信息，导入会覆盖对应项；不要公开分享或用于上架。当前私有备份位于 git 忽略的 `release/private/`，不在发布包内。不得仅凭更换 ID 假定所有文件数据自动迁移。

## PDF/X 检查范围

三种 PDF/X 输出通过本地针对性回归，检测缺少输出意图、错误 ICC 通道、页面框冲突、字体未嵌入、透明度、RGB、动态内容与加密等条件。真实正式 ID 的 PDF/X-4 名片输出通过针对性预检、qpdf 和目视渲染。它们不是完整 ISO 合规认证。

callas 或 Acrobat 独立预检是可选增强验证，不是 Figma 上架条件；用户不需要为此注册账号。商店文案没有“已认证”或“保证送印”承诺，实际文件仍应由印刷厂确认。

## 官方来源（2026-10-13 核对）

- [发布 classic plugins](https://help.figma.com/hc/en-us/articles/360042293394-Publish-classic-plugins-to-the-Figma-Community)
- [审核规范](https://help.figma.com/hc/en-us/articles/360039958914-Plugin-and-widget-review-guidelines)
- [发布前边界情况](https://developers.figma.com/docs/plugins/publishing/)
- [manifest 与 ID](https://developers.figma.com/docs/plugins/manifest/)
