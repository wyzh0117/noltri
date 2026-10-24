# Graph 独立代码复核

复核对象：`WorkbenchGraph.tsx`、`workbench-graph-model.ts`、`workbench-graph-simulation.ts`、`workbench-graph-renderer.ts`、view/settings/state 模块及其测试。Graph 由 baseline 实现，本报告只读检查；自动化结果与浏览器测量分开记录。规格基线为《Obsidian笔记与图谱-开发文档.md》§7、§9、§10。附录中的逆向命令不属于实现步骤。

## 代码与模型结果

| 项目 | 复核结论 | 证据 / 边界 |
|---|---|---|
| 查询语义与 revision | 已实现并有模型测试。Graph 通过 typed match 响应分别消费 note paths、`matchingTags`、`attachmentPaths`；tag 节点按自己的标签集合过滤和着色，unresolved 节点在普通 query 下通过。异步结果要求 revision 与当前图一致，查询变更/图 revision 变更会失效旧 effect，缓存 key 含 revision 和 query。 | `WorkbenchGraph.tsx` 查询 effect 与 `workbench-graph-model.ts` 的 `matchesNode`；模型测试覆盖同篇 `science/math` 与 `math` 不串色、层级标签、NOT、OR、组首命中。隔离浏览器已测 `tag:science`（5 nodes/3 edges、只显示对应 tag 节点）、`NOT tag:science`（13/12）和 `tag:science OR tag:math`（7/4）；见 [graph.md](./graph.md)。最终 revision 竞态未在浏览器注入验证。 |
| Groups | 已实现首个匹配组颜色优先；组只提供 `colorGroup`，节点隐藏只由 filter 谓词决定。 | `colorForGroup()` 按数组顺序返回首色；`nodeVisible()` 只应用 filter。`workbench-graph-model.test.ts` 覆盖首组胜出。查询/颜色 handler 在 functional updater 之前 capture primitive，避免延迟读取 React `currentTarget`。baseline fresh page 1432 实测 `tag:science OR tag:math` 的 Group query/filter：match 返回 200，2 组时为 7 nodes/4 edges，移除全部组后仍是 7/4；readPixels 检出红/橙组颜色分别 388/195 像素，无 root blank 或 console error。page13 通过 `HTMLInputElement.prototype.value` setter 与 bubbling input/change 事件把颜色改为 `#00ff00`；React DOM、Vault-root localStorage 与 WebGL `readPixels`（838×1400 有 489 个精确不透明绿像素）均确认颜色更新和持久化。此为真实 React handler/renderer 路径的 DOM 事件注入，不等于原生系统 color picker 的手动操作。 |
| 局部图 | 已接入深度、入/出链、邻居互连、标签、附件、现存文件、孤点选项；按选中 path 作为 root 构造邻域。 | `WorkbenchGraph.tsx` Display controls 与 `buildGraphModel()`；模型测试覆盖深度 1、方向过滤、邻居边与附件。page 13 实测本地 2 nodes/1 edge，关闭入链变为 1/0，恢复入/出链回到 2/1；样本无 attachment node，附件过滤视觉结果未测。 |
| 布局与新增节点 | 新节点先围绕已有邻居均值放置，距离为 `60√I`（I 是本批新增节点数）；无已有邻居的孤点进入 annulus。已有节点坐标保留；simulation 使用 Worker、Barnes–Hut、最小斥力距离 30 和确定性 jiggle。 | `workbench-graph-simulation.ts` 与 simulation tests 覆盖首个/批量新增节点半径、孤点、坐标保留、重合点与 pin 释放。 |
| 力参数 | UI sliders 把向心力、斥力、弹簧力、距离发到 Worker；参数变化重启/加热 simulation 并持久化。 | `WorkbenchGraph.tsx` 的 `updateForce` 和 `forces` effect；默认值/边界由 settings 与 simulation tests 覆盖。视觉变化尚未逐项浏览器量测。 |
| 双向边与线宽 | 互反有向边共用一条可视线，方向箭头仍分别绘制；WebGL 用三角形几何实现 0.1–5 屏幕像素宽度，避开 WebGL `lineWidth` 常被限制为 1 的问题；Canvas fallback 使用真实 `lineWidth`。 | `uniqueGraphLineEdges()`、`drawBase()` 与 renderer tests；模型 clamp 到 0.1–5。两端线宽实际像素对比仍待浏览器截图检查。 |
| 拖动、平移、缩放与 hover | 节点拖动阈值为 5 CSS px，释放时清空 pin；空白平移有短惯性；zoom 锚点转换保留指针位置；hover 可回调边界供 Notes Reader 预览。 | Vite 1437 5k graph-smoke 通过 React surface handler 注入 PointerEvent 拖动 12 帧并释放：node position 改变且持久化、Worker 无错误；这证明基本拖动/保存路径，不是 OS 原生输入或 5px threshold/release-pin 的逐项验证。Meta/Ctrl 新页签、Meta/Ctrl+Shift 分屏以及 tag 节点跳全局 tag 搜索已有实际 UI 观测；hover→Reader 预览仍未实测。 |
| 裁剪、label LOD、主题与重绘 | 输入模型在上传前裁剪节点/线段；label overlay 限制可见节点并按密度碰撞淘汰；typed-array/GPU buffer 复用；渲染按事件唤醒并在 Worker 冷却后停止；MutationObserver 在主题变动时重画。 | `workbench-graph-renderer.ts` 的 `collectVisible()`、scratch/GPU buffer 和 label resolver；`WorkbenchGraph.tsx` 的调度、worker 与主题 observer。无大量节点 pointer hit-test 空间索引；命中仍扫描当前模型节点。真实主题切换和各 LOD 视觉效果待浏览器检查。 |
| 状态持久化 | 相机、节点位置、设置按 vault root + global/local + local focus path 隔离；离开 scope 会冲刷尚未写入的延迟状态。 | `workbench-graph-state.ts` 和 settings/state tests；Group query/color 已在同一 Vault 内通过 localStorage 与 renderer 像素确认保存。跨重启后的相机/位置恢复仍未测。 |
| 时间回放与截图 | 时间线按 edge source mtime 排序，播放速度为规格公式 `clamp(0.5√edgeCount,5,100)` 条/秒；可停止并拖动 progression。截图将当前可见的 WebGL/Canvas 与 label canvas 合成为 PNG；WebGL context 启用 alpha 与 preserveDrawingBuffer。 | `WorkbenchGraph.tsx` timeline/screenshot handlers、`compositeGraphSnapshot()`。mtime 是文件级近似，不是边的真实创建时间或历史快照。实际导出的 838×1400 PNG 已检验透明背景、非透明图形内容和标签层合成；clipboard 拒绝后下载 fallback 已触发。OS 原生剪贴板内容读回未验证；时间线播放/停止/拖动未实测。 |

