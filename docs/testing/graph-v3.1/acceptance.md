# Graph v3.1 独立验收

日期：2026-10-20 至 2026-10-21（Asia/Shanghai）
结论：**本轮 Graph v3.1 的 A01–A14 实际验收通过；指南 A15–A16 的原阶段缺项仍未完成，不计为本轮通过。** 最终 More 入口 focused 复验、冻结源码构建、最终包扫描及证据 ZIP 均已闭环；全仓自动测试为 563 项，Rust 为 12/12。完整资产清单与 SHA-256 见 [发布准备记录](release-preparation.md)、[发布说明](../../releases/0.1.3.md) 和 [SHA256SUMS](https://github.com/wyzh0117/noltri/releases/download/v0.1.3/SHA256SUMS.txt)。

## 环境与验收边界

- 桌面 production preview：`http://127.0.0.1:1433/main.html`；实际 API：`http://127.0.0.1:1431`。浏览器为 Chrome CDP，窗口基准 1360×900 CSS px / DPR 1；另以实际窗口缩至 900×800 检查窄窗。
- API 使用真实 localhost HTTP 与隔离 SQLite `/private/tmp/noltri-graph-v31-acceptance/acceptance.sqlite`，验收用户 `graph-v31-acceptance-user`。CS/Python/C++ 测试资料和 A12 性能学科均为隔离验收数据，未触碰用户生产数据库。
- Web 页面只注入 `get_settings` Tauri 测试桥，将服务地址指向 1431；Graph、搜索、章节正文、保存、草稿恢复和 SQLite 回读都经过真实页面请求与真实服务。A09 的一次 HTTP 500 仅由 CDP 对指定 `PUT /api/notes/*` 注入，后续 GET、重试 PUT 与 SQLite 写入均是真实路径。
- 指针拖拽、平移、缩放与点击用 CDP `Input.dispatchMouseEvent` 物理输入；没有用 DOM 合成事件替代手势检查。验收未修改产品实现、未执行 commit/push/tag/release。

## A01–A16 证据矩阵

| 验收项 | 结论 | 独立运行证据与边界 |
| --- | --- | --- |
| A01 改造前后知识卡片 | **通过（视觉延续；不声称逐像素一致）** | 同为 1360×900 浅色界面，改前与改后四张既有资料卡片的外框、列宽和卡片主体几何基本一致（卡片约 232×406 CSS px），标题、摘要、来源、日期、学科路径和对读动作仍在。截图：[改前](pre-change-memory-cards-light-1360x900.png)、[改后](post-change-library-cards-light-1360x900.jpg)。两张图的顺序及日期值不同，来自 fixture 排序/时间差；不据此宣称完全相同的数据或像素级对比。 |
| A02 一级学科入口 | **通过** | 点击“计算机科学”后呈现其 4 张主题卡片，入口文案精确为“展开graph view”；收图入口态没有提前绘制 Graph 节点。截图：[A02](a02-cs-entry-light-1360x900.png)。 |
| A03 二级方向入口 | **通过** | 点击“编程”后呈现其 3 张主题卡片，显示相同精确入口文案；本范围没有把数据库等其他二级独有主题带入。截图：[A03](a03-programming-entry-light-1360x900.png)。 |
| A04 主题卡片到正文和展开图 | **通过** | 入口态选 Python 后进入直接编辑正文，右侧小图可展开；展开后正文仍可见，导航自动收起，没有 Graph 覆盖正文或转成全屏弹窗。截图：[A04](a04-python-note-graph-expanded-light-1360x900.png)。 |
| A05 连续切主题／章节 | **通过** | 在已展开范围内以真实节点点击切 Python、共享“变量”章节和其他主题正文；正文、选中节点更新而 Graph 范围不变。已有节点位置和 camera 不因打开正文而重排；A13 另记录精确视野恢复。真实导航旧响应竞态在修复后通过定向 UI 路径复测，细节见 [P2 记录](p2-results.md)。 |
| A06 Python／C++／C 共享章节关系及正文隔离 | **通过** | 隔离真实节点和 `part_of` 关系下，同一“变量”章节以单一节点连接多个主题；章节通过显式候选进入 Python/C++/C 的真实语境，笔记按 `(topicId, chapterId)` 区分。C、C++、Python 正文分别打开，不发生串写；后端关系和主题语境断言见 [P1 验收](p1-results.md)，真实共享章节 UI 截图见 [候选选择](e2e-chapter-candidate-programming-dark-1360x900.png) 与 [正文 Graph](final-ui-cpp-variable-light-graph-expanded-1360x900.png)。 |
| A07 从卡片、资料库和搜索打开共享章节 | **通过** | 多主题章节显示在中间主区的候选，不改右侧详情；选择后才切入目标主题／Graph scope。另验证 Library 根级 parentless “变量”不作为 `nodeId=chapter` 过滤资料；Python/C++/C 候选可选，原 4 张资料卡片与数量保留，没有假 loading，选择 C++ 后进入正确正文。该场景和最终 More 复验使用不同隔离 fixture 快照；后者当前 CS 卡片态显示 7 项、编程显示 5 项，数量差异来自 fixture 快照，不是数据丢失。修复后恢复状态见 [parentless 候选截图](e2e-library-parentless-variable-candidate.png)；标题闭环见 [A09 恢复截图](a09-recovered-variable-title-fixed-light-1360x900.png)。旧失败截图保留为历史记录，不代表最终状态。 |
| A08 通过不同入口编辑并解除一条关系 | **通过** | C–“变量”真实 `part_of` 边由 3 条变为 2 条；C 的正文保留并显示该章节已脱离，Python/C++ 关系仍在。只删除了归属边，SQLite 中 `raw_sources` 与 `knowledge_items` 计数均仍为 4，原始来源和正文未删除；共享正文依主题隔离。截图：[解除关系后](a08-c-variable-disconnected-shared-note-dark-1360x900.png)。 |
| A09 保存失败、重开、恢复和重试 | **通过** | 成功保存路径由真实 API/SQLite 验证；随后只对一次真实页面 PUT 注入 500。界面保留完整正文，显示失败与可恢复草稿；刷新后仍可见待同步草稿，恢复并显式重试成功、草稿行消失，SQLite 只读回读一致。`localStorage.setItem` 故障时同 identity 快速重选也没有清空正在编辑的输入。P2 标题/归属修复后的复测中，恢复行显示“章节 · 变量”，正文标题为“变量”，范围为“计算机科学 / 编程 / C++”，没有错误的“脱离”提示；恢复后自动保存成功。SQLite 的 C++×变量正文长度 106，末尾含 `A09_TITLE_FIX_RECHECK_2`，`updated_at=2026-10-20T16:03:19.535Z`。截图：[注入 500 后](a09-title-fix-put-500-before-reload.png)、[恢复后标题与正文](a09-recovered-variable-title-fixed-light-1360x900.png)。历史初次恢复失败记录保留于 [P1 review](p1-review.md)／[前端 review](frontend-review.md)，修复与本次实际复测闭环已记录。 |
| A10 hover、点选、拖拽、空白平移、滚轮和键盘 | **通过** | 真实指针拖 Rust 节点后坐标变化而正文 identity 未变，证明拖动没有误触导航；空白拖拽改变 camera 平移，滚轮改变缩放，正文仍为同一节点。聚焦可访问 Graph 节点后 Enter 打开对应正文；在 textarea 输入文本后焦点保留在编辑器且没有被 Graph 快捷键劫持。交互使用真实 CDP pointer/key 输入，A11 hover/focus 标签的独立数据见 [A11 复拍](a11-final-independent.md)。 |
| A11 深浅主题、稀疏／密集图、标签显隐与 Obsidian 参照 | **通过** | 同宽生产页面有浅、深主题截图：[light](final-frozen-light-graph-note-1360x900.png)、[dark](final-frozen-dark-graph-note-1360x900.png)。与官方 Graph 帮助页浅色截图及本机 Obsidian 1.14.4 默认深色参考对照（见 [P3 参考](p3-results.md) 和 [本机深色参考图](obsidian-default-dark-graph-reference.png)）：小节点、细边、近邻标签、hover/focus 邻接强调符合预期；Noltri 沿用应用绿调强调色，不是像素复刻。独立新 context 实测密集图为 260 节点／173 边、16 个 13px 自动标签；旧轴向 clamp 命中数为 0，连接边与非连接点中位距离比为 0.321。隐藏模式初始显示 1 个固定标签，hover 增至 2 个、离开回 1 个；focus 可显标签；show=260、auto=21；`prefers-reduced-motion: reduce` 时 computed duration 为 `1e-05s`。证据：[独立复拍报告](a11-final-independent.md)、[JSON](a11-final-independent.json)、[首绘图](a11-final-independent-1360x900.png)。 |
| A12 大范围、长标题、图外搜索、重名与范围隔离 | **通过（记录长标签边缘裁切）** | 真实 SQLite 有 1,200 节点／800 条边；`POST /api/graph/select` 返回 HTTP 200，410,944 bytes，本机一次请求实测 79ms。页面绘制 260 个节点，940 个折叠节点留在范围内，首绘约 273–274ms。初始 window 外 108 字符标题主题搜索稳定命中约 266–288ms，打开正文约 374ms；选中后真实相邻章节与边加入绘制、scope 不变、无第二次 GraphSelection；同名不同 ID 各自路由正确，跨一级哨兵搜索无结果。selected 长标签在右边界被裁切，但结果行和正文全标题可读。完整数据、请求和截图见 [A12 报告](a12-runtime-results.md)、[JSON](a12-runtime-results.json) 和三张配套 PNG。 |
| A13 展开／收起、返回、窄窗口与减少动效 | **通过** | 实际窗口改为 900×800 后 Graph 收为右侧入口，正文仍可编辑、页面无横向溢出或遮罩；截图：[窄窗](a13-narrow-900x800-cpp-note-light-crop.png)。长正文通过真实滚轮滚到 `scrollTop=180`，切到另一内容再点返回后仍为 180；Graph scope A→B→A 的 camera 也保持原值，最终布局测试已有 260 个节点坐标最大 delta=0 的范围稳定证据。减少动效结果见 A11。 |
| A14 右侧 Graph 正常态及菜单关闭后 | **通过** | 深浅 Graph+正文截图中右侧只见 Graph/入口及“适配、更多、收起”等必要图控件；无图例、演示规模栏、节点统计、摘要或分类详情面板。来源、分类及主题信息留在中间区按需打开。见 [light](final-ui-cpp-variable-light-graph-expanded-1360x900.png) 与 [dark](final-frozen-dark-graph-note-1360x900.png)。 |
| A15 待整理四级选择、保存分类、归档与撤销 | **原阶段部分实现；整项未通过，不属于本轮 Graph v3.1** | 基线真实回归确认分类失败保留原文、原有归档/恢复及已实现路径；但 `0.1.2` HEAD 无一级→二级→三级→章节 picker、章节 hover/focus 提示和整理完成后的结果跳转／撤销。详见 [原能力回归](baseline-regression.md)。这些缺项已按指南 §6 保留，不冒充通过。 |
| A16 论文重复转入、分类失败、来源复用及无目标诊断 | **原阶段部分实现；整项未通过，不属于本轮 Graph v3.1** | 基线真实回归确认旧论文摘录收录及分类失败保留原文；但同论文不同摘录没有共享来源实体，HEAD 无独立研究页或显式幂等“整理为学科知识”流程；掌握诊断界面／服务也不存在。详见 [原能力回归](baseline-regression.md)。未实现部分未被模拟或记为通过。 |

## 其他独立证据

- P1 API／SQLite 的原审查曾记录三个缺陷；历史保留。修复后的独立复核确认精确 grant、parentless 归属锚定、40,000 字符与 HTTP body 上限一致，以及真实 v6→v7 节点／边／来源迁移保留。见 [P1 修复复核](p1-review.md) 和 [P1 实跑结果](p1-results.md)。
- P2 导航、草稿隔离及恢复标题修复和自动化检查见 [P2 结果](p2-results.md)；renderer、布局、camera 持久化与本机 Obsidian 对照见 [P3 结果](p3-results.md)。
- P0 改前浅色 MemoryCard 截图和改后截图保存在本目录；没有改前深色主题基线，未虚构深色前后图。
- 版本 `0.1.3` 的较早候选记录已作废；More 修复后的最终构建、包内扫描和证据 ZIP 已闭环，早期候选不可发布。打包状态见 [发布准备记录](release-preparation.md)。

### More 入口最终定点复验（2026-10-21）

最终 release bundle 的独立 CDP 实测通过：主题卡片 More 按钮和卡片实体右键均在中间区打开可见、可关闭的信息面板；Graph 主题 C++ 的真实 Shift+F10 打开对应 More。对无活动主题语境的共享章节“变量”使用 Shift+F10 后，页面显示 Python/C++ 候选；选择 C++ 后打开 C++ More，原 CS cards 内容态（7 张卡片）和 CS scope 保持，没有发出正文 `/api/notes` 请求。测试使用 Chrome 155、1360×900 / DPR 1、真实隔离 HTTP API/SQLite；实际 JS/CSS SHA-256 与最终 release bundle 一致，详见[前端复核记录](frontend-review.md#more-入口最终实际复验2026-10-21)。实拍：[卡片 More](more-card-topic-1360x900.png)、[卡片右键](more-card-contextmenu-1360x900.png)、[Graph Shift+F10](more-graph-shift-f10-1360x900.png)、[共享章节候选](more-shared-chapter-candidates-1360x900.png)、[选择后的 C++ More](more-shared-chapter-target-1360x900.png)。当前隔离数据实测 CS 为 7 个、编程为 5 个主题；旧 A02/A03 计数来自较早页面基线，不是本轮观测数据。

## 发布判定

**Graph v3.1 功能验收：通过。指南 A01–A14 均有实际浏览器或真实 HTTP/SQLite 证据，修复前发现未从记录删除。指南全量 A01–A16：未全部完成，A15/A16 的原阶段能力明确留作未完成边界。** v0.1.3 冻结构建、资产扫描、最终测试证据 ZIP 与 SHA256SUMS 已封存；早期候选不得作为发布文件。长 selected label 的画布边缘裁切已披露，不影响搜索命中、目标选择、邻接展开或正文标题读取。
