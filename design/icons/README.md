# S.P.E.C. 7 任务徽章（mission patch）

项目改名后重做的侧栏圆形徽章。NASA-punk：1970 年代 NASA 规范手册 +《星空》界面语气，
用「印刷贴纸」而非「发光控件」的方式表达身份。

第二轮修订按手绘批注改：**保留旧版徽章的框架**（无缝四色环、单条内圈细线、椭圆轨道、
`S.P.E.C.` 字样），**简化到两条信息**（`S.P.E.C.` + 数字 7），并把数字 7 换成顶栏 wordmark 里
那支 worm 式 7（同几何、等比缩放）。

## 文件

| 文件 | 用途 |
| --- | --- |
| `spec-7-patch.svg` | 徽章源文件（唯一事实来源，120×120 viewBox） |
| `spec-7-favicon.svg` | 浏览器标签图标源文件（32×32，几何按比例简化） |
| `spec-7.ico` | 多尺寸 Windows 图标（16/24/32/48/64/128/256，透明底） |
| `spec-7-256.ico` | 只含 256 单帧的 `.ico`（给只认一张图的场合用） |
| `spec-7-256.png` | 从 `.ico` 里单独取出的 256×256 帧（透明底 PNG，可直接当应用图标/头像） |
| `spec-7-patch-in-app.png` | 真实页面截图并排（左浅色 / 右深色）：徽章与顶栏 wordmark 的关系 |
| `tools/gen-patch.mjs` | 生成 `spec-7-patch.svg` + `spec-7-favicon.svg`（参数化，可 A/B） |
| `tools/sync-symbol.mjs` | 把 `spec-7-patch.svg` 同步进 `public/index.html` 的 `<symbol id="patch">` |
| `tools/make-favicon.mjs` | 由 favicon 源文件重新生成 `public/index.html` 里的 data URI |
| `tools/make-ico.mjs` | 从 `spec-7-patch.svg` 逐尺寸栅格化并打包 `spec-7.ico`（BMP 帧） |
| `tools/shot-app.mjs` | 用 CDP 截运行中的页面（亮/暗主题），避免 headless 虚拟时间卡在轮询上 |

## 应用里的接线方式

徽章以 SVG `<symbol>` 内联在 `public/index.html`（`<symbol id="patch">`，约第 50 行），
三处引用：

- `svg.patch` — 侧栏品牌徽章（62px；≤980px 断点 46px）
- `svg.watermark` — 主画布右下的大号水印
- `svg.watermark.watermark-card` — 角色卡上的水印

深浅主题不加画：徽章永远是米白纸面（`#ECE5D6`）的实体贴纸，深色主题只在
`theme-dark.css` 给 `.patch` 一道硬边投影。所以 SVG 里的颜色是写死的（不走 token），
改色时记得同时改 `spec-7-patch.svg`、`<symbol id="patch">` 和 favicon。

## 规格

- 盘面 `#ECE5D6`；墨线 `#221F18`；四色环 `#4C5A68` / `#7A7F4E` / `#D2A85E` / `#A8432F`
- 唯一鲜红 `#D63A2C`，只用在数字 7（与顶栏 wordmark 的红 7 同一支）
- 四色环：r 53、线宽 8，**四段无缝相接**，分界在 0° / 90° / 180° / 270°（12 点、3 点、6 点、9 点）
- 内圈：单条细线 r 44.5、线宽 1
- 轨道椭圆：rx 40 / ry 12 / -22°，线宽 0.9。沿**长轴**切成两段、分别画在数字 7 的前后：
  远侧半弧（上半）在 7 之前绘制 → 被 7 遮住；近侧半弧（下半）在 7 之后绘制 → 遮住 7。
  于是 7 看起来立在环里（手绘批注指定），而不是压在环上或垫在环下。
  两段都用三次贝塞尔近似（4 段/半圈）：旋转椭圆的 `A` 弧命令在「弦长 = 长轴」时是退化情形，
  各渲染器取弧方向不一致，实测 Chrome 会画到徽章外。
- 行星装饰：三颗实心墨点骑在轨道椭圆上，用椭圆参数化放位 `[[-10°, r3.6], [152°, r2.1], [65°, r1.5]]`
  ——右上那颗最大、正好停在轨道→内圈之间，左下与右下各一颗小行星；
  favicon（32px）**不画行星**，那个尺寸下行星点会被看成印刷脏点
- `S.P.E.C.`：Helvetica 700，字号 8，字距 1.2，基线 y=34（比原来的 4 字母多 4 个句点，
  字号和字距都要缩，否则会顶到内圈）
- 数字 7：直接复用顶栏 wordmark 的字形 —— 局部路径 `M0 0H23L9 35.5`，`stroke-width 9`、
  `stroke-linejoin round`、`stroke-linecap butt`，字形外框 32×44.5；徽章里按 46/44.5
  等比缩放到中心 (60, 67.5)。字标改了这里跟着改。
- 尺寸验收：62px 仍能读出 `S.P.E.C.` 与 7，46px 保住 7 与四色环
- 刻意没有加划痕/污渍等「做旧」纹理：容易被误读成渲染故障

## 重新生成

```bash
node design/icons/tools/gen-patch.mjs      # 改 spec-7-patch.svg + spec-7-favicon.svg
node design/icons/tools/sync-symbol.mjs    # 同步到 public/index.html 的 <symbol>
node design/icons/tools/make-favicon.mjs   # 同步 favicon 的 data URI
node design/icons/tools/make-ico.mjs       # 重新打包 spec-7.ico（7 帧）

# 只要单帧 256 的 .ico
SIZES=256 node design/icons/tools/make-ico.mjs design/icons/spec-7-256.ico
```

`gen-patch.mjs` 支持环境变量做 A/B：`SPEC_SIZE` `SPEC_LS` `SPEC_Y` `NUM_H` `NUM_CY`
`ORBIT_RX` `ORBIT_RY` `ORBIT_ROT`，`PLANETS=0` 关掉行星装饰，`OUT=<后缀>` 时输出到
`spec-7-patch-<后缀>.svg` 而不覆盖正式文件。

## 关于 .ico

- 7 个尺寸（16/24/32/48/64/128/256）**全部用完整徽章**（环 + `S.P.E.C.` + 椭圆 + 7），
  每个尺寸都由 Chrome 从 `spec-7-patch.svg` 矢量直接栅格化，不是缩放位图。
- 代价：16px 下 `S.P.E.C.` 会糊成一条灰点（7 和四色环仍然可辨）；128/256 完全清晰。
- 透明底：圆盘外围透明，深色桌面/开始菜单里不会出现白色方块。
- 帧格式是 **BMP（BITMAPINFOHEADER + 32bpp BGRA + AND 蒙版）**，不是 PNG 压缩帧：
  两种帧 Windows 都认，但 BMP 帧是 `ExtractIconEx` / 「更改图标」对话框 / 老式 shell
  路径的公共子集，兼容面最稳。已实测 `System.Drawing.Icon`、`ExtractIconEx`、
  `SHDefExtractIcon`（48 与 256）、`SHGetFileInfo` 全部通过。