## 自动化检查

- 最终集成批次 desktop `15 files/107 tests` 与 typecheck 通过；Graph simulation/worker owner targeted tests 为 2 files/8 tests；CRLF/EOL notes model/editor targeted suite 为 54 tests，见 [acceptance.md](./acceptance.md)。定向结果是子集，不与完整 suite 重复相加。
- Query model tests 覆盖 typed `matchingTags` 的 filter/group、NOT/OR/hierarchy 与组优先级。Core query evaluator 证据见 [core.md](./core.md)；实际 UI 的 tag positive/NOT 和 Groups 输入另见下方 browser measurements。
- Graph simulation tests 覆盖 `F=60√I` 初始化、孤点 annulus、固定距离和解除 pin；renderer tests 覆盖反向边单线去重。它们不能替代截图或真实拖拽验收。

## 浏览器测量

以下为 baseline 在 Apple M2、Chrome ANGLE Metal、实际 `WorkbenchGraph` + 5000 节点/10000 边合成图测得的数据，详见 [graph.md](./graph.md)。这是独立 agent 的原始观测，本报告未在共享浏览器重复操作。

| 操作 | 观测 | 结论 |
|---|---|---|
| 120 次平移 pointer move | 119 次 GL clear / 1.999 秒，59.52 Hz；clear 间隔 p95 18.6 ms、max 34.2 ms；active long tasks 0 | 合成样本的平均节奏接近 60 Hz；记录分位数，不据此推断每帧都达到 60 FPS。 |
| 120 次 zoom wheel | 119 次 GL clear / 2.014 秒，59.10 Hz；p95 20.8 ms、max 31.6 ms；active long tasks 0 | 合成样本的平均节奏接近 60 Hz；记录分位数，不据此推断每帧都达到 60 FPS。 |
| settled idle / 唤醒 | inertia settle 后 1.2 秒零 clear；独立 idle 3 秒零 clear；wheel 后恢复绘制 | 支持 idle 停帧与交互唤醒。 |
| 5000 节点冷加载 | 10 个 long tasks，最大 130 ms | 初始化存在超 50 ms 长任务；需要记录，不宣称冷启动无卡顿。 |
| 5000 节点浏览器 Worker layout | 首 tick 至 `alpha≤0.001` 为 4,165 ms、171 messages、0 error | 当前 Vite 1437 surface 的浏览器 Worker 仍超过 §10 的 <2s settle 预算。与 Node Worker bundle benchmark 分开记录。 |
| 5000 节点 React drag | 注入 pointer handler 拖 12 帧并释放；node position 更新且持久化；rAF p50/p95/max 16.6/21.1/23 ms；3.93 s 后 Worker 回冷 | 窄路径功能已验证；注入小样本，不能推断 OS 原生输入或所有拖动帧均达 60fps。 |

