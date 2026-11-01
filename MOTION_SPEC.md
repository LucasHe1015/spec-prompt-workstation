# S.P.E.C. 7 动效改造契约（MOTION SPEC）

本文件是本次"给已完成 UI 添加动画"的唯一契约。所有参与者必须严格遵守，**不要偏离文件所有权**。

## 1. 设计基调

界面是 1970s NASA 图形标准的"仪表控制台"：纸张、铆钉、印刷色块、四色（c1 蓝灰 / c2 橄榄 / c3 沙金 / c4 锈红）。
动画必须像**机械仪表与纸张机构**的动作，而不是现代圆润 App 的弹簧动画：

- 位移小（4–14px），缩放幅度 ≤ 6%（不要弹跳夸张）。
- 以 `opacity + translate` 为主，避免大面积 blur/rotate。
- 时长：微交互 90–140ms，常规进场 200–280ms，退场 120–180ms。
- 缓动偏"快起慢收"（`--m-ease-out`），机械感可少量用 `--m-ease-snap`。
- 不要加发光、渐变遮罩、彩色阴影等破坏原视觉的东西；阴影沿用现有 `box-shadow` 语言（硬边、2px 位移感）。
- 每个动画都必须服务于"状态变化可被感知"，不做无限循环装饰动画（已有的 `ledPulse` / `hazardMove` / `blockSweep` 除外）。

## 2. 文件所有权（硬约束）

| 文件 | 唯一写者 | 说明 |
| --- | --- | --- |
| `public/index.html` | Lead | 只 Lead 加 `<link>` / `<script>` |
| `public/styles.css` | **任何人不得修改** | 原有基础样式冻结 |
| `public/motion-core.css` | Lead | token、keyframes、通用工具类 |
| `public/motion.js` | Lead | `window.SPECMotion` API |
| `public/motion-nav.css` | teammate `nav-motion` | 左侧栏 / 视图切换 / 顶栏 / 会话标签 |
| `public/motion-panels.css` | teammate `panel-motion` | 三栏面板 / 词块 / 记录列表 / 折叠 / 按钮微交互 |
| `public/motion-overlays.css` | teammate `overlay-motion` | modal / confirm / toast / alert / hover 浮层 / picker |
| `public/app.js` | teammate `js-hooks` | 只加动效钩子，不改业务逻辑 |

约束：
- 只能在你拥有的文件里写 CSS/JS；**不要**修改其它 teammate 的文件，也不要 temp 备份。
- CSS 文件必须只新增规则，选择器优先级要能覆盖 `styles.css`（必要时用 `body` 前缀或更高特异性，**禁止滥用 `!important`**，仅允许在 `prefers-reduced-motion` 兜底里用）。
- 不要修改 HTML 结构；如需 hook，通过 `data-*` 属性由 `js-hooks` 添加。
- 改动后页面不得出现布局跳动（CLS）：动画开始前后元素占位不变。

## 3. Token（motion-core.css 定义，直接使用）

```css
--m-dur-1: 110ms;   /* hover / press 微交互 */
--m-dur-2: 170ms;   /* 退场 */
--m-dur-3: 260ms;   /* 标准进场 */
--m-dur-4: 420ms;   /* hero / 大区块进场 */
--m-delay-step: 26ms; /* stagger 步进 */

--m-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--m-ease-in: cubic-bezier(0.4, 0, 1, 1);
--m-ease-inout: cubic-bezier(0.65, 0, 0.35, 1);
--m-ease-snap: cubic-bezier(0.2, 0.9, 0.2, 1);
```

## 4. keyframes（motion-core.css 已定义，直接引用，不要重复定义）

| 名称 | 用途 |
| --- | --- |
| `mFadeIn` / `mFadeOut` | 纯淡入淡出 |
| `mRiseIn` / `mRiseOut` | 自下 10px 上浮进入 / 下沉退出 |
| `mDropIn` / `mDropOut` | 自上滑入 / 上收退出 |
| `mSlideInRight` / `mSlideInLeft` | 自右/左 14px 滑入 |
| `mPopIn` / `mPopOut` | scale(0.94)→1 弹入 / 反向 |
| `mFlipIn` | 文字块小翻牌（translateY + rotateX） |
| `mSweep` | 一条高光横扫（用于激活项） |
| `mChipIn` | 词块 pop 入场（scale + fade） |
| `mShakeX` | 错误抖动 1 次（±3px） |
| `mRingIn` | 从中心扩散的圆环，用于点击反馈 |
| `mBarGrow` | scaleX 0→1（进度/下划线生长） |
| `mMeterBlink` | 数值刷新时一次短闪 |

## 5. 通用工具类（motion-core.css）

