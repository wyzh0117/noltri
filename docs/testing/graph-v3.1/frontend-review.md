# Graph v3.1 前端独立代码审查

日期：2026-10-20
审查范围：`WorkbenchApp.tsx`、`GraphNotebook.tsx`、`note-drafts.ts`、`graph-navigation.ts`、`WorkbenchGraph.tsx`、`workbench-graph-layout.ts` 及相关 CSS。按指南 A05、A07、A09、A12–A13 跟踪导航、草稿与 Graph 调用链。只读审查，未改产品代码，也未启动浏览器；真实 HTTP + SQLite 浏览器验收由独立代理进行。

## 发现

### A07：卡片页／资料库中无法完成共享章节的主题选择

侧栏章节点击进入 `selectTreeNode`，再调用 `resolveAndOpenChapter`。当解析返回 `choose-topic` 时，处理器只写入 `chapterChoice`，没有改变当前内容页。`GraphNotebook` 只在普通笔记分支渲染 `.chapter-choice`；卡片分支渲染主题卡片，资料库态则完全不渲染 `GraphNotebook`。因此从卡片页或资料库侧栏点击一个多归属章节，候选主题不可见，用户无法继续。保留搜索词时，搜索结果分支也会遮住候选选择。

另一个跨范围路径：若在范围 A 的笔记页中，从侧栏点击范围 B 下的共享章节，`activateScope` 只在 `resolved` 分支执行。`choose-topic` 分支会留在 A 的 GraphScope；候选标签也从 A 的 `nodes` 查找，通常只显示通用“主题”。选定后 `chooseChapterTopic` 直接按候选 ID 载入正文，仍不切换 GraphScope。

证据：`WorkbenchApp.tsx` 的 `selectTreeNode`、`resolveAndOpenChapter`（约 420–474 行）；`GraphNotebook.tsx` 的内容分支（约 130–155 行）。最小修正方向：让候选选择在卡片页和资料库入口可见；候选结果必须携带解析时的 scope，并在用户确认后以同一 scope 导航／刷新 Graph。验收需覆盖 cards、library 和跨范围入口。

### A09：重复打开当前正文可丢失尚未保存的输入

`prepareContentTransition` 在目标 `contentIdentity` 与当前相同时直接返回 `true`，不会 flush。可是在主题卡片／Graph 节点／章节目录中再次打开当前主题或章节，调用链仍会进入 `loadNote`；它立即把 `activeNote` 替换成空正文的 `loading` 状态，并重新读取服务端正文。这个状态变化会清理 650ms 自动保存计时器。

可复现步骤：令 `localStorage.setItem` 抛出 quota／禁用错误；在当前笔记编辑器输入内容，并在自动保存计时器触发前点击当前选中的 Graph 节点或当前章节；等待正文读取返回旧服务端内容。由于同身份路径跳过 flush，输入被清除，尚未启动的保存也被取消。若服务器保存刚好已在途，旧 GET 还可能先返回旧正文，令用户随后覆盖已经保存的新版本。

证据：`WorkbenchApp.tsx` 的 `prepareContentTransition`（约 219–230 行）、`loadNote`（约 292–340 行）、`navigateToTopic`（约 360–384 行）和 `navigateToChapter`（约 386–389 行）。最小修正方向：相同 note identity 不重载；若确需重读，必须先 flush 并在失败时保留编辑态。验收需在本地草稿不可写时快速重复点选当前节点。

### A05：较早返回的章节解析可覆盖更新的任意导航

`resolveAndOpenChapter` 没有请求序号或导航意图检查。每次 `api.resolveChapter` 返回后都会继续 `prepareContentTransition` 和 `loadNote`。可复现步骤：让章节 A 的解析请求较慢；随后点击章节 B 或主题卡片／侧栏学科导航，B/后续目标先显示；待 A 的旧解析响应返回后，它仍会切到 A。`noteLoadRequestId` 只保护已经开始的正文 GET，无法阻止旧 resolver 迟到后新建一次更晚的 GET。