### Native JavaScript Worker profile（M2, Node 22.23.2）

Architecture 对最终 native simulation 源做了 M2 定向 profile 和结果等价性检查：

| Node 数 | Direct tick median / p95 | Node Worker bundle settle | Worker batches |
|---:|---:|---:|---:|
| 100 | 0.294 / 0.418 ms | 86.6 ms | 4 |
| 1,000 | 1.996 / 2.022 ms | 772.4 ms | 45 |
| 5,000 | 11.889 / 13.095 ms | 4,155.8 ms | 193 |

最终更改限于 collision bucket numeric key；相对前一递归基线约改善 1k 20%、5k 15.5%，charge recursion 未改。Targeted Graph tests 8/8；对旧输出在 100/1k/5k 各取 1/10 tick 的最大差 0，另覆盖重合点、pin/unpin 与极大坐标 fallback。5k settle 仍超过 §10 的 <2s 预算；Node Worker bundle 结果不是浏览器 Worker 的完整 UI 延迟。

### D3 / WASM 候选（未采用）

| 候选 | 临时基准 / 约束 | 决定 |
|---|---|---|
| D3 JavaScript | 相同粗略配置 300 ticks 时，100/1k/5k 约 72/931/5,927 ms；被比较的现有旧基线约 64/690/4,248 ms。force 公式也不逐项等价。 | 更慢且物理语义不同；未加依赖。 |
| `d3-force-wasm@0.2.0` | `/tmp` exact-mode 5k/300 ticks 约 2,116 ms，仍略超 2s；D3 force 语义有差异，要求 CSP `wasm-unsafe-eval`，资源清理依赖 FinalizationRegistry 且无确定性 dispose。 | 不加入 production，避免为未达目标的不同物理模型增加 WASM/CSP 生命周期成本。 |

这些是候选评估，不是当前实现或验收通过证据。

## 截图复制静态复核

`takeScreenshot()` 先把当前 WebGL、Canvas fallback 和标签 canvas 合成透明 PNG，再尝试通过 `ClipboardItem({ 'image/png': Promise<Blob> })` 写入剪贴板；clipboard API 不可用、拒绝或写入异常时会下载 `noltri-graph.png`。合成/导出异常会显示在 Graph 错误状态。独立浏览器结果见 [graph.md](./graph.md)：真实 PNG 为 838×1400、59,658 bytes；解码检查确认透明像素，且标签层像素改变了合成结果；强制 clipboard rejection 后真实 handler 下载了 `noltri-graph.png`。成功分支用 page-level sink 检查 handler 的 PNG payload，未能读回 OS 原生剪贴板；也未在 Canvas fallback 渲染器上验截图。

## 尚未通过独立浏览器验收的项目

1. 在最终 freeze UI 上验证 revision 快速切换竞态、低于/超过 5px 的拖动阈值、释放后 pin 清理、hover→Reader preview，以及时间线播放/停止/拖动。基本 React pointer drag 和位置持久化已在 5k surface 测过，但不覆盖这些边界。
2. 实际逐项观察力参数、线宽 0.1/5、标签 LOD、主题切换、相机/位置重启恢复对 renderer 的影响；合成颜色输入证据不替代原生系统 color picker 手势。
3. WebGL 不可用时验证 Canvas fallback 的交互和截图；该渲染路径未测。OS 原生剪贴板 readback 也未完成，clipboard rejection 下载 fallback 已实测。

## 结论

