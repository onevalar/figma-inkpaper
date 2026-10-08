# Inkpaper 纸墨：竞品调研与功能对照

更新日期：2026-10-07
调研范围：Figma Community 中所有与印刷、CMYK、出血、拼版、刀版、PDF 导出相关的插件，共 48 个。资料来源是各插件在 Figma Community 的完整说明。

## 1. 主要竞品

| 插件 | 用户量 | 收费方式 | 处理位置 | 代表性功能 |
|---|---|---|---|---|
| Print for Figma | 26.9 万 | 免费版每周 5 次，Pro ≈ $9.6/月 | 服务器 | ICC 转 CMYK、颜色映射、出血裁切线、DPI 检查、多页、预设 |
| Printery（原 Printify / PrintX） | 5.9 万 | 免费版终身 3 次导出，Pro 付费 | 联网 | ICC、潘通专色与浓度、叠印、对页、页边距安全区 |
| MKitFPdf | 2.9 万 | 每月 5 次，付费无限 | 本地 | 可选中文字、书签目录、PDF 页面框、元数据 |
| i Print CMYK PDF | 2.3 万 | 免费 | 本地 | 地区纸张、CMYK 预览、预检、上传 ICC |
| Export & Resize Images | 2.1 万 | 免费 | 本地 | TIFF、CMYK、DPI、按印刷场景预设 |
| Printify（NamlSoft） | 1.6 万 | 点数 / 订阅 | 服务器 | 版式、CMYK 导出、链接页 |
| Print Prep | 1.6 万 | 免费 | 本地 | 2×2 拼到 Letter / Tabloid 并加裁切线 |
| PrinTriX | 1.1 万 | 免费 | 服务器 | 渲染意图、TAC、颜色映射、文字转曲 / 真实文字、预检、刀版自动识别、PDF/X、自动修复 |
| Figma for Print | 9.9 千 | 免费 | 本地 | 多种单位、按 DPI 建画板、尺寸测量 |
| Units to Pixels | 6.9 千 | 免费 | 本地 | CSV 批量建画板、TIFF CMYK |
| CMYK Print Toolkit | — | 免费 | 本地 | CMYK 取色、Japan Color 软打样、常用物料尺寸 |
| XPrint for Figma | 3.8 千 | 免费 | 本地 | 品牌色锁定、TAC 热力图、软打样对比滑块、分色查看、多种四色黑、PDF/X-1a/X-4 |
| CMYK Exporter（Utkarsh） | 2.4 千 | 免费 | 本地 | 四边出血、1200 DPI、TIFF + PDF |
| PrintPlix | 3.0 千 | 15 次试用 | 本地 | 四色黑小字检测与修复、出血覆盖检查、刀版标记、刀版单独文件 |
| Printly | 1.8 千 | 免费 | 本地 | PDF/X-4、X-1a、PDF 1.7，潘通参考，变量 / 样式联动 |
| Typeport | 899 | 免费 + Pro | 本地 | 真实可选文字、书签、密码 |
| PRINT LAB | 618 | 免费 | 本地 | 骑马钉拼版（含从右往左）、专色叠印、同时出 CMYK / RGB |
| PDF Export Pro | 8 | 免费 | 本地 | 一版多拼、正反面、压缩档位、色标条 |
| Prink | 107 | 免费 | 本地 | 0–100 评分、ΔE 色域检查、纸张模拟、替换低清图 |
| Print Studio PRO | 129 | 付费 | 本地 | RAL / HKS 专色、按颜色指定刀线、PDF/X-3/X-4 |
| Print Ready（on-device） | 81 | $9.99/月 | 本地 | 骑马钉、2-up、按 300DPI 画板缩回实际尺寸、图片放大 |
| Box Dieline Generator | 22 | 免费 | 本地 | 插舌盒、托盘盒、飞机盒刀版生成 |
| Paginate | 4.0 万 | 免费 | 本地 | 页码 |
| Color Swatch Info | 131 | 免费 | 本地 | 色卡标注 HEX / RGB / CMYK / 潘通 |
| 其他 | | | | Frames to One PDF、PDF Merger、Compressed PDF Export、Print Ruler、PrintFrame、PrintSwift 等，功能已被以上覆盖 |

