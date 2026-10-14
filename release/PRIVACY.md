# Inkpaper 纸墨 · 隐私与存储说明

生效日期：2026-10-13。联系：onevalar@gmail.com。

Inkpaper 不运行开发者后端，不提供插件账号，不向开发者发送设计稿、ICC、导出文件、使用分析或遥测。清单声明 networkAccess.allowedDomains 为 ["none"]，色彩转换与文件处理代码随插件打包。

为执行用户操作，插件读取所选画板及相关图层的内容、图片、文字、字体信息、尺寸、颜色和印刷设置。处理后的输出通过用户发起的下载保存。导出需要时使用临时副本，修改原稿的工具由用户点击触发。

ICC 文件、导入色板、颜色映射、预设与偏好使用 figma.clientStorage 保存。ICC 与色板可在对应资源界面删除；预设及映射可在管理界面删除；偏好更新会替换旧设置。当前没有一键清除全部插件存储的功能。常规预设 JSON 导出只包含方案和颜色映射，不包含 ICC 或色板。另行主动导出的完整迁移备份会包含 ICC、色板、偏好和当前文件的私有印刷信息；导入仅用于同一文件的新旧插件身份迁移。备份应私下保管，不公开分享。迁移使用文件中的共享随机标记核对来源，不向开发者传输数据。

通过 setPluginData 写入的画板成品尺寸、出血、安全区等印刷信息、逐图层文字输出模式、页码和色卡标注数据，以及用户主动保存到文件的颜色映射，属于 Figma 文件中的插件数据。它们随文件保存、复制及协作，而不是仅保存在本机。插件 ID 改变后，不保证新插件能读取旧 ID 的私有数据。

插件设置中的 ICC 帮助链接会打开第三方网站；邮件支持链接会打开邮件应用。访问第三方页面或主动发送邮件由用户发起，适用第三方服务的隐私规则。支持邮件只用于处理用户问题，请避免附带保密设计文件。

上述说明描述 Inkpaper 的行为，不代替 Figma 自身对账号、文件存储及协作的隐私政策。

English: Inkpaper operates without a developer backend, plugin accounts or telemetry. It sends no designs, ICC profiles, exports or usage logs to the developer. Processing runs locally, with network access disabled in the manifest. The plugin reads selected frames and related layer data to perform requested actions. ICC profiles, swatches, mappings, presets and preferences use Figma clientStorage. Frame print metadata, per-layer text modes, page-number/swatch annotations and explicitly saved mappings use Figma file plugin data and may be shared with that file. Resource entries can be deleted in their corresponding management views; there is currently no single clear-all-storage control. Ordinary preset JSON export excludes ICC profiles and swatches. A separately requested full migration backup includes ICC profiles, swatches, preferences and private print metadata from the current file. Keep it private. Migration uses a shared random file marker to check the source and sends no data to the developer. Changing the plugin ID may make old private plugin data inaccessible to the new ID. External help links and support emails are user initiated and subject to the respective services’ policies. Figma’s own account, storage and collaboration practices remain governed by Figma. Contact: onevalar@gmail.com.