```css
.m-enter                /* 基础进场：duration/easing/fill-mode */
.m-enter-fade / .m-enter-rise / .m-enter-drop / .m-enter-pop /
.m-enter-right / .m-enter-left / .m-enter-flip     /* 配合 .m-enter 选动画 */
.m-enter-fast / .m-enter-slow                      /* 覆盖时长 */
.m-leave                /* 基础退场 */
.m-leave-fade / .m-leave-rise / .m-leave-drop / .m-leave-pop
.m-stagger > *          /* 子元素依次 mRiseIn，靠内联 --m-i 排延迟 */
.m-pressable            /* 按下时 translateY(1px) 的通用反馈 */
```

`motion.js` 会在动画结束（`animationend`）后自动移除这些 class，CSS 只需保证 `both` 填充下末帧等于元素自然状态。

## 6. `window.SPECMotion` API（motion.js，app.js 可直接用）

`motion.js` 在 `app.js` 之前加载。所有函数在 `prefers-reduced-motion: reduce` 下退化为瞬时切换（不抛异常）。缺失元素一律安全返回。

```js
SPECMotion.reduced                     // boolean，当前是否减少动效
SPECMotion.dur(name)                   // 'fast'|'base'|'slow' → ms

SPECMotion.show(el, { enter = 'fade', child = null })
   // el.hidden=false 后播放进场动画；child 为选择器时，其匹配元素播放 '.m-enter child'
SPECMotion.hide(el, { leave = 'fade', child = null }) → Promise<void>
   // 先播退场，动画结束后 el.hidden=true
SPECMotion.toggle(el, open, opts)

SPECMotion.fold(bodyEl, open, { duration = 220 })
   // 折叠容器专用：高度 0↔auto 的机械抽拉（内部处理 hidden 与 overflow）
SPECMotion.stagger(container, { selector = ':scope > *', step = 26, max = 14, replay = false })
   // 给子元素写内联 --m-i；replay=true 时重播进场
SPECMotion.flip(el)        // 文字/编号切换的 mFlipIn 微动画
SPECMotion.press(el)       // 点击涟漪/按下反馈（自动限制频率）
SPECMotion.sweep(el)       // 触发一次 mSweep 高光
```

CSS 使用方须知：
- `SPECMotion.show(el,{enter:'pop', child:'.modal'})` 会在 `el` 上加 `.m-enter.m-enter-pop`；如需让子元素单独播别的动画，用高特异性选择器即可，例如
  `.modal-backdrop.m-enter-fade .modal { animation: mPopIn var(--m-dur-3) var(--m-ease-out) both; }`
- `SPECMotion.hide()` 期间 `el` 保持可见（`.m-leave` 存在），动画结束后才 `hidden`。

## 7. `app.js` 钩子接入点（js-hooks 负责）

只在这些位置加动效调用，**不改变任何业务判断顺序**：

1. `switchView(view)`：
   - 在 `.rack-nav`（`document.querySelector('.rack-nav')`）上设置 `--rack-idx`（0..3，按 data-view 顺序 translate/card/gallery/glossary）与 `data-nav-idx`。
   - 切 view 时对新激活的 `.view` 调 `SPECMotion.show(el.viewX, {enter: dir === 'down' ? 'drop' : 'rise'})`；方向由目标 index 与上一个 index 比较决定（向下→`drop`，向上→`rise`）。
   - 对 `#bayCode` / `#bayName` / `#bayCn` 调 `SPECMotion.flip(每个元素)`。
   - `SPECMotion.press(被点击的 .rack-btn)`。
2. 折叠：`togglePresetFold` / `toggleCharacterFold` / `closeCharacterFold` / `toggleSourceCharacterFold` / `toggleSourcePresetFold` / `closeSourceFolds` 里把 `xxxBody.hidden = ...` 换成 `SPECMotion.fold(xxxBody, open)`（保持 aria-expanded 等原有语句）。同一时刻其它折叠体用 `SPECMotion.fold(other, false)` 收起。
3. 浮层：`openConfirmDialog`/`closeConfirmDialog`、`openSettings`/`closeSettings`（`el.modalBackdrop`）、`showAlert`/`hideAlert`、`toast`（改用 `SPECMotion.show(el.toast,{enter:'rise'})` 并保留 `is-visible` 语义，注意清理定时器）。
4. 模式切换：`openRecordSession`/`closeRecordSession`（`el.viewHistory`/`el.viewFavorite`）、`setCharacterMode`（`characterGallery`/`characterEditBody`/`characterEditFoot`/`characterCreateMode`）、`openGalleryAdd`/`closeGalleryAdd`（`galleryAddView`/`galleryHome`）、`renderCharacterPicker` 之外的 picker 开合、`characterComboAdd` 开合。
5. 列表渲染后：`renderRecordList`（#historyList/#favoriteList）、`renderGalleryHome`（#galleryList）、`renderGlossaryRows`（#glossaryList，仅首次/重渲染后，别在每次过滤时重播）、`renderCharacterGallery`（#characterGalleryGrid）、`renderSessionBar`（#sessionTabs）、`renderSegments`/`renderTarget`（chips / sentence blocks）里调 `SPECMotion.stagger(container)`。
   - 注意：频繁重渲染的容器（如会话输入、chips 每次编辑）只加 `stagger`，不要加整块进场动画，避免闪烁。
