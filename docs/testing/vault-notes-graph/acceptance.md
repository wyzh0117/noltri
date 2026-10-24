# Vault 笔记与关系图验收

范围按《Obsidian笔记与图谱-开发文档.md》§6–10。Markdown 与附件文件是正文真相，索引可重建；技术选型表为建议，附录 REA 命令不属于开发步骤。

## 当前交付状态

实现与自动化检查已收敛；Notes 长测的数据完整性窄项已通过，但原始 runner 仍标 invalid，且输入响应预算未达。部分浏览器与性能验收仍未测。下表区分代码/测试证据与实际 UI 证据，不把静态审查当成浏览器通过。

| 范围 | 实现 / 自动化 | 浏览器实测 | 当前状态 |
|---|---|---|---|
| Vault 文件、元数据、链接、历史、安全边界 | Core 15 files/224 tests、typecheck 通过；Mac 临时文件系统、HTTP、Node 24.18 arm64 packaged runtime 已测。详情见 [core.md](./core.md) 与 [review-core.md](./review-core.md)。 | Packaged smoke 验证 worker、create-only/folder etag 409、root-scoped settings、CRLF YAML rename、缓存/诊断和 SIGINT 退出。 | Mac Core 范围通过；Windows 原生文件系统行为未测，不作为本轮 Mac 阻塞。 |
| Mutation root 绑定 | API client 6 files/33 tests、typecheck 通过；Core header 为 `x-noltri-vault-root: encodeURIComponent(capturedRootPath)`，非法编码 400、旧根 mutation 409。Desktop root/path/epoch owner guards 已由独立静态复核；`openVault` 不带 mutation header。 | 同路径跨根 history-restore 延迟 ack 已实测：A 的 restore 已在服务端提交并 hold response，切到 B 的同名文件后释放 A ack 未回填 B；B 编辑保存后 A、B 磁盘内容分别符合预期。 | restore 狭窄路径通过；block-rename 延迟 ack 与其他跨根 mutation 组合仍待测。Core header 只校验 root，不切换 root。 |
| Notes、Live Preview 与草稿 | Desktop 15 files/107 tests、typecheck 通过；含 CRLF raw-offset 映射、source reveal、增量解析、draft envelope/etag 分类、跨根身份、脚注 parser/ref/backref。 | Math/table/callout/embed/code/HTML/hr、HTML/Mermaid sanitizer、selection/search source reveal、fenced-code 点击编辑、CRLF+CJK 搜索/编辑保存均有实测。保存 A/B、pagehide/reload 恢复和 history-restore 跨根 late ack 也通过。正式长测覆盖 30 分钟以上输入并验证最终文件完整性，但 raw runner 因收尾 indexing 状态/etag mismatch 标记 invalid。 | 输入与落盘完整性窄项通过；不能把 raw runner 改记 valid，也无证据声称 UI 内 etag 与 Core etag 完全一致。`beforeinput→rAF` 性能预算未达；Reader 性能和 block-rename 跨根 late-ack 仍待验。 |
| Reader、子路径与性能 | Core `/api/vault/subpath` 返回准确 source offset；UI 保持顶层 Markdown token group 与脚注尾段整体分组，section 用 IntersectionObserver 延迟渲染。重复/多级标题、block ID 大小写、缺失目标和跨段 CJK 脚注有 Core/model tests。 | 普通 CRLF/CJK Reader offset、caret/outlining 已测。不可变 CSS-fix bundle page4/1436 中，从顶端首次点击 Reader10000 脚注 ref 后 definition 可见；真实 backref 返回原 ref 并可见。旧失败与新 bundle 证据见 [review-notes.md](./review-notes.md)。 | 首击/回链已通过该 fixture；Reader10000 每帧 <16ms、多个 Reader 实例 ID 隔离仍未自动化。 |
| 搜索、切换器、命令、大纲、属性、标签 | 服务端 query evaluator 和 typed ranges 复用；Core/API 与 Desktop tests 覆盖 query、CJK fuzzy/span、Properties CRLF、层级标签、命令/MRU。 | 复杂 query `OR`/`NOT`、title/path fuzzy 与 content 精确高亮、无结果清空已实测；CRLF 搜索高亮和 outline caret-follow 已实测。Notes/Graph 快捷键、Library hidden listener guard 有实际 UI 验证。 | 已实现并有端到端覆盖；命令、属性等全部组合未逐项复测。 |
| 文件树、附件、历史与 hover | File/folder/attachment CRUD、delete preview/etag/orphan policy、block rename、历史版本/diff/restore 已接线；Core 对递归目录和二进制原字节恢复有测试。 | 保存冲突、恢复草稿已测；当前树 row 的整组 CRUD、folder stale-child 409、二进制 restore、hover 关闭/切换及 block rename 组合未在最终 bundle 完整实测。 | 服务端/代码路径具备；UI CRUD 与恢复组合待测。 |
| Graph | typed query/filter/groups、local/global、Worker/WebGL/Canvas fallback、PNG/clipboard handler 有模型和 renderer tests；独立复核见 [review-graph.md](./review-graph.md)。 | `tag:science`/`NOT tag:science`、OR/Groups 首色、组不隐藏节点、颜色 state/readPixels、local incoming/outgoing、Meta 新页/分屏、隐藏快捷键已实测。导出 PNG 的透明背景、图形内容与标签合成、clipboard 拒绝时下载 fallback 已实测。Vite 1437 的 5k Graph surface 用 pointer handler 注入拖动 12 帧后节点位置改变并持久化，Worker 无错误。 | 基本拖动/持久化路径通过；5px 阈值、释放后 pin 行为、force/theme 组合、Canvas fallback、原生 color picker 与 OS clipboard readback 未自动化或未测。 |