证据：`WorkbenchApp.tsx` 的 `resolveAndOpenChapter`（约 447–474 行），调用点包括 Graph 节点、搜索结果和侧栏章节。最小修正方向：用统一的导航意图序号覆盖章节解析及所有后续导航；仅仍为最新意图的解析响应可打开内容、显示候选或提示错误。验收用延迟 A 请求并随后导航到章节、主题、卡片／学科页，确认 A 不覆盖新目标。

## 检查结果与发布判断

- 现有针对性测试：直接运行 `./node_modules/.bin/vitest run apps/desktop/src/workbench/note-drafts.test.ts apps/desktop/src/workbench/graph-navigation.test.ts apps/desktop/src/workbench/workbench-graph-layout.test.ts`，3 个文件、8 项测试通过；这些测试没有覆盖上述组件交互和竞态。
- `pnpm --filter @noltri/desktop test` 在 pnpm 尝试安装并清理 modules 目录时因无 TTY 中止（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）；未用 `CI=true` 重试以避免触发清理。
- 以上属于代码调用链可直接复现的风险，不代表我已在浏览器中观察到实际 UI 结果。P2 报告中的真实页面验收仍待独立代理完成。
- **审查结论：暂不建议发布。** A07 和 A09 阻断用户完成章节选择／保护正文；A05 会使快速连续导航落在旧目标。修复后需由独立代理复测对应真实交互。

## P3 renderer / Graph 搜索补充审查

### A12：Graph 搜索的 API 过滤范围比真实 GraphScope 窄

Workbench 的搜索 effect 将 discipline、subdiscipline 或 topic anchor 转成单一 `scopeNodeId`，调用 `/api/search`。服务端 `services/knowledge-core/src/services/search.ts` 的 `subtreeIds` 只沿 `KnowledgeNode.parentId` 建允许集合；而 `selectGraph` 会沿真实 `part_of` 关系纳入关联章节和共享这些章节的主题。若章节 C 的主树父节点在二级范围 B，但它另有真实关系连到范围 A 的主题，A 的 Graph 确实包含 C，A 的搜索结果却会在服务端因 C 不属于 A 的 `parentId` 子树而被过滤。主题局部范围中的共享章节同理。

证据：`WorkbenchApp.tsx` Graph search effect（约 798–825 行）；`search.ts` `subtreeIds` 与结果过滤（约 33–53、64 行以后）；`services/knowledge-core/src/services/graph.ts` 以共享 `part_of` 边生成 topic/subdiscipline GraphScope（约 208–245 行）。最小修正方向：搜索可覆盖当前完整 GraphSelection，再以该完整 selection 的真实节点 ID 限定返回的知识节点，避免构造另一份 hierarchy-only 范围。独立验收用跨二级共享章节确认 A 图包含 C、在 A 搜 C 可找到 C 并保持 A 范围。

### A13：快速切换 GraphScope 会丢掉尚未落盘的上一范围视野

视野状态按 scope identity 保存在 `localStorage`，但写入延迟 220ms。scope identity 改变时，持久化 effect 的 cleanup 只取消旧 timer；GraphScope 改变不会卸载 `WorkbenchGraph`，所以仅在组件卸载时写入的 cleanup 不会替旧范围保存快照。若用户缩放／平移范围 A 后 220ms 内从侧栏进入范围 B，A 的最新 camera 和 positions 未写入。之后返回 A 时读取到旧快照，违反按范围身份恢复视野的约定。

证据：`WorkbenchGraph.tsx` `activeState` 与 `stateSnapshotRef`（约 178–188 行）、scope effect（约 224–229 行）、220ms debounce 和仅卸载写入（约 241–246 行）。最小修正方向：切换 scope 的 cleanup 同步持久化旧 scope 的旧 snapshot，或将活跃 scope 状态按 identity 保存在内存中并在落盘时逐 scope 写入。独立验收快速平移／缩放 A、切到另一 scope 并返回，确认 A 的位置与缩放保持。

P3 补充项为静态调用链审查发现，尚未由我在浏览器中实测；独立代理应使用其正在运行的真实服务与 UI 进行复核。