6. hover 浮层（`showCharacterHover`/`showPresetHover`）：显示后 `SPECMotion.show(pop, {enter:'rise'})`；隐藏用 `SPECMotion.hide(pop,{leave:'fade'})`（若与定位计算冲突，退化为直接 `hidden = true` 也可以，但需注释说明）。

必须遵守：
- `app.js` 中所有 `xxx.hidden = true/false` 的语义不可变，只是"是否带过渡"改变。
- 不要新增全局事件监听冲突（已有 hotkey 逻辑不要动）。
- 不要引入 `async/await` 改变调用时序，除非局部安全（`SPECMotion.hide` 返回 Promise，可忽略）。

## 8. 各视觉区域动画要求

### 8.1 `motion-nav.css`（nav-motion）
- **侧边栏活动指示条**：`.rack-nav::after` 作为 5px 宽的四色"滑块"，位置由 `--rack-idx` 控制，`transform: translateY(calc(var(--rack-idx, 0) * 100%))`，`transition: transform var(--m-dur-3) var(--m-ease-out), background-color var(--m-dur-2) linear`；颜色按 `data-nav-idx` 切到对应 c4/c3/c2/c1。（注意 `.rack-nav::before` 已有静态四色条，别删，滑块是叠加的活动高亮，可做成比 before 更宽的 5px 亮边或 left:0 的 3px 白色描线，自行取舍但要协调。）
- **rack-btn 切换**：is-active 时图标 `mPopIn`；label 轻微 `letter-spacing` 过渡；`rack-code` 短闪（`mMeterBlink` 单次）；点击 `.m-pressable` 效果；hover 图标 `translateY(-1px)`。
- **视图切换**：`.view.is-active` 使用 `.m-enter` 类（由 JS 添加），CSS 里保证 `.view` 在切换时不闪、不改变布局；`.stage-bar` 里的 `#bayCode/#bayName/#bayCn` 支持 `mFlipIn`。
- **顶部 topbar 元件**：`engine-chip` 的 `led` 呼吸仅在 busy 时（已有），可加 chip 状态变化时 `mMeterBlink` 一次。
- **会话标签** `#sessionTabs .session-tab`：新增标签 `mPopIn`，激活标签下缘 `mBarGrow`，关闭标签用退场（若 js-hooks 未接则只做进入）。
- 不要动 `hw-strip` 仪表环的既有过渡（`stroke-dashoffset`）。

### 8.2 `motion-panels.css`（panel-motion）
- **三栏面板进场**：`#panels` 显示时 A/B/C 依次 `mRiseIn`（用 `:nth-child(1..3)` 内联 `animation-delay`），`--m-dur-4` 内完成；已有 `animation: fadeIn` 保留可覆盖。
- **折叠体**：`.source-fold-body` / `.character-fold-body` / `.preset-fold-body` 在 `SPECMotion.fold` 作用下的样式配合（`.is-m-folding { overflow: hidden; }`，箭头 `.source-fold-arrow`/`.character-fold-arrow`/`.preset-fold-arrow` 用 `transform: rotate(...)` 过渡 180°）；展开时内部卡片 stagger（`.m-stagger` 由 JS 加，CSS 给 `.source-fold-body .m-stagger > *`）。
- **词块 chips / 句块**：新块进场 `mChipIn`（`.chip`、`.sentence-block` 新增节点）；hover 联动高亮过渡（`.is-linked` 已有，只加 transition）；删除时的退出由 JS 触发（若无则跳过）。
- **记录列表**：`#historyList` / `#favoriteList` 的 `.record-item`（或实际类名）stagger；hover 左侧色条 `mBarGrow`。
- **画廊列表**：`#galleryList` 的卡片进场 stagger + hover 图片 `scale(1.015)` + 阴影位移。
- **词条库行**：`#glossaryList` 行 stagger、新增行高亮闪一次。
- **角色卡画廊**：`#characterGalleryGrid` 卡片 stagger + hover `translateY(-2px)`。
- **按钮/输入微交互**：`.btn` / `.icon-btn` / `.session-tool` / `.btn-translate` 按下 `translateY(1px)`、hover 边框/背景过渡；输入框 focus 时边框色过渡（不要改尺寸）。
- 禁止改动已有 `.panel-foot` 高度、`.panel` border 尺寸等影响布局的属性。