静态代码和模型测试证明了共享 typed matcher、Graph local/global 模型、首组着色优先、Worker 布局、初始节点邻域布局、反向边单线、范围线宽、视口裁剪、事件驱动重绘与 root-scoped 持久化已经接线。实际 UI 已有 Core-backed positive/NOT tag filter、OR/Groups query、组不隐藏节点、颜色像素/持久化、local 入/出链、Meta 新页/分屏、tag 搜索和隐藏快捷键证据；Vite 1437 5k surface 也通过注入 pointer handler 验证了基本拖动、位置持久化与零 Worker error。Group handler 的 React `currentTarget` 延迟读取崩溃已由同步 primitive capture 修复并在 page 1432 复测。PNG 透明背景/标签合成及 clipboard rejection 下载 fallback 已验证；OS 原生剪贴板读回未验证。M2 5k pan/zoom/idle 平均节奏接近 60 Hz，但 rAF drag 小样本 p95 为 21.1ms；Node Worker settle 4.156s、浏览器 Worker settle 4.165s，均超过 <2s 布局预算。拖动 5px 边界/释放 pin、hover preview、力/主题时间线组合、重启恢复和 Canvas fallback 仍待 UI 验收，当前不能把 §7/§10 Graph 全项标为通过。

## NotesEditor 独立静态复核（§6.4）

NotesEditor 由 baseline 实现，本节为独立只读代码复核。当前集成批次的 desktop typecheck 与全套 107 项测试通过，包含 fenced-code click-to-source regression；CRLF/EOL 新增用例也通过 54 项定向 suite。真实浏览器行为另列为实测或待验项，不用 StateField 测试替代真实键盘/视觉检查。

| 范围 | 静态复核结论 | 当前证据与限制 |
|---|---|---|
| 源码显隐 / 搜索 | `StateField` 根据 caret、selection 和服务端给出的 search ranges 重建 widgets；命中重叠 token 时显示源码。StateField 测试直接验证 caret、selection、搜索高亮加入/移除时 widget 出现与源码恢复。 | `shouldRevealSource()` + `buildDecorations()`；测试覆盖 link、fenced code、HTML、horizontal rule。数学、表格、callout、embed/image 的真实 DOM 选区仍需浏览器复验。 |
| 图片、embed 与光标移动 | 只有 image/embed token 放入 `EditorView.atomicRanges`；CM6 6.43.15 的 API 文档明确其 `moveByChar`、`moveVertically` 与对应命令会跳过 atom ranges。 | 实现不自造 ArrowUp/Down 算法；但本轮没有对真实 `EditorView` 做键盘端到端测试。 |
| block widget 高度 | Table、math、callout、embed、code、HTML 与 hr 用 block replacement widget；DOM 自身内容参与 CM6 块布局，table CSS 使用 overflow，不以固定高度占位。 | 静态布局可解释高度来源；不同内容高度/连续 widget 的视觉间距仍需浏览器检查。 |
| Widget identity / async | `WidgetType.eq()` 比较 source path、token kind/raw、Vault root+revision key、HTML/Mermaid trust；异步解析/媒体/embed/Mermaid 检查 DOM 仍连接且相同 path+revision，链接 resolver 再用 target marker 丢弃过期响应。 | 定向测试覆盖 revision 变更后由 unresolved 变 resolved、旧异步答复不覆盖新状态；WorkbenchNotes 传入 `${rootPath}:${revision}`。真实目标创建后的状态切换仍待浏览器检查。 |
| 未解析链接与外部链接 | 仅内部目标进入 resolver 并加 `is-unresolved` 红色虚线状态；`http(s)`/`mailto` 不作为断链，打开时由 UI 确认；危险 `javascript:`/`data:`/`vbscript:`/`file:` 目标被过滤/拦截。 | `resolveLinkWidget()` 单测验证未解析标红、后续解析清除、旧响应忽略和 HTTPS 不调用 resolver；真实确认对话框/渲染组合仍待浏览器复验。 |
| 安全渲染 | markdown-it 默认关闭原始 HTML；信任 HTML 后仍经过 DOMPurify，Mermaid 默认挡板、信任后 strict 模式且 SVG 再清理；外部图片需要用户确认，SVG/不安全协议附件不作为图片直接渲染。 | 单测/代码检查可证明路径存在，不证明恶意 payload 在实际浏览器 DOM 的最终属性；把恶意 HTML、img onerror、JS URL、Mermaid 未信任/信任切换留给浏览器批次。 |

## NotesEditor 浏览器验证状态

baseline 在隔离 Vite 1423 / Core 18788 的 `Widgets.md` fixture 上观察到：Live Preview 渲染 KaTeX、Markdown table、callout、两种 fenced code、HTML、horizontal rule 与 Mermaid fence；默认 HTML 显示挡板、Mermaid 显示未信任提示，DOM 中没有 SVG/script。用户打开 HTML trust 后只保留清理后的安全元素，img 无 src/onerror，脚本/事件属性计数为 0，XSS global 未触发；打开 Mermaid trust 后 SVG 可见，script 与 on* 属性计数为 0，XSS global 未触发。Caret 进入/跨过 `[[Target|science target]]` 时显示完整原文，移出后恢复 widget；搜索 `science target` 命中 `.cm-search-hit` 并显示源码，清除 query 后恢复 widget。fixture 另观察过 `![[Widgets#Deep]]` 和 1×1 PNG embed 成功。

