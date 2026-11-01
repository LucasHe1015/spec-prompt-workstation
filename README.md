# S.P.E.C. 7 提示词编辑与创作工作站

> **S.P.E.C. 7 (Station for Prompt Editing & Composition)** · Copyright (C) 2026 LucasHe1015
> 以 **GNU GPL v3 或更新版本** 授权（SPDX: `GPL-3.0-or-later`）——再分发须保留作者版权声明与 [NOTICE](NOTICE)，衍生作品须同样开源。详见 [LICENSE](LICENSE)。

S.P.E.C. = Station for Prompt Editing & Composition。

用于英文绘图提示词的翻译和对照编辑，支持词块联动、反向翻译、历史与收藏、角色卡、预设词组和画廊。前端无需构建，服务端仅使用 Python 标准库。

## 启动

**免安装（推荐）**：双击项目根目录的 `SPEC7.exe`（或从 [Releases](https://github.com/LucasHe1015/spec-prompt-workstation/releases) 下载）。服务在 127.0.0.1:8765 起站、自动打开浏览器；关掉控制台窗口即停站。exe 已内嵌前端资源与图标（`design/icons/spec-7.ico`），不需要系统 Python；首次运行会在 exe 同目录生成 `data/` 与 `user_data/`。旁边若有 `public/` 目录则优先读取它，方便热改前端。

exe 是单文件打包（onefile），启动时要把自身解包到临时目录。解包位置固定在 exe 旁边的 `.runtime/`（`build_exe.py` 的 `RUNTIME_TMPDIR`），不使用系统 `%TEMP%`——某些 Windows 启动上下文拒绝在 `%TEMP%` 建目录，会直接报 `Could not create temporary directory!` 并闪退。`.runtime/` 随 exe 自动生成，删掉无害，下次启动重建。万一双击没反应，在项目根开一个 cmd 运行 `SPEC7.exe --port 8765 --no-browser`，控制台会留下完整报错。

`SPEC7.exe`、`.runtime/` 与发布包是构建产物，不放进 git 仓库，只随 Releases 分发；自行打包见下。

**源码模式**（改服务端时用）：安装 Python 3.10+，双击 [启动SPEC7.bat](<启动SPEC7.bat>)（仓库里唯一的启动脚本：同目录有 `SPEC7.exe` 就跑 exe，没有才退回 Python 源码模式），或运行：

```sh
python server.py --port 8765 --no-browser
```

**自行打包 exe**：需要 Python 3.13 + `pip install pyinstaller`，然后

```sh
py -3.13 publish/_build/build_exe.py --force      # 产出 publish/_build/dist/SPEC7.exe
py -3.13 publish/_build/build_release.py --force  # 生成 publish/SPEC7-<version>/ 与 zip、清单、校验和
```

浏览器打开 <http://127.0.0.1:8765>。若端口被占用，服务会尝试后续 9 个端口，以终端显示地址为准。修改服务端代码后需要重启；修改前端后刷新页面。

## 使用

- 在引擎舱选择 Ollama、LM Studio / OpenAI 兼容接口、LibreTranslate、Chrome 内置翻译或离线词条库。
- 输入英文，以逗号分隔词条，空行后可写自然语言；按 `Ctrl + Enter` 翻译。
- 译文与原文词块可对应编辑、删除和排序；修改原文后按 `Ctrl + Enter` 或停止输入 5 秒会同步翻译。
- 历史自动保留最近 25 条；需要长期保存时加入收藏。角色卡、预设和画廊可在侧栏管理。
- 角色卡组合区支持「＋ ADD」：输入自定义词块后直接保存到当前组合；组合中的自定义词块可点 × 移除，组合内的组名块也可点 × 移出组合（不会删除分组）。
- 角色卡界面新增「衣柜」页：双列卡片左侧展示用户上传的衣物示意图，卡片下方提供大号「编辑」「复制到剪贴板」；编辑直接在原卡片内完成，不打开新页面；末尾「添加新作品」占位卡打开新建界面，新建界面提供粘贴剪贴板并支持更大的编辑区域；支持拖动排序、右上角 × 删除；四个衣物卡按 2×2 铺满可视区域，上下留白一致；翻译台输入框、原文栏和角色组合区均可插入衣柜内容；固定词条旁也提供衣柜折叠卡；衣柜数据、示意图和排序索引分别保存在 `user_data/wardrobe/`、`user_data/wardrobe/preview/` 和 `user_data/wardrobe/order.json`。
- 会话栏最多同时打开 10 个会话；达到上限时 `+ NEW` 按钮隐藏，关闭任意会话后自动恢复。
- 翻译进行中点击「卸载模型」会先强制终止当前翻译，再请求 Ollama 卸载模型释放显存；复制原文也会自动卸载。
- 清空输入、关闭会话、删除记录/角色卡/画廊作品/词条/预设/分组，以及上传或更换角色肖像、收藏示例图、画廊预览图后，可按 `Ctrl + Z` 撤回；会话名、收藏标题、角色分组名和预设名的重命名也可撤回。服务端删除的撤回凭据仅在本次服务运行期间有效。
- Chrome 内置引擎需要兼容浏览器，首次使用可能需要联网下载语言模型；离线词条库仅覆盖已收录词条。
- 界面带机械仪表风格的过渡动效：左侧模块切换有四色滑轨滑块与视图进场、面板分栏级联、折叠条弹入、引擎舱/确认框/提示滑入、列表逐项浮现等。系统开启「减少动态效果」时自动降级为瞬时切换。
- 浅色 / 深色两套配色：右上角的太阳 / 月亮按钮切换，切换时从按钮位置圆形展开（等价的「关灯」动作），选择保存在 `localStorage` 的 `spec7:theme`。深色不是反相的霓虹主题，而是同一套 NASA-punk 语言的「夜班」版本：暖炭黑纸、米白油墨、四色身份条与唯一红色强调色都保留。

## 隐私与数据

**本机运行不等于所有配置都离线。** 默认引擎地址指向本机；若改成远端地址，待翻译内容会发给该服务。自动引擎会探测配置的接口，编辑后自动翻译也会使用所选服务。请只配置可信端点；远端连接优先使用 HTTPS。

- `config.json` 保存本机引擎配置；填写的 API Key 会明文保存在本机，配置 API 不回显密钥。不要分享此文件；它由程序在首次运行时生成，不进入仓库。修改 API 服务地址时请重新输入密钥；服务不会把旧密钥转发到新地址。
- `user_data/` 保存历史、收藏、角色卡、预设、画廊和衣柜，包括完整提示词、译文、图片及时间信息。图片也可能自带生成参数或其他元数据。
- 浏览器 `localStorage` 中的 `spec7:draft` 保存原文草稿，刷新后可以恢复。共享电脑时应清理该站点的浏览器存储；这不会删除磁盘历史和收藏。
- 顶部仪表读取并展示本机硬件占用、显卡名称和内存/显存容量；共享屏幕时注意遮挡。
- 为避免转发密钥与提示词，服务拒绝引擎接口跨来源或降级重定向；遇到重定向报错时，请直接填写可信服务的最终地址。
- 服务仅监听 `127.0.0.1`，并校验请求来源；页面响应禁止被其他站点嵌入（`X-Frame-Options: DENY` / `frame-ancestors 'none'`），降低点击劫持风险。不要通过反向代理、隧道或端口转发对外暴露；它不提供同机用户之间的身份隔离。
- 代码不内置统计上报；具体翻译服务的数据保留政策由服务提供方决定。

## 隐私自检

```sh
python -m unittest -v test_privacy
```

测试覆盖本机来源校验、重定向、记录路径、密钥脱敏、错误信息脱敏、端点变更时密钥不转发，以及导出白名单和空词条库。

## 分享源码

**不要直接压缩整个项目目录。** 使用：

```sh
python export_source.py
```

[导出工具](<export_source.py>) 在 `dist/` 创建白名单源码 ZIP，不包含本机配置、用户数据、截图、模型权重或版本历史。为了避免带出自定义词条，导出包使用空词条库；接收者可以自行添加词条或连接翻译引擎。本地词条库和数据不变。

[忽略规则](<.gitignore>) 排除本机配置、用户数据、截图、模型权重与打包产物，只防止未跟踪文件被 Git 意外添加，**不能移除已跟踪文件、旧提交或已发布附件中的隐私信息**。若过去公开过密钥，应撤销并更换；公开前还应检查待分享源码是否新增了私人内容。

## 主要文件

- [server.py](<server.py>)：本地 HTTP 服务、翻译接口与数据存储。
- [public/index.html](<public/index.html>)、[public/app.js](<public/app.js>)、[public/styles.css](<public/styles.css>)：页面、交互与样式。
- 动效层：[public/motion.js](<public/motion.js>) 提供 `SPECMotion` 动画助手（显示/隐藏、折叠、级联、按压反馈，`prefers-reduced-motion` 下自动瞬切）；[public/motion-core.css](<public/motion-core.css>) 定义时长/缓动令牌与公共关键帧，[motion-nav.css](<public/motion-nav.css>)、[motion-panels.css](<public/motion-panels.css>)、[motion-overlays.css](<public/motion-overlays.css>) 分别承载侧栏与视图、面板与列表、浮层与弹窗的动效。改动约定见 [MOTION_SPEC.md](<MOTION_SPEC.md>)。
- 配色层：[public/styles.css](<public/styles.css>) 里的每个颜色字面量都已收敛成语义 token（`--paper`、`--ink`、`--face-*`、`--sh-*`、`--hl-*`、`--veil-*` 等）；[theme-dark.css](<public/theme-dark.css>) 只重映射这些 token 的深色取值，[theme.css](<public/theme.css>) 承载切换按钮、圆形展开的 View Transition 与少量深色修正，[theme-dark-states.css](<public/theme-dark-states.css>)、[theme-dark-overlays.css](<public/theme-dark-overlays.css>) 补齐深色下的交互状态与浮层细节，[theme.js](<public/theme.js>) 负责切换与持久化。新增颜色请写成 token 引用，否则深色主题无法跟随。
- `data/glossary.json`：可编辑的本地词条库（9144 条，已随仓库入库，基于公开的 Danbooru tag 词表）。改词条可直接编辑它，或改 `data/parts/*.json` 分片后用 [tools/build_glossary.py](<tools/build_glossary.py>) 从 `data/selected_tags.csv` 与分片重新合成（重建需 `pip install pypinyin`）；`data/parts/zz_base.json` 收纳 CSV 之外的通用词条，是手工补充词表的落点。

## 许可证与署名

- **代码**：GNU General Public License v3.0 or later（`GPL-3.0-or-later`），全文见 [LICENSE](LICENSE)。
- **署名**：Copyright (C) 2026 LucasHe1015。再分发时必须保留本版权声明、[NOTICE](NOTICE) 文件与各源文件头部的 SPDX 标识。
- **文档与截图**：CC BY 4.0，须注明出处。
- **说明**：GPL-3.0 属 copyleft 许可，分叉后公开发布修改版必须同样以 GPL-3.0 开源并提供对应源代码，同时保留原作者版权声明。若需在闭源产品中使用，请单独联系作者获取商业授权。