## 最终自动化 / 运行检查

| 包 | 检查 | 结果 |
|---|---|---|
| `@noltri/knowledge-core` | `typecheck` + `test` | 15 files / 224 tests 通过。 |
| `@noltri/api-client` | `typecheck` + `test` | 6 files / 33 tests 通过。 |
| `@noltri/desktop` | `typecheck` + `test` | 15 files / 107 tests 通过；此结果包含当前 P1 root-owner 与 Reader retry 逻辑。之后的 CSS-only smooth 移除已构建成 page4/1436 immutable bundle 并通过 Reader 首击/回链 smoke，未重复运行 test suite。 |
| `@noltri/mcp-server` | `typecheck` + `test` | 3 files / 19 tests 通过。 |
| Runtime | `pnpm --filter @noltri/desktop run build:runtime` + 隔离 HTTP smoke | Node 24.18 arm64 sidecar/worker 已验证；具体资产 hash、端口、temporary roots 见 [core.md](./core.md)。未以此代替 Tauri 原生 UI smoke。 |

各套件计数是各自包的最新完整结果，不相加；定向测试是子集。Core P1 回归覆盖同 etag 串行更新、延迟 request body 下 Unicode root capture、旧 root 409、尾斜线路由、非法 `%` 和 CORS。Desktop 最新 WorkbenchNotes SHA-256 为 `c0063d373a773229ab644b57ed50a5687317411b27934fb4da60445b7faf2884`；脚注 CSS 去平滑后的 `notes-workbench.css` SHA-256 为 `ba9fcd68db4cb7772a954ce162e18290414d0b7be873cff7b113015764a99b78`。已通过的窄浏览器路径和剩余复验范围见上表及下文。

## §9 边界逐项验收