## P2 修复独立复核（2026-10-20）

对照 P2 修订后的调用链再次只读检查；未发现 A07、A09、A05、A12 四项修复仍有原报告所述路径缺口。

- **A07**：候选选择面板已接到资料库主区，也在 `GraphNotebook` 的所有内容态顶端渲染（`WorkbenchApp.tsx:979–987, 1202–1204`; `GraphNotebook.tsx:127–130`）。候选确认通过 `chooseChapterTopic → navigateToChapter`；解析保存的 scope 和 `activateScope` 标志随候选带入，跨范围时仅在确认后激活目标范围（`WorkbenchApp.tsx:503–553`）。需由独立 HTTP+SQLite 页面验收确认卡片态、资料库态和跨范围选择的真实可见性。
- **A09**：共享 `loadNote` 在替换编辑内容前按 `(topicId, chapterId)` 检查当前 note identity；同身份复用既有 active note，不执行 GET、不切换 loading 状态，也不清理 debounce timer。其他身份仍先通过 `prepareContentTransition/flushActiveNote` 安全离开（`WorkbenchApp.tsx:318–337, 402–440`）。定向回归覆盖同身份复用，但 localStorage quota 失败加快速重复点选仍需独立页面验收。
- **A05**：树、卡片、图节点、搜索节点、候选主题、资料库和返回均从共享导航入口取得单调 intent；章节解析和搜索详情使用 `commitLatestNavigation`，提交前核验 intent，后续等待中的内容切换再次核验（`WorkbenchApp.tsx:402–455, 459–493, 503–594, 596–624`）。定向回归确认旧异步导航被较新 intent 丢弃。实际延迟 HTTP 场景由独立代理复测。
- **A12**：Graph 节点命中从 `api.selectGraph(scope).nodes` 搜索，而不是限于 `WorkbenchGraph` 的 `selectGraphWindow` 260 节点窗口（`WorkbenchApp.tsx:807–820`; 服务端 `selectGraph` 返回完整范围节点，`services/knowledge-core/src/services/graph.ts:168–245`）。命中后通过当前 GraphScope 导航；内容选中节点会进入 renderer window，故未绘制节点也能定位而不改范围。定向回归覆盖共享章节包含于完整选择但不在绘制窗口的情形；真实跨范围 HTTP+SQLite 操作仍待独立验收。

定向 Vitest 再运行结果：3 个文件、12 项测试通过。上述是代码级复核结论；没有启动浏览器，也不替代 independent_review 的真实 HTTP+SQLite 整页验收，因此不单独据此宣告可发布。

## P3 renderer 修复独立复核（2026-10-20）

### A13：scope 切换时写回旧 Graph 视野

目前 effect 把创建时的 `scopeIdentity` 和 `activeState` 快照传给 `scheduleGraphStateWrite`；cleanup 仅在 `stateSnapshotRef.current.scopeIdentity` 已变为另一范围时，同步写回该旧快照。新 scope render 会先更新 snapshot ref，随后 React 清理旧 effect，因此 A→B 的 cleanup 比较的是 B 与闭包内 A，并写回 A；同范围 camera／positions 更新只取消旧 debounce 并重排，不会同步写旧快照。卸载时仍由单独 cleanup 写最新快照。组件接线与 helper 的范围判断一致（`WorkbenchGraph.tsx:143–144, 200–212`；`workbench-graph-state.ts`）；定向测试覆盖 captured old scope flush。代码复核通过，快速 A→B→A 实际存储／恢复仍由 CDP 验收代理确认。

### A11 / AX：屏幕尺寸、焦点及拖拽点击