## 2. 功能对照

✅ = Inkpaper 已具备，并且所有功能都在本地完成，不上传设计稿。

### 文档与版面
| 功能 | 来源 | Inkpaper |
|---|---|---|
| 标准纸张预设（A / B 系列、国内开本、北美、名片、明信片、海报、易拉宝、X 展架、吊牌、领标、贴纸、T 恤印花、邀请函、门票） | 多数插件 | ✅ |
| 自定义尺寸，并保存为常用尺寸 | Print for Figma、Printery、PrintFrame | ✅ |
| mm / cm / 英寸 / pt 单位 | Figma for Print、Units to Pixels | ✅ |
| 出血、页边距、安全区、折线参考线（对折、三折、Z 折、关门折） | Printery、TinyImage | ✅ |
| 四边出血分别设置 | CMYK Exporter、Print Frame with Bleed、PRINT LAB | ✅ |
| 对页排列 | Printery | ✅ |
| CSV 批量建画板 | Units to Pixels | ✅ |
| 给已有画板加出血，贴边元素自动延伸；画板出血比导出设置少时提醒，并可一键补足 | Print for Figma、PrintPlix | ✅ |
| 按 300DPI 像素做的画板一键缩回实际尺寸 | Print Ready（on-device） | ✅ |
| 超大幅面按比例制作（1:2 – 1:10），导出时自动放大 | PrintSwift | ✅ |
| 实物尺寸测量与修改（宽高、字号、描边、圆角） | Print Ruler、Figma for Print | ✅ |

### 颜色
| 功能 | 来源 | Inkpaper |
|---|---|---|
| CMYK / RGB / 灰度输出 | 全部 | ✅ |
| ICC 色彩转换，可导入任意 ICC | Print for Figma、PrinTriX、XPrint | ✅ |
| 四种渲染意图、黑场补偿 | PrinTriX、CMYK Exporter | ✅ |
| 扫描文档颜色，显示 CMYK、总墨量、使用次数、样式 / 变量名 | PrinTriX、Printly | ✅ |
| 逐个颜色指定 CMYK、保存颜色映射表 | Print for Figma、PrinTriX、XPrint | ✅ |
| 颜色映射表存进 Figma 文件，团队共用 | PRINT LAB | ✅ |
| 专色（潘通等）、浓度、专色策略（保留 / 转四色 / 只保留指定的） | Printery、PrinTriX | ✅ |
| 导入色板库（.ase / CSV），自动找最接近的专色 | Printly、Print Studio | ✅（用户自备色板，不内置潘通） |
| 纯黑转单色黑、灰色只用 K、多种四色黑配方 | XPrint、PrintPlix | ✅ |
| 总墨量上限，超限自动压回 | PrinTriX、XPrint | ✅ |
| 叠印、黑色自动叠印、去掉白色叠印 | Printery、PrinTriX | ✅ |
| 整页印刷模拟、对比滑块、C / M / Y / K 单色版、墨量热力图、超色域标红、纸张白模拟 | XPrint、Prink、Print Studio | ✅ |
| 按 CMYK 数值上色 | CMYK Color Picker、CMYK Print Toolkit | ✅ |
| 色卡标注（HEX / RGB / CMYK / 专色名 / 样式名） | Color Swatch Info | ✅ |

### 文字
| 功能 | 来源 | Inkpaper |
|---|---|---|
| 保留可选中、可搜索的文字（含中文） | Typeport、MKitFPdf | ✅（实测 PDF 可提取中文文字） |
| 按图层选择转曲 / 保留文字 | PrinTriX、XPrint | ✅ |
| 缺字体、带效果文字提示 | PrinTriX | ✅ |

### 预检
| 功能 | 来源 | Inkpaper |
|---|---|---|
| 图片实际分辨率，低于阈值时提醒或禁止导出 | Print for Figma、PrinTriX | ✅ |
| 出血不足、安全区、细线、小字号、混合模式、注释 | PrinTriX、i Print | ✅ |
| 近黑色小字会印成四色黑，可一键改为单色黑 | PrintPlix | ✅ |
| 超色域颜色（ΔE） | Prink、i Print | ✅ |
| 0–100 评分 | Prink | ✅ |
| 低清图片放大 2 倍、替换图片并保留裁切 | Print Ready、Prink | ✅ |