| §9 | 规格 | 当前证据与剩余项 |
|---:|---|---|
| 1 | 同名候选稳定：同目录优先、短路径优先、稳定首项。 | Core real-FS 测试覆盖 precedence、alias、case/NFC/NBSP 与安全路径；Windows 原生 FS 未测。 |
| 2 | 改名/移动收敛，保留别名并更新引用。 | Core 覆盖 Markdown/Wikilink kind、query/fragment/title、自链接、出链重基、目录树 etag 和 no-replace race；100-ref 合成改名 674ms。UI tree CRUD 最终 browser 批次待测。 |
| 3 | YAML 按具体 key/scalar 写回，不重序列化整段。 | Core YAML AST link rewrite 与 Notes Properties writer 均有 CRLF/CJK/comment-preservation 检查；packaged CRLF rename smoke 通过。 |
| 4 | 保留断链；目标创建后自动接上。 | Core unresolved/resolved index 和 NotesEditor revision/path async guard 有 tests；旧 browser smoke 通过 sanitizer/链接显示，最终 bundle 新目标创建后红标消除仍待测。 |
| 5 | 无效 `^id` 文件级降级；block ID 精确联动。 | Core resolver 返回 null、rename-block 精确引用回归通过；Reader 文件级回顶有实现和测试，最终 UI 组合待测。 |
| 6 | 多级 heading 路径递深定位。 | Core `Parent#Child`/重复 heading 与 Notes offset-to-section tests 通过。Reader10000 最终 CSS-fix bundle page4/1436 的首个脚注 ref 和 backref 均实测可见；Reader10k 滚动帧预算仍未测。 |
| 7 | case、NFC/NBSP、大小写碰撞边界。 | Mac real-FS table tests 覆盖 case-fold、NFC/NFD、NBSP 与物理路径拼写复用；Windows 原生矩阵未测。 |
| 8 | CJK fuzzy 与未链接提及边界。 | Core CJK/English mention、排除 frontmatter/code/reference、fuzzy range tests 通过；切根/旧提及列表下 UI 转链最新 etag 流程还需 browser 覆盖。 |
| 9 | Worker 串行/让步/超时诊断；单文件失败不阻塞。 | Core worker timeout/restart/queue continuation tests 与 packaged diagnostics smoke 通过；大 Reader UI 每帧预算未测，编辑 soak 未通过。 |
| 10 | HTML/Mermaid trust、外链确认、路径安全。 | 旧 browser smoke 对 HTML/Mermaid trust、DOMPurify 和 XSS sentinel 实测通过；Core traversal/symlink 拒绝通过。最新 bundle 外链确认、危险协议与不安全图片最终 DOM 仍待复验；OS clipboard 不属此项。 |
| 11 | 反链/孤儿附件 never/always/ask。 | Core file/folder preview、ask、always 快照、stale tree etag 与 binary restore 测试通过；对应 tree UI 的 folder/attachment 删除与恢复还未整体 browser 验证。 |
| 12 | 外部同步并发及缓存失效。 | Core watcher/etag 测试、UI 同根延迟 PUT drain 与真实外部写 409 已通过；同路径跨 root 的 history-restore 延迟 ack 已以双根磁盘内容验证隔离。block-rename 与其他跨根 mutation 的迟到响应仍待测。 |
| 13 | `distanceMin=30` 与重合点 jiggle。 | Worker tests 覆盖最小距离、确定性 jiggle、pin/unpin 和重合点收敛；Vite 1437 5k surface 的 React pointer injection 已实测节点移动及位置持久化。物理鼠标、5px threshold 与释放后的 pin/unpin 交互仍未测。 |

## §10 性能预算

| 指标 | 规格 | 观测 | 结果 |
|---|---|---|---|
| Core 1,000 篇冷/暖索引 | <5s / <1s | M2：443 / 230ms | 该合成库通过。 |
| Core 单文件写入至反链、外部文件至索引 | <200ms / <2s | 15 / 59ms | 该 smoke 通过。 |
| Core 10,000 篇搜索首批 | <300ms | 首次索引 2,493ms；索引完成后查询 37ms | 查询通过；索引冷启动单列，不冒充搜索耗时。 |
| Editor 输入 p95 | <16ms | 旧 soak 约 4 分钟即停止，`beforeinput→rAF` p95 95.6ms；page12 ordinary Event Timing processing p95 6ms，旧 heading/code-body processing 为 24/21ms。PerfShort 的 7 次 heading `beforeinput→rAF` 为 77.9/11.5/12.5/15.1/21.8/4.8/12.2ms；code body processing 22.1ms、next-rAF 39.9ms。最终长测 8,580 个 `beforeinput` 的 `next-rAF` p50/p95/max 为 17/39.8/320.8ms，231 long tasks、max 458ms。 | 数据完整性窄项通过，性能预算未达。raw 快照为 `pathSoakRun4` / LP / `正在索引 · 队列 0`，`saveOk=547/548`、`saveErrors=0`；唯一未满足 runner 条件是状态尚非“已保存”。同页随后只读状态为“已保存”、548/548。Core post-read 为 HTTP 200、339,836 bytes / 5,040 行，变化后的 ETag 为 `cddd79d9926b74af98f69c9c2125d06f5cb30ae70d02bc6ad24aa203a2643d4a`。保留原始 runner invalid 结论；UI 私有 etag 未采，不能声称 UI/Core etag 精确一致。 |
| Reader 10k 每帧 | <16ms | 最终 CSS-fix bundle 的首击脚注与 backref 已可见；此前快速滚动旧 bundle 观察到 55–607ms long tasks，但没有当前 bundle 的帧预算测量。 | 未证明达标；导航行为通过不代表滚动性能通过。 |
| Graph 5k 拖动/缩放 | 60fps | Chrome/ANGLE Apple M2 合成 pan/zoom 59.52/59.10Hz，clear interval p95 18.6/20.8ms，active long tasks 0；idle 后零 clear 并可被 wheel 唤醒。Vite 1437 Graph surface 的 React pointer handler 注入拖动 12 帧，位置改变并持久化；rAF p50/p95/max 16.6/21.1/23ms，3.93s 后 Worker 回冷。 | 窄路径功能通过、节奏接近 60fps；这是注入事件小样本，不是 OS 原生输入或全帧预算保证。 |
| Graph 5k 布局收敛 | <2s | Native JS Worker bundle settle 4,155.8ms/193 batches；Vite 1437 浏览器 Worker 首 tick 至 `alpha≤0.001` 为 4,165ms/171 messages，0 error。100/1k native settle 86.6/772.4ms。D3/WASM 临时候选 5k/300 ticks 约 2,116ms，且语义/CSP 不合适。 | **未达**；Node Worker 与浏览器 Worker 分开报告，保留 Native JS，不把首次交互计时改称收敛时间。 |