- `graphScreenSizeScale` 反向补偿 camera 与 SVG viewBox 缩放；13px label、透明 24px hit circle 的尺寸因此按 CSS 屏幕像素计算。标签碰撞在实际 viewport 的屏幕坐标里测量，hover／focus／selected 节点的 label 保留；隐藏文字时仍保留焦点节点标签。节点有 roving `tabIndex`、`role="button"`、名称和关系数 `aria-label`、`aria-pressed`、focus 样式；节点键盘处理与 canvas 键盘处理按 `event.target` 分开，箭头在节点间移焦、在画布本身时平移，Enter／Space 由节点处理器只调用一次 `onNodeOpen`。图节点是 SVG `g` 而非原生 button，普通键盘不会再触发一套原生按钮 click；AT 生成 click 的真实行为仍应由浏览器／读屏路径验收。
- 节点 pointerdown 清掉旧抑制标记；超过 4 CSS px 的 node drag 在 pointerup 后只抑制对应节点的下一次有指针 `click`，并消费标记。正常点击不会设标记；拖动后未发出 click 时，下一次实体 pointerdown 也会重置标记。因此未发现拖动吞掉下一次真实点击的代码路径。`prefers-reduced-motion: reduce` 覆盖图内动画和 transition。上述是代码调用链判断，物理 pointer 与浏览器键盘／AT 测试仍由 independent_review 完成。
- **待对齐的 A11 尺寸偏差**：`p3-results.md` 声称节点圆点半径为 3.8–5.8 CSS px，`workbench-graph-view.ts` 的 `graphNodeRadius()` 和 `resolveGraphLabelIds()` 也按此范围估算标签起点；但实际 SVG 绘制在 `WorkbenchGraph.tsx:431` 使用另一公式 `min(7.2, 4.3 + sqrt(degree) * 0.62)`，故圆点实际为 4.3–7.2 CSS px。高连接度节点与碰撞函数所用圆点半径最多相差约 2.1px，报告的 3.8–5.8 范围也不符合实际绘制。请确认实际绘制值是否有意放大；若仍以报告值为准，渲染和碰撞应使用同一 `graphNodeRadius` helper。可用 degree 22 的节点检查：绘制半径达到 7.2px，而 helper 约 5.1px。

P3 定向 Vitest 再运行结果：3 个文件、8 项测试通过。A13 代码路径及 drag／keyboard 基本处理未发现新的阻塞问题；A11 圆点半径与碰撞／记录范围不一致需要 owner 决定并对齐后，再由独立代理确认实际画面。此代码复核未启动浏览器，不替代页面验收。

## 最终定点复核（2026-10-20）

- **Parentless tree chapter**：`selectTreeNode` 对 `selectionForTreeNode === null` 的根级章节直接转入 `resolveParentlessChapter` 并沿用该点击的 intent，没有先把章节 ID 当资料库 item 筛选或切入 Library。先从章节详情的真实 `part_of` topic 关系推导并去重一级范围，再调用既有 `resolveChapter`；无法映射时只逐个现有一级 `selectGraph`，同时验证章节节点和至少一条有效 chapter→topic 边后才调用 resolver。唯一结果进入正文，多候选使用通用选择面板；无有效目标或请求失败时当前正文和草稿不变。草稿安全仍由 `applyChapterTarget → navigateToChapter → prepareContentTransition` 统一处理，旧请求按同一导航 intent 丢弃（`WorkbenchApp.tsx:458–500, 510–596`）。代码路径复核通过。
- **A11 radius mismatch**：已消除上一节记录的 renderer/helper 不一致；节点 SVG 绘制现在直接复用 `graphNodeRadius(degree)`，与屏幕碰撞函数和报告声明共用一个半径计算（`WorkbenchGraph.tsx:7, 431`; `workbench-graph-view.ts`）。
- **A13、pointer 与 keyboard 闭环**：scope cleanup 仍用新 render 更新后的 `stateSnapshotRef.scopeIdentity` 判断 scope 是否变化，并将旧 effect 捕获的 scope 和 snapshot 写回。node drag 仅抑制对应节点下一次有指针 click，后续实体 pointerdown 重置标记；键盘 Enter／Space 只走 SVG `g[role=button]` 的自定义 key handler，canvas handler 会因 target 不同跳过，代码内没有第二个原生按钮激活路径。Reduced-motion CSS 仍覆盖图控件内 transition/animation。此前的结论保持；实体 pointer、浏览器键盘及 AT 路径由 independent_review 实际验收。