最终 CRLF/CJK browser case 在 page 13/1432、隔离 18789 `ReviewBatch/CRLFProbe.md` 通过：开始的 Core GET 为 9 CRLF/0 bare LF；搜索 `LINK-HIT-CRLF-774` 后 `.cm-search-hit` 存在、编辑器显示原始 `[[Target|LINK-HIT-CRLF-774]]` token。把 caret 放在 `Second Heading` 后按 ArrowRight，outline active 项正确跟随。用真实 `type_text` 追加 `after CRLF-SAVE-TEST` 并等到已保存后，Core GET 返回 200，仍为 9 CRLF/0 bare LF；切到含 LF 的 `Target.md` 再切回，换行样式和文档内容不串。此用例验证了浏览器中的 search/source、caret/outline、编辑保存及文件切换 EOL 隔离，不替代 10k Reader 或长时输入性能测量。

上述观察是 baseline 的原始浏览器回报，覆盖旧 build 中未改动的 renderer/sanitizer/选区/搜索路径；新加的 unresolved revision key 和后续局部重解析需以当前测试/新 build 证据评估。1423 未点外部链接确认；HTTP/mailto 确认路径与 `javascript:`/`data:` 拒绝仍需最新 build DOM 交互确认。链接重解析新实现有 StateField/async guard 测试，目标创建后红色标记自动清除仍待新 build 浏览器复测。

无效 subpath 文件级回顶、孤儿附件 `always` 删除后的旧路径恢复已由 UI 修复，具体 CRUD 浏览器病例尚待执行。Reader10000 fixture（10,000 行、2 refs、1 CJK definition、909 fences；SHA-256 `8e948a8057e08b83e12c9dd98d406458d74331313648cdf809586c4a719ce260`）已导入 Core 临时 Vault。coherent 1435 build 的首次真实 ref 点击失败：脚注 section 虽已渲染，target LI 仍在 viewport 外；诊断确认 `.vault-reader-scroll` 的 CSS smooth 与重复 `behavior:auto` 滚动重启动画冲突。删除 smooth 后，最终不可变 CSS-fix build page4/1436 在无 override 下通过首击/backref：首 ref 2.5s 后 `fn-_r_1_-1` 位于 viewport 579.6–635.1 px（viewport 146–695），backref 1.4s 后 `fnref-_r_1_-1` 在 section 3 可见（269.7–282.7 px）。bundle 位于 `/tmp/noltri-final-ui-cssfix-20261024-ba9fcd`，CSS asset SHA `123a82d7…ba8f`。这证明首击/回链导航，不代表 Reader 10k 每帧 <16ms。

此前 5,000 行连续编辑 run 在 page7/1425/Core 18789 于 2026-10-23 19:13:48Z 启动，约 4 分钟后因性能退化停止；第三分钟 `beforeinput→rAF` p95 95.6ms、179 long tasks、max 345ms，最终文件 320,538 字符/5,009 行。该 run 不计通过。page9/1427 普通混合行 p95 35.1ms、0 long tasks；另有短样本显示稳定 heading/code-body 编辑曾走全量 fallback。当前局部重解析测试通过但最终长时 soak 未证明 <16ms。HTML/source/search 的旧浏览器观察仍适用于未改动的 renderer/sanitizer 路径；外链确认、危险协议最终 DOM 仍需浏览器检查。首击脚注/backref 已在最终 CSS-fix bundle 通过；早期万行快速滚动曾出现 55–607ms long tasks，但尚无当前 bundle 的正式帧预算数据。最新 30 分钟长测已完成：连续输入与文件完整性窄项通过，但 raw runner 因收尾快照仍处于 indexing 状态而保留 invalid，且 `<16ms` 响应预算未达（详见 [acceptance.md](./acceptance.md) 与 [review-notes.md](./review-notes.md)）。Reader10k 帧预算及尚未覆盖的 Graph/CRUD 浏览器病例仍待完成。API client/Reader/LP 已接 `wikilink` 与 `markdown` resolver kind 透传，使链接索引、点击、hover、附件目标使用同一解析语义。