### 包装
| 功能 | 来源 | Inkpaper |
|---|---|---|
| 按图层名识别刀线、折线、压痕、打孔、光油、白墨、烫金，各自输出为专色版并叠印 | PrinTriX | ✅ |
| 刀线输出为真正的单线路径（Figma 原生导出会变成双线） | Print Studio | ✅ |
| 按颜色指定刀线 / 工艺版 | Print Studio | ✅ |
| 刀版单独导出一个 PDF | PrintPlix | ✅ |
| 纸盒刀版生成（插舌盒、托盘盒、飞机盒） | Box Dieline Generator | ✅ |

### 导出
| 功能 | 来源 | Inkpaper |
|---|---|---|
| 多页合并 / 每页单独文件、拖拽排序、缩略图 | 多数插件 | ✅ |
| 裁切线、套准标记、色标条、成品框线 | Printery、PDF Export Pro、Print Ready | ✅ |
| PDF/X-4、PDF/X-1a、PDF/X-3、普通 PDF | XPrint、Printly、Print Studio | ✅（X-1a / X-3 下含透明效果的页面会自动整页拼合） |
| CMYK TIFF、CMYK JPEG、带 DPI 的 PNG / JPG（150–1200 dpi） | CMYK Exporter、PrintPlix、PrintLab | ✅ |
| 拼版：对页跨页、骑马钉（含从右往左）、一版多拼（含印数）、正反面 | PRINT LAB、PDF Export Pro、Print PDF Exporter | ✅ |
| 图片降采样、压缩档位（轻度 / 均衡 / 强力 / 自定义） | Print for Figma、PDF Export Pro | ✅ |
| 书签、作者 / 主题 / 关键词 | MKitFPdf、Typeport | ✅ |
| 保留超链接、打开密码（AES-256） | TinyImage、Typeport | ✅ |
| 同时导出 RGB 屏幕版 | PRINT LAB | ✅ |
| 输出缩放 | Print for Figma | ✅ |
| 导出编组、分区，不限于画板 | XPrint | ✅ |
| 导出预设、预设与颜色映射的 JSON 导入导出 | Print for Figma、Print PDF Exporter | ✅ |
| 设置汇总标签 | PrinTriX | ✅ |

### 界面
| 功能 | 来源 | Inkpaper |
|---|---|---|
| 多语言 | PrintLab（12 种）、PDF Export Pro、CMYK Print Toolkit | ✅ 8 种：简体中文、繁體中文、English、日本語、한국어、Español、Deutsch、Français；默认跟随系统语言，可手动切换 |
| 深色 / 浅色主题 | CMYK Print Toolkit | ✅ 跟随 Figma |
| 按流程组织的界面（准备 → 检查 → 导出），专业设置打包成「印刷方案」 | — | ✅ 界面 v2，视觉沿用定制组件库的 Linear 主题 |

## 3. 不做的功能

| 功能 | 原因 |
|---|---|
| CMYK 半调网点、分色图层等艺术效果（CMYK Halftone、CMYK It!、Channel Separator） | 属于视觉特效，不是印前输出 |
| 把 Figma 评论写进 PDF（MKitFPdf） | Figma 不对插件开放读取评论的接口 |
| 内置潘通色库 | 潘通色值受版权保护；改为导入用户自己的色板文件（.ase / CSV） |
| AI 评论总结、图标库、PSD / AI 导入、HTML 转设计（Waysorted）；GIF / 视频导出（TinyImage） | 与印刷导出无关 |
| 账号、付费、点数系统 | 本插件不收费 |

## 4. 许可

- Adobe ICC 配置文件的许可不允许打包进软件，所以插件不内置这些文件，由用户自行导入。导出的 PDF 内嵌配置文件是许可允许的。
- 用到的第三方库都允许商用，均为 MIT 许可：
  - 颜色引擎 LittleCMS
  - PDF 处理 pdf-lib、pako
  - 繁体中文转换 OpenCC
  - PDF 加密 noble-ciphers、noble-hashes