此次定点 Vitest 复跑：4 个文件、15 项测试通过；`git diff --check` 通过。整体 desktop `tsc` 和 Vite build 已由主代理报告通过。**前端静态代码复核结论：通过，未发现本轮定点缺陷仍阻止发布。** 该结论不等于整页最终可发布：parentless 共享章节真实 HTTP+SQLite、实体拖拽／点击、A11 屏幕实际尺寸及快速 scope 恢复仍需 independent_review 完成并据其结果决定最终发布。

## A11 控件与密集布局真实页面补充（2026-10-20）

使用独立 Chrome 155.0.8059.84 target、1360×900 / DPR 1、production preview 1433 和隔离 SQLite/API 1431；测试数据仍是专用 A12 学科，未碰 CS/Python/C++ fixture，也未触碰 independent_review 的 target。页面实际 GraphSelection 为 1200 节点、800 条边，renderer 绘制 260 个节点。

- 标签控件真实页面结果：`隐藏文字`保留当前固定标签；鼠标悬停另一个节点后其标签出现（总计 2 个），离开后回到 1 个。对一个非选中 SVG 节点触发 DOM focus 后，等待 React focus 状态提交，节点标签变为可见。`显示全部文字`显示 260 个标签；`自动显示`回到 21 个。Reduced-motion emulation 命中，标签、圆点和 Graph canvas 的 computed transition/animation duration 均为 `1e-05s`。
- **密集图布局阻塞**：首绘截图发生在仅扩展 Graph、打开设置菜单后；未对 canvas 做 pointer 操作或拖动。读取 260 个实际 SVG transform，x 触边坐标 `20/980` 共 138 个，y 触边坐标 `20/680` 共 183 个，四角坐标同时触边 61 个。位置范围正好等于 `layoutGraph` 每轮迭代使用的 clamp 边界（`workbench-graph-layout.ts:172–173`）；截图呈四边节点框线和内部大量交叉连线。该结果证实首绘力布局在 260 节点密度下撞满硬边界，不是测试手势造成。标签状态逻辑虽响应，但在该布局下边缘标签也会重叠，不能据此判为 A11 高密度可读性通过。
- 证据：[`a11-runtime-results.json`](a11-runtime-results.json)、[`a12-large-graph-first-paint.png`](a12-large-graph-first-paint.png)、[`a11-hidden-hover.png`](a11-hidden-hover.png)、[`a11-all-labels.png`](a11-all-labels.png)、[`a11-auto-labels.png`](a11-auto-labels.png)。A12 图外搜索、选中并保持 scope 的功能结果仍按上一节单独记录为通过；长标签在 viewport 边缘裁切及此布局问题不改变其功能结果。

**当时真实页面发布判断：阻塞（2026-10-20）。** 该 A11 布局阻塞已由 2026-10-21 的 final fresh-context 复拍关闭；同 fixture 的 260 节点布局不再饱和边界。详见下方“A11 final independent fresh-layout recheck”及 [`a11-final-independent.md`](a11-final-independent.md)。其余实体 gesture 与窄窗项仍由 independent_review 验收。

## Library debounce loading 修复定点复核（2026-10-20）

Workbench library items effect 现在在 effect setup 阶段只创建 debounce timer；`setLoading(true)`、清空旧 items 和发出 `listItems` 请求都放在 timer 实际启动且 request ID 仍为最新的 callback 内（`WorkbenchApp.tsx:912–949`）。因此未触发的 timer 被导航 cleanup 取消时，不会制造空列表或遗留 loading。`invalidateItems` 先递增 generation、清理 error/loading/loadingMore，但保留现有 items（`WorkbenchApp.tsx:966–970`）。effect cleanup 只有在当前 request ID 仍匹配时才使其失效；仅当 timer callback 确实启动后才清 loading。过时网络响应的 success、error、finally 也都按同一 request ID guard，因此旧 cleanup 和旧 Promise 不会清掉较新请求的 loading。

