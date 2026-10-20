# Graph v3.1 · P2 页面导航与正文编辑

日期：2026-10-20

## 变更范围

- `apps/desktop/src/workbench/WorkbenchApp.tsx` 分开保存 GraphScope 和当前正文选择；一级学科、二级方向进入主题卡片页，主题与章节走直接正文编辑；右侧提供“展开graph view”入口、小图和可调展开图。展开范围内连续选点不重设范围；按主题／章节身份保存阅读滚动位置和返回历史。
- `apps/desktop/src/workbench/GraphNotebook.tsx` 提供主题卡片、章节目录、正文、候选主题选择、搜索结果与中间“更多”区域。主题卡片由既有 `MemoryCard` 壳渲染，使用真实节点标题和摘要；原资料 item 分支的 DOM、来源日期、subjectPath、对读按钮及原有交互没有改写。主题没有来源或日期字段，故不补造这些展示值。
- `apps/desktop/src/workbench/note-drafts.ts` 按 `(topicId, chapterId|null)` 隔离本机恢复草稿；服务器成功后只清除已确认的草稿版本，避免并发输入被清掉。`graph-navigation.ts` 将真实树路径映射为范围与内容选择。
- `apps/desktop/src/workbench/workbench.css` 仅追加 notebook、右侧分栏、暗色主题与恢复入口样式；旧资料卡片基础几何规则未更改。深色为首次默认主题，切换偏好保存在 localStorage。
- P2 未改动 Graph/notes 存储模型，不执行正文或关系迁移；正文和关系仍通过 P1 API 按稳定节点 ID 访问。

## 已落地的交互与保护

- Graph范围与正文上下文独立：树节点映射到 discipline、subdiscipline、topic 范围；点击展开图的主题／章节只改变中间正文。章节使用 `resolveChapter`，多候选在中间明确选择；无效目标保留当前正文并提示刷新。树上没有 topic 祖先的 parentless 章节按 `nodeDetail.relatedNodes` 的真实 `part_of` 主题定位一级范围；若详情无法映射范围，才逐现有 discipline GraphScope 检查有效 chapter→topic 边，绝不伪造 parent ID 或退回资料过滤。
- 编辑器是中间区直接 textarea。变更后 650 ms 自动保存，写入按序串行；每次输入先尝试本地草稿。仅服务器确认后标为“已保存”；失败状态提供重试。正文载入失败且没有本机草稿时编辑器只读，避免空内容覆盖旧正文；异步读取按请求序号丢弃过时响应。
- 服务端上限使用 `MAX_GRAPH_NOTE_CHARS`（40,000 JS 字符）。输入不按上限截断；超限内容保留在编辑器及本机恢复草稿，不发送必然失败的请求、不标为已保存，并显示实际字符数、上限和缩短提示。若本机草稿不可写，界面说明无法恢复，且切页会被阻止，直到服务器保存成功。
- 返回历史恢复前一正文、Graph范围／模式、导航折叠状态与该内容的滚动位置。Graph面板以 grid 分栏展开，不覆盖正文；右侧宽度支持拖动和分隔器键盘调整。窄窗检查用 `48ch` 编辑器宽度探针及 ResizeObserver 测量中心列、侧栏和 Graph 面板实际尺寸，空间不足时退回右侧入口态；该测量阈值尚待运行界面验证。
- Graph、来源／分类／关系信息分区：来源、分类移动和关联主题在中间“更多”区域；章节关联和解除关系在正文上下文中；Graph本身不显示详情面板。卡片“更多”按钮及右键、Graph 节点右键／Shift+F10／ContextMenu 提供等价入口。

## 对照验收项

