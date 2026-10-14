# Figma 发布草稿记录

2026-10-13，在 Figma 桌面版的实际 Publish plugin 表单中准备，未点击最终 Publish，未提交审核，未接受发布协议。

- 名称：Inkpaper 纸墨
- 简介：Prepare print layouts, check risks and export CMYK files locally in Figma.
- 详细说明：已填 LISTING.md 的 English description，包含限制、隐私和支持方式。
- 分类：Design tools → Import & export
- 标签：PDF 已选。自定义关键词仍可按 LISTING.md 添加；不影响必要字段完成。
- 图标：icon-128.png 已加入。
- 封面：cover-1920x1080.png 已加入。
- 轮播：01-export、02-dark、03-check 三张已加入，保留模拟数据说明。
- 可选安全披露：未勾选对外分享；没有提交未经验证的安全认证。PRIVACY.md 已准备真实说明。
- 署名：当前个人身份 OneValar，未使用 NEXT 或 TEST 团队。
- 支持邮箱：onevalar@gmail.com。
- 评论：保留默认开启。
- 正式插件 ID：1691712698137473867（在 Generate ID 操作后由 Figma 实际分配，非自行编造）。
- Network：No network access。
- 收费：未启用收费选项，按免费首发准备。

根 manifest 与正式包均已使用正式 ID。实际插件导出的身份为 1691712698137473867；旧版 ICC、偏好和 16 个图层信息已导入、重新打开并逐项比对一致，见 checks/migration-evidence.json。

此前表单曾关闭以完成真实插件重载；本轮已重新填写并上传新版图片。未提交字段不保证长期保留，提交前请保持当前表单打开。

## 本轮重新填表状态

项目目录已由 figma-presskit 改为 figma-inkpaper。已在 Figma 从新路径 `/Users/anvalar/Documents/个人项目/figma-inkpaper/manifest.json` 导入，收到插件已导入的界面提示；正式 ID 未重新生成。表单字段值整理在 form-values.json，新版 5 张图片尺寸与哈希见 checks/form-assets.json。

本轮已在实际 Publish plugin 表单中重新填写名称、74 字符简介和完整英文说明，核对了段落格式、限制、隐私及支持方式；分类 Import & export，标签 PDF。已上传图标、封面及 3 张新版轮播图，预览核对无重复。

当前停在 Add the final details 最终步骤。界面确认 OneValar 个人身份、onevalar@gmail.com、正式 ID 1691712698137473867、No network access、评论开启。未启用收费，未勾选可选安全披露。没有点击最终 Publish，没有接受发布协议，未提交审核。

证据：checks/figma-new-images-form.png、checks/figma-final-publish-form.png、checks/figma-final-form-ax.txt、checks/figma-form-verification.json。

边框修复补充：修复行控件误用 outline 圆角造成的分隔线断边；发布包已重建，浅深色 UI 与展开/收起、资源管理行检查通过，商店表单中的 3 张轮播已再次替换为修复版，仍停在最终步骤，未点击 Publish。已打开的开发插件实例需重新运行才能加载新构建。