`scheduleLibraryItemsLoad` 返回的 `started` 只在 callback 入口设置，cleanup 对未触发 timer 只取消 timer；fake-timer 两个定向用例覆盖取消前与 callback 后状态。实际 effect 接线复核通过。独立重跑 `library-items-query.test.ts`、`graph-navigation.test.ts`、`workbench-graph-state.test.ts`、`workbench-graph-view.test.ts`：4 个文件、14 项测试通过；`git diff --check` 通过。此项代码复核通过；真实界面中的根级共享章节返回／进入 Library 流程仍由 independent_review 在 1433 环境确认。

## P2 恢复草稿标题与关系语义定点复核（2026-10-20）

- Chapter pending-draft row 与 `openDraft` 共用 `graphChapterTitle`：先用当前 Graph 中对应 chapter 节点标题，再查精确 `(topicId, chapterId)` 的 `chapterTitle` index，再查真实 tree chapter；都缺失时返回中性“章节正文”，不把 UUID 当标题（`graph-navigation.ts:70–83`; `WorkbenchApp.tsx:715–729, 1251–1255`）。仅当恢复标题仍是中性回退时才按需请求 `api.nodeDetail(chapterId)`；只接受返回类型为 chapter 的真实标题，并在异步返回后检查当前导航 intent。请求失败或节点已不存在时保留中性标题。
- `loadNote` 为当前 note identity 并发读取正文和该 topic 的 `listGraphNotes`；只接受当前 request ID 的结果。服务端 index 根据真实节点标题和当前 topic 的有效 `part_of` 关系计算 `chapterTitle` / `attached`（`WorkbenchApp.tsx:347–366`; `services/knowledge-core/src/services/graph.ts:286–310`）。
- 脱离状态统一经 `graphChapterAttachment(notes, topicId, chapterId)` 精确匹配两个 ID；无匹配返回 `null`，仅显式 `attached:false` 才返回 `detached`。Pending-draft row 与 GraphNotebook 当前正文 badge 都调用该 helper，因此 C 的 detached index 不会被应用到 `(C++, 同一 chapterId)`，索引未加载也不会误显示脱离 badge（`graph-navigation.ts:85–93`; `WorkbenchApp.tsx:1251–1255`; `GraphNotebook.tsx:124–125, 180–186`）。
- **残留 topic-row 回退**：主题草稿的恢复函数在 Graph/tree 都找不到 topic 时使用“主题概览”，但待同步列表的主题分支仍退回显示 `draft.topicId`（`WorkbenchApp.tsx:717–719, 1252–1254`）。例如节点已删除／不在 tree 的本机草稿，列表仍会把 ID 当标题显示。若“草稿 row 不显示 UUID”也覆盖主题草稿，最小修正是让该 row 使用同一个“主题概览”中性回退。
- `graph-navigation.test.ts` 的 parentless “变量”回归覆盖 C++ attached、C detached、无索引中性标题；我在本轮只读复核中重跑该文件：8 项测试通过。章节标题、按需详情和 exact detached 路径通过代码复核；主题草稿 row 的上述回退是本轮唯一发现，现有 helper 测试没有覆盖 stale topic 的 React 行。未启动真实页面；P2 报告中的 desktop `tsc`、17 项定向测试、Vite build 和 diff-check 为主代理已报告结果，本结论仅为代码调用链复核，不替代当前 independent_review 页面验收。

## A11 final independent fresh-layout recheck（2026-10-21）

**通过：旧的 260 节点 clamp 饱和视觉阻塞已关闭。** 在独立 Chrome 155 context、1360×900 / DPR 1、1434 final preview（页面实际加载 `/assets/main-CNMyiAbG.js`，SHA-256 `fb7968591fcaf2be1415e2a8b190b1977f6dfabf95f76d8e202c28c9532f1fa8`）中，使用真实 API 1431 与隔离 A12 SQLite 学科。GraphSelection 为 1200 节点／800 条边；scope localStorage 初始为空。首绘约 395ms 后 DOM 为 260 节点／173 条可见边，自动标签 16 个且 computed font-size 为 13px。旧边界 x=20/980、y=20/680 命中均为 0；坐标 bounds x=209.20–790.80、y=40–660。关系边中位长度 97.97，非边节点对中位距离 305.05，比例 0.321；实拍为云状布局，不再沿矩形边界堆积。