| 指南 | P2 代码结果 | 独立运行界面验收 |
| --- | --- | --- |
| D01 / A01 | 资料卡片 item 分支保留既有 `MemoryCard` DOM 和样式；主题卡片复用同一外壳及知识封面样式，只显示真实标题／摘要。 | 未完成：需以改前浅色截图、同宽同数据截图核对实际渲染差异。改前截图在 `pre-change-memory-cards-light-1360x900.png`；当前旧 UI 没有改前深色截图。 |
| D02–D03 / A04–A05 / A14 | 右侧分栏、正文直接编辑、主题小图／展开图和按需入口已接线；右侧没有来源／分类／统计详情面板；范围内切节点不更换scope。 | 未完成：需实际渲染确认布局、正文可编辑性、切换时视野稳定和右侧常态内容。 |
| D05 / A02–A03 | discipline 与 subdiscipline 树路径分别创建正确的 GraphScope，并显示精确入口文字“展开graph view”。 | 未完成：需真实树数据检查一级／二级范围隔离和共享 ID 去重。 |
| A07–A09 / A13 | 章节解析、候选选择、内容返回栈、失败草稿恢复／重试、拒绝不可恢复切页和窄窗收图已实现。 | 未完成：需用真实 HTTP + SQLite 路径走通编辑、保存失败、重开恢复、返回和窄窗交互。 |
| A10–A12 / A11 | P2 接入 P3 Graph 手势、密度／主题 renderer 与范围搜索；P3 renderer 的独立实现及测量见 `p3-results.md`。 | 未完成：整页运行下的手势、深浅对照、大范围／搜索命中待独立验收；本报告不据 renderer 单测宣称整体验收通过。 |
| A06 / A08 | 正文按主题＋章节身份调用 P1 API；连接／解除关系保留在正文上下文中。 | 数据层由 P1 负责；仍需独立端到端检查不同主题正文隔离、取消归属后内容／来源保留。 |
| A15–A16 | 属于指南第 6 节保留的原阶段能力，不在 P2 页面导航／正文编辑实现范围内。 | 原阶段未实现的能力与本轮待独立验证事项分开记录；不代表这些能力已完成。 |

“修改记录”属于指南第 6 节保留的原阶段能力，当前 `nodeDetail` 与 P2 `WorkbenchApi` 没有版本记录读取方法；`versionListResponseSchema` 存在，但没有可调用的服务路由／客户端契约。P2 没有虚构历史数据，也未新增后端范围；这不是本轮新增页面导航／正文编辑的替代项。

## 自动检查

下列检查在完成 P2 当前补丁后于本机执行：

| 目录 | 命令 | 结果 |
| --- | --- | --- |
| 仓库根目录 | `./node_modules/.bin/tsc -p apps/desktop/tsconfig.json --noEmit` | 通过 |
| `apps/desktop` | `../../node_modules/.bin/vite build` | 通过，Vite v8.3.2；显示既有 `configLoader: 'native'` 对 `__dirname` 的前瞻兼容提示，不影响构建 |
| `apps/desktop` | `../../node_modules/.bin/vitest run src/workbench/note-drafts.test.ts src/workbench/graph-navigation.test.ts src/workbench/workbench-graph-layout.test.ts src/workbench/library-items-query.test.ts` | 4 个文件、17 项测试通过 |
| 仓库根目录 | `git diff --check` | 通过 |

单测覆盖树路径到章节主题及范围映射、内容身份稳定性、本机草稿按身份隔离、服务器确认版本清理、超限文本本机完整保留，以及 P3 布局窗口。没有用模型单测代替真实页面验收。

## 尚未验证

- 未启动 Workbench 做实际浏览器／WebView 截图；故卡片同宽视觉、真实编辑宽度、窄窗口折叠、深浅主题实观和读写流程均待独立验收。
- 本轮没有自行跑真实 HTTP + SQLite 的整页操作链，也未回归快速收录与论文页；由独立验收代理接手。
- 本地草稿是浏览器 localStorage 故障兜底，不替代 SQLite 成功状态；浏览器存储被禁用或 quota 满时，代码会保留页面并提示重试，但该宿主环境场景未做 UI 实测。

## 独立代码审查后的修正（2026-10-20）