## 复现入口与当前剩余项

从仓库根目录运行 `pnpm --filter @noltri/desktop dev`。首次打开选择 Vault；Notes 入口可创建/打开 Markdown，切换 Source / Live Preview / Read；Graph 使用同一 Vault 的元数据。冲突路径可通过另一进程以旧 etag 写入同一路径，检查 409、保留本地草稿与“重新载入外部版本”操作。Core/API/Graph fixture 和保存 drain browser wrapper 的端口、临时目录及步骤见 [core.md](./core.md)、[graph.md](./graph.md)、[review-notes.md](./review-notes.md)。

仍需完成或保持未通过的验收仅包括：

1. 用最终 bundle 复验 block-rename 与其他跨 Vault mutation 的延迟 ack；history-restore A→B 同路径隔离和 Reader10000 首个脚注/backref 已通过。Reader 10k 帧预算仍未测。
2. 最终长测实际 first-to-last `beforeinput` 为 1,801,232.5ms，660 批/8,580 字符，页面可见且聚焦；Core 上 548/548 PUT 返回成功。raw 快照记录 `pathSoakRun4`、LP、状态“正在索引 · 队列 0”、`saveOk=547/548`、`saveTotal=548`、`saveErrors=0`；唯一不满足条件是状态尚非“已保存”，所以保留原始 runner invalid 结论，不改写为 `valid:true`。同页随后只读状态为“已保存”且 548/548。post-run Core GET 为 HTTP 200、339,836 bytes / 5,040 行，变化后的 ETag 为 `cddd79d9926b74af98f69c9c2125d06f5cb30ae70d02bc6ad24aa203a2643d4a`，含 660 个有序唯一 marker；移除唯一 marker block 后恢复 clone SHA `6a38612a…db623`，原 Soak SHA 未变。UI 私有 etag 未采，不能据此声称 UI/Core etag 精确一致。当前 `beforeinput→rAF` 性能指标已明确未达 <16ms。
3. 完整执行最终 bundle 的文件/文件夹/附件 row CRUD、preview 后 stale 409、历史与 binary restore、hover/link safety 组合；已通过的局部 browser smoke 不必重复。
4. Graph 的 5k 基本 pointer-drag/位置持久化已通过窄路径注入测试；5px 阈值、释放 pin、force/theme、Canvas fallback 等交互仍未覆盖，5k settle <2s 未达。PNG 透明背景、图形内容与标签合成、clipboard 拒绝下载 fallback 已实测；OS 原生剪贴板读回、Tauri 原生 UI 与系统 color picker 未自动化。

这些未完成项不否定已通过的 Core/API/测试子范围；也不把一次 attempt、静态检查或旧 bundle 观察写成当前 bundle 的完整端到端通过。