### 8.3 `motion-overlays.css`（overlay-motion）
- **modal（引擎舱）**：backdrop `mFadeIn`，`.modal` `mPopIn`+轻微 translateY（`--m-dur-3`）；关闭反向（`.m-leave` 存在时 `.modal` 播 `mPopOut`）。`details.cfg` 展开/收起用 `height` 过渡（`grid-template-rows: 0fr/1fr` 或 JS 未接则只做箭头旋转 + 内容淡入）。`summary` hover 反馈。
- **confirm 对话框**：`mPopIn` + backdrop 淡入，`confirm-delete-btn` hover/active 已有，可加 `mShakeX` 于警告图标（如无图标则不加）。
- **toast**：保留 `is-visible` 机制，但把 `transform` 位移加大到 16px 并加 `scale(0.98)`；错误态进入时 `mShakeX` 一次。
- **alert（`#alert`）**：从面板顶部滑下 `mDropIn`，`hazardbar` 扫动（已有 hazardMove，可复用），关闭上收。
- **hover 浮层** `#presetHoverPop` / `#characterHoverPop`：`mRiseIn` 进场（`--m-dur-2`），`transform-origin: bottom left`，不要改变定位逻辑。
- **character picker 面板**：`#characterPickerPanel` 展开 `mDropIn` + 内部 `m-stagger`。
- **boot-error / help-pop**：`help-pop` 进场 `mSlideInRight` 或 `mPopIn`；boot-error 淡入。
- 注意所有浮层都是 `hidden` 切换，只能做进场动画 + 由 JS 触发的退场 class，不要用 `display` 覆盖（`[hidden]` 是 `!important`）。

## 9. 可访问性

- 所有动画在 `prefers-reduced-motion: reduce` 下必须退化为无位移/瞬时（motion-core 已提供全局兜底，各文件不要再次放宽）。
- 不得用动画阻塞交互：动画期间元素必须可点击（`pointer-events` 保持原样）。
- 不要让 `animation-fill-mode: both` 的末帧覆盖 hover 状态（末帧尽量写 `transform: none; opacity: 1`，并在结束后被 JS 移除 class）。

## 9.1 主题切换动画（浅色 ↔ 深色）

主题切换属于动效层，规则同样适用：

- 触发元素：`#themeToggle`（`.icon-btn.theme-toggle`），位于顶栏 `.topmeta` 最右侧，太阳/月亮图标交叉淡入 + 按钮一次机械摆动（`themeToggleKick`，560ms）。
- 主体动画：View Transitions API。`theme.js` 用 `document.startViewTransition()` 包裹 `data-theme` 切换，并对 `::view-transition-new(root)` 做圆形 `clip-path` 扩散（圆心 = 按钮中心，半径 = 到最远角，520ms，`--m-ease-out`）。语义是「从开关处关灯/开灯」，不是全页淡入淡出。
- 切换期间根元素加 `html.is-theme-switching`，临时关闭所有元素级 `transition`：否则每个按钮/边框的颜色过渡会与扩散叠加，新快照会落在半截颜色上。
- 降级：不支持 `startViewTransition` 或 `prefers-reduced-motion: reduce` 时直接切换（无动画）；`.theme-toggle.is-flipping` 在 reduced 下也被关闭。
- `::view-transition-old/new(root)` 的默认 crossfade 已被 `theme.css` 关掉，不要重新引入。
- 颜色本身由 token 决定：`styles.css` 提供浅色值，`theme-dark.css` 在 `html[data-theme="dark"]` 下重映射。**新增颜色必须写成 token 引用**，否则深色主题不跟随。

## 10. 验证方法

服务已在 <http://127.0.0.1:8765> 运行（静态文件，改完刷新即生效）。无 node 依赖，用 Chrome headless 截图：

```powershell
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --headless=new --disable-gpu --no-sandbox `
  --hide-scrollbars --user-data-dir="$env:TEMP\spec-shot-$PID" --window-size=1600,1000 `
  --virtual-time-budget=2500 --screenshot="F:\translater\screenshots\_verify.png" 'http://127.0.0.1:8765/'
```

- `--virtual-time-budget` 调小（如 300）可截到动画中间帧。
- 验证要求：页面视觉与改动前基线（`screenshots/_baseline-current.png`）在静态帧下**基本一致**，只在交互时才有动画；无控制台报错（可加 `--enable-logging=stderr --v=1` 过滤 `CONSOLE`）。