- **A07**：多主题章节的候选选择面板在资料库态由 `WorkbenchApp` 放入中间主区，在主题卡片／正文态由 `GraphNotebook` 放在页面内容之前；候选携带解析时的 `scope`，只有用户确认主题且草稿可安全离开后才切换范围。覆盖卡片、资料库、搜索遮挡和跨范围章节时仍需实机复测。
- **A09**：`loadNote` 以稳定 `(topicId, chapterId)` 身份复用当前正文，不再清空编辑器或重新 GET；显式“重新载入正文”仍强制请求。离开当前正文时 `flushActiveNote` 等待保存，并在等待期间若同一正文又有新输入则继续保存最新版本；本机草稿不可用且服务器保存失败时保留当前编辑器并阻止切换。
- **A05**：章节解析、节点详情、章节候选、正文载入和返回导航共用单调导航意图；所有异步结果提交前检查是否仍为最新操作，旧解析不再覆盖后来选择的章节、主题、卡片页、资料库或返回操作。
- **A07（parentless 章节补充）**：侧栏根级共享章节不会再把其 ID 当资料库筛选节点。先用节点详情的真实 `part_of` 主题推导并去重一级范围，再通过同一个 resolver 确认唯一主题或显示候选；详情无法给出可用范围时，以各现有一级 GraphScope 的有效节点／边作为回退。没有有效关系时提示并保留当前正文、草稿和资料库内容。无需新增 API。
- **A07（保留资料库状态）**：资料列表 effect 现在只在 debounce 回调真正启动 `listItems` 时清空旧结果并设置 loading。debounce 尚未开始便被取消时不会清空卡片或留下 loading；`invalidateItems` 仅使旧响应失效并结束旧 loading，列表数据由实际的新请求启动时重置。新增 `library-items-query.test.ts` 使用 fake timers 验证取消的 debounce 不运行请求／加载回调。parentless 候选路径本身不改变 Library filter 状态。
- **A12**：Graph 节点命中直接在当前完整 `GraphSelection.nodes` 上按稳定 ID、标题和摘要筛选，不再依赖 `parentId` 子树。原 `/api/search` 范围调用继续提供资料命中；其知识节点结果被忽略，避免遗漏／重复共享章节。资料命中仍能打开原资料详情。
- 新增可运行回归覆盖导航旧响应丢弃、同身份正文复用、parentless 共享章节关联主题到一级范围去重，以及“父节点位于另一二级范围但已由当前 GraphSelection 的 `part_of` 关系纳入”的共享章节搜索。它验证这些映射 helper；卡片／资料库实际可见性及 HTTP+SQLite 操作仍由独立界面验收确认。

## 恢复草稿标题与归属语义修正（2026-10-20）

- 草稿标题按当前 Graph 节点、精确 `(topicId, chapterId)` 的 notes index、真实树节点依次查找；若均不可用，章节正文显示中性“章节正文”并在恢复时按需读取 `nodeDetail` 作为标题兜底，主题草稿行显示“主题概览”，不暴露节点 UUID。
- “未归属章节”只在 notes index 对当前 `(topicId, chapterId)` 明确返回 `attached: false` 时显示。共享章节在另一主题下的 detached 记录不会误标当前已关联正文；索引尚未加载时不显示错误的脱离标签。
- `graph-navigation.test.ts` 增加 parentless “变量”章节的回归：C++ 关联项保留真实“变量”标题与 attached 状态，C 的 detached 项仍显示 detached，未知关系保持中性。

## 发布前 More 入口修正（2026-10-21）

- 现有 More 面板改为卡片与正文共用的中间主区内容，面板限高并可滚动；主题卡片自身 DOM 和正文／草稿选择保持不变。
- Graph 章节 More 先通过当前 GraphScope 的 `resolveChapter`，并在有效时传递正文中的活动主题；单一归属打开对应主题 More，多归属显示中间候选，选择后打开对应主题 More，不切换正文或范围。无归属保留现有内容并提示，不再取第一条边。
- `graph-navigation.test.ts` 覆盖 cards 状态下 More 面板 SSR 可见及 chapter More 候选提示。此次修改后 desktop `tsc`、该文件 9 项 Vitest 和 `git diff --check` 通过；生产构建与实际 viewport／HTTP 路径由发布准备及独立 UI 验收复跑。

恢复草稿标题修正后执行的 desktop `tsc`、4 个文件共 17 项针对性 Vitest、Vite production build 与 `git diff --check` 均通过。构建只报告 Vite `configLoader: 'native'` 对现有 `__dirname` 的兼容提示；没有新增依赖。独立真实界面／SQLite 验收尚未完成，故不据这些自动检查宣称 A05、A07、A09 或 A12 的端到端验收通过。