同一范围内搜索首个 260-node window 以外的真实长标题主题后，稳定结果约 263ms，打开正文约 374ms；目标与两个真实相邻章节进入 Graph window，目标点位于 SVG viewport 内。没有第二次 GraphSelection 请求；已有 260 个保存位置最大变化为 0，camera 保持 `{x:0,y:0,scale:1}`，搜索输入清空。长标签在右边界处裁切仍存在，但搜索结果和正文标题完整可读，属于已记录的画布边缘裁切，不构成该验收阻塞。

P2 topic draft row 已使用中性回退“主题概览”（`WorkbenchApp.tsx:1252–1254`），不再把失效 topic ID 显示为标题。最终 A11 证据详见 [`a11-final-independent.md`](a11-final-independent.md)、[`JSON`](a11-final-independent.json) 与两张实拍图。最终冻结资产的 A11 布局及本轮 late-search 位置／scope 行为通过；这项结果不替代 independent_review 尚余的 A10/A13 实体手势和窄窗验收。

## More 入口最终实际复验（2026-10-21）

使用 Chrome 155.0.8059.84、1360×900 / DPR 1、独立 CDP context、生产预览 `127.0.0.1:1433/main.html` 与真实隔离 API 1431 / SQLite `/private/tmp/noltri-graph-v31-acceptance/acceptance.sqlite`。实际加载资产与最终候选一致：JS `main-DT-f2E1U.js` SHA-256 `972fef7e1ab0e03c21d04dbf94a85da40563f31369206509290123e687f1c5ea`；CSS `main-BjTal5WU.css` SHA-256 `c2d22f4b0a95abadfd0ef7b87979ba22b35e6e7cca4f27b31228688e23cce263`。当前隔离数据下 CS 卡片态显示 7 个主题、编程显示 5 个；以下记录按实际页面数量，不沿用旧截图计数。

- **主题卡片 More / 右键**：实体点击卡片“更多”按钮打开“机器学习”信息面板；关闭后对卡片正文实体右键也能打开同一面板。面板位于中间内容区、卡片滚动区之前，实测 rect 为 `x=308, y=200.2, 760×146.4`（1360×900 viewport）；关闭按钮可用，摘要、来源统计、分类选择和关系内容在面板内。截图：[More 按钮](more-card-topic-1360x900.png)、[卡片右键](more-card-contextmenu-1360x900.png)。
- **Graph 主题键盘 More**：在仍显示 CS cards 的情况下展开 Graph，聚焦 Graph 主题 C++ 并通过 CDP 真实 Shift+F10 打开 C++ 面板；没有触发正文打开或候选面板，标题与卡片页态保持。截图：[Graph Shift+F10](more-graph-shift-f10-1360x900.png)。
- **共享章节无语境 More**：在同一 cards 页对 Graph 章节“变量”真实 Shift+F10；由于没有活动主题语境，页面显示 Python、C++ 两个候选，没有任取第一条关系。候选 pane rect 为 `x=286.8, y=32, 612.4×126`，C++ 按钮位于 viewport 内。实体选择 C++ 后打开 C++ More，notebook 标题仍为“计算机科学”、cards 数仍为 7、scope eyebrow 仍为“计算机科学”；后续请求为 `resolve-chapter` 和 C++ node detail，没有触发 `/api/notes` 正文读取。此起点是 cards（没有活动正文／草稿），确认 More 流程保留原卡片内容态和范围，且不启动正文导航。截图：[候选](more-shared-chapter-candidates-1360x900.png)、[选择后 More](more-shared-chapter-target-1360x900.png)。

以上三条实际入口通过，修复后的 More 区域可见且可操作；本项最终前端 gate 通过。CDP context 已关闭。1431/1433 是已存在的共享验收 listener，本轮未启停；没有改产品源码。
