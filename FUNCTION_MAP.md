# FUNCTION_MAP

> 唯一事实来源：本文件只允许两个分区。「已实现」只收录**有自动化测试或运行时证据**支撑的能力，
> 并在条目后标注验证方式；凡标注「未实机运行 / 未实测」的条目表示代码已完成且测试通过，但
> 尚未在真实环境中运行过。V2 / V3 范围的能力一律不进入「已实现」。

## 已实现

### Capture 入口
- MCP `capture_knowledge`（Streamable HTTP；SDK 真实客户端端到端验证：initialize → tools/list → tools/call，捕获结果落库并在知识树可见）
- **统一 CaptureRequest（P3-A）**：`requestId`（8–64 位）＋ `source`（内容来自哪里）＋ `capture`（谁在什么设备采集）三段分离，四个入口共用 `packages/api-client` 的键生成与 zod 契约；**payload 里没有用户身份字段**，多带的键被 schema 剥掉，身份只取自凭证。`apps/extension/src/capture/build-request.ts` 保证一条采集的键只生成一次，重发沿用同一个键（`packages/api-client/test/capture-request.test.ts` 7 项、`apps/extension/test/capture-payload.test.ts` 9 项）
- **按键幂等回放（P3-A）**：Core 以 `(userId, clientId, requestId)` 认键。同键重复提交返回**同一个** `rawSourceId` 且 `duplicate=true`、不再写入第二条原文；**内容相同但键不同（或客户端／设备不同）则各占一条原文行，来源关系不丢弃**。落库由 `raw_sources.request_id / client_id` 两列＋一条 partial unique index 保证（SQLite `user_version=2`，Postgres 迁移 `20261005000100_capture_idempotency.sql`，向前-only，历史行的 null 键不入索引）。`services/knowledge-core/test/idempotency.test.ts` 12 项锁定键控与阶段判定，跨驱动的落库行为由 `packages/storage/test/repository-contract.ts` 逐驱动断言；实测见 `docs/P0-baseline-and-recovery.md` §14.2
- **阶段回报（P3-A）**：`CaptureResult.stage ∈ saved｜processing｜completed｜needs_review｜failed` ＋ `duplicate` ＋ `processingStatus`，客户端不再靠「HTTP 200」猜结果。扩展浮层据此分开显示「已落盘，等待归纳」「已存入 Noltri，正在归纳」「已存入 Noltri，需要你复核」「这条已经在 Noltri 里，没有重复写入」（`apps/extension/test/toast-render.test.ts` 17 项）
- **结构化错误（P3-A）**：错误信封固定携带 `code` / 人类可读 message / `retryable` / `traceId`；`RETRYABLE_ERROR_CODES`（`packages/shared/src/errors.ts`）是全仓唯一的可重试判定来源，`ApiClientError.retryable` 只从信封或服务端分类码得出
- 浏览器插件选区浮动「归纳知识点」按钮（MV3 content script；134 项测试、`pnpm --filter @noltri/extension run build` 通过；**未在真实 Chrome 加载实测**）
- 浏览器插件右键菜单「归纳到知识树」（background service worker；同上，**未在真实 Chrome 加载实测**）
- 浏览器插件来源元数据提取：URL / 标题 / 域名 / 适量上下文（同上，**未在真实 Chrome 加载实测**）
- 浏览器插件归类结果提示（popup / 徽标反馈；同上，**未在真实 Chrome 加载实测**）
- **受限页面的解释与自救通路（P3-B）**：`restrictedReasonForHref()` 把「扩展进不去」归为 6 类原因（浏览器内部页／扩展商店／PDF 查看器／其它扩展页／本地文件／不支持的协议），每类给出「为什么」和一句**由用户自己动手**的替代路径（复制→在弹窗粘贴框收纳）。扩展**从不代用户写剪贴板**，因此文案不含「已为你复制」（`apps/extension/test/restricted.test.ts` 26 项）
- **待发送队列（P3-B）**：Core 连不上时区分两种意图——「等待 Noltri」（留在队列、连上自动发）与「仅保存在扩展待发送队列」（用户主动扣下）。队列只落 `chrome.storage.local`（绝不用 `storage.sync`，那会把用户选中的文字复制到 Google 账号）、容量上限 50 条、7 天过期即丢弃、popup 一键清空、无痕实例不启用（`chrome.storage.local` 会活过会话，承诺「断线不丢原文」在无痕模式里做不到，索性关掉）。重发使用队列里的**原 requestId**，因此服务端仍按幂等键处理。`apps/extension/test/outbox.test.ts` 12 项＋`outbox-drain.test.ts` 14 项
- **拒绝与断线的分离（P3-B）**：`retryable=false` 的拒绝（正文过短、契约不合格、来源被禁）绝不进队列——重发一百次也不会变成功；只有「服务没在跑」类错误进队列并自动重连排空。实测：断线期间 2 条入队 → Core 恢复后 `sent=2 kept=0`、重发键与队列键逐字相同、库中仍只有 2 条原文；再跑一遍排空得到 `alreadyStored=1 sent=0`，没有产生第二条
- **浏览器 Native Host（P3-C，`services/native-host`，135 项测试＋真实 stdio 实测）**：Chrome Native Messaging 4 字节小端长度前缀＋ UTF-8 JSON，单帧 1 MiB 上限；只接受 `hello｜health｜capture｜capture_batch` 四个动词，其它（如 `export_all`）一律 `forbidden_scope` 拒绝且**不回显载荷**；单条消息最多 4 次采集，超限明确说「这条消息不符合采集要求」而不是「不执行 capture_batch」；转发前逐条重新核验 Core 身份（`productId`＋`protocolVersion`＋`instanceId` 变化＝App 重启）；stdout 只承载协议帧，任何日志走 stderr；回复严格按请求顺序串行写出
- **Native Host 注册与撤销（P3-C）**：`install-cli.ts` 先打印可读预览（写入位置、host 程序、允许的扩展 origin），**只有 `--confirm` 才写文件**；已存在的 manifest 先备份为 `.before-<时间戳>.bak` 再覆盖，`uninstall` 恢复备份而不是直接删；`allowed_origins` 只收 `/^[a-p]{32}$/` 的扩展 id，列表为空即拒绝生成（不写出通配）。Windows 需要注册表键，安装器**拒绝代改**并说明手动步骤。凭据绝不出现在预览里
- **端点身份门禁（P3-C）**：地址与凭据的来源优先级是 `~/.noltri/data/native-host.json`（读取前先按文件 mode 判定，组位或他人位非 0 即视为不安全并拒绝使用）> `NOLTRI_API_BASE_URL` / `NOLTRI_API_TOKEN` > 默认 `http://127.0.0.1:8787`。「端口上有 JSON」或「`{"ok":true}`」都不足以判定是本项目服务：productId 不符 → `core_identity_mismatch`「这个端口上运行的不是知序 Noltri Core，内容没有发送」；契约不符 → 不确认落盘。实测两个诱捕服务各自 `POST /api/capture` 计数为 0
- 桌面 Companion macOS Accessibility 选区捕获（Rust AX 轮询观察者；8 项 Rust 测试、cargo check 通过；**GUI 未实机运行，TCC 授权流程未实测**）
- 桌面 Companion 浮动捕获胶囊（overlay 窗口 + 前端；Setup/捕获侧 22 项前端测试、vite 构建通过；**未实机运行**）
- 桌面 Companion 全局快捷键 → 粘贴式迷你捕获窗降级（Rust 快捷键注册 + paste 窗口；同上，**未实机运行**）
- 桌面 Companion 捕获管线前端流 `runCaptureFlow`：契约校验 → ApiClient 捕获 → 结果/失败文案 → `recordCaptureOutcome`（`apps/desktop/test/capture-contract.test.ts` 5 项覆盖：payload 无身份字段、短文本本地拒绝不发包、原文已保存的 AI 失败提示、成功路径节点路径展示）

### Knowledge Core（99 项测试 + 本地 HTTP 实测闭环 + SQLite 纵向切片）
- RawSource **先保存**再 AI 处理（全文唯一 `createRawSource` 调用点，`pnpm gate` 机器检查）
- 原子知识点提取（offline 确定性提供方 + OpenAI 兼容 BYOK 提供方）
- 文本归一化
- 向量化（单批合并调用）与相似检索
- 自动归类决策：attach（挂已有节点）/ create（新节点）/ merge（合并）；置信度分层（高/中/低，阈值可配置）——实测中同一内容重复捕获被吸收进已有节点（itemCount 递增）
- AI 失败记录 `processingStatus='failed'` + `errorReason`，并支持 `retryCapture` 重试
- 收件箱读取 `GET /api/inbox`：按归纳状态多选筛选（`status` 为逗号分隔串，因路由用 `Object.fromEntries` 折叠重复键）、分页 limit/offset、返回**全库**四态计数；`GET /api/inbox/:id` 取单条原文全文（仅以 owner 过滤，越权即 null）；`POST /api/capture/:id/retry` 无请求体重跑归纳管线（服务端已持有原文，重试不可能重发用户没捕获的内容）
- 人工归档 `POST /api/inbox/:id/assign`：**绕过全部 AI 阶段**把一条原文变成知识点（可只提交人工摘录而非整段原文），落库标记 `isAiDerived=false` + `embeddingStatus='none'`，重复归档同一节点同一文字返回 `conflict`；这是「未配置模型密钥也能把原文变成知识」的通路
- 会话读取 `GET /api/conversations[?nodeId=]` 与 `GET /api/conversations/:id/messages`：对话记录由 Core 持久化，客户端不再自备 localStorage
- 知识树读取 / 节点详情 / 节点重命名 / 节点移动（含环检测与 VersionRecord 版本记录）
- 语义 + 关键词混合搜索
- 节点上下文装载（current_node / section / tree / whole_library）
- 节点级 AI 对话（会话 + 消息持久化）
- REST API 契约校验（zod）、健康检查、错误信封；身份仅取自凭证（JWT / dev-token / dev-open），绝不来自请求体
- `/api/health` 是**产品身份声明**：除状态外必须返回 `productId='noltri-knowledge-core'`、`instanceId`（进程实例号，重启即变，供客户端识别「App 换了一个」）、`protocolVersion='1'`、`version`、`storageDriver` 与真实 `storage` 自检结果。「端口上有 JSON」或「`ok:true`」都不构成判定依据（§7.6）；Native Host 在**每一次**转发前重新核验这三项
- **采集幂等**：`POST /api/capture` 认 `(userId, clientId, requestId)` 键，同键第二次提交直接返回第一条的 `rawSourceId` ＋ `duplicate=true` ＋ 已到达的 `stage`，不重跑 AI、不写第二条原文；无键（缺 `requestId`）请求在契约层 400 拒绝（`invalid_request`、`retryable=false`、带 `traceId`）。归纳失败后 `POST /api/capture/:id/retry` 成功重跑并返回 `stage='completed'`
- 错误信封统一为 `{error:{code,message,retryable,traceId,details?}}`，`retryable` 由 `RETRYABLE_ERROR_CODES` 单点决定，客户端不必再各自猜（`services/knowledge-core/test/http.test.ts` 15 项：按码标注可重试＋带 traceId 的信封、400／401／404 与 405 的区分、意外失败不回显内部）
- `/api/health` 报告**真实存储状态**：驱动自检 `storageHealth()` 由三个驱动各自实现并纳入契约测试，返回文件名（不返回绝对路径）、journal mode、schema 版本、SQLite 版本、FTS5 可用性与本库数量；storage 自报不可用时整体状态降为 `degraded`
- 本地零云配置纵向切片实测：仅设 `STORAGE_DRIVER=sqlite` / `NOLTRI_SQLITE_FILE` / `AI_PROVIDER=offline` / `NOLTRI_DEV_USER_ID` 四个环境变量，即可 capture → 落盘 → 关闭句柄 → 重开同一文件 → 读回原文/知识/树/关键词搜索/节点详情（`services/knowledge-core/test/local-storage-slice.test.ts`，5 项）；profile 路径由 `resolveSqliteFile()` 统一解析（`NOLTRI_SQLITE_FILE` > `NOLTRI_DATA_DIR` > `~/.noltri/data`），Core 内不再出现驱动名分支
- 崩溃安全实测：子进程（`services/knowledge-core/test/crash-writer.ts`）经 `createRepository` 提交一条原文后立刻 `SIGKILL` 自身，不执行 `close()` 也不做 checkpoint；父进程重开同一文件读回该条，干净关闭后 `-wal` 侧文件不存在——即「写入返回成功」等于「进程被杀后仍可读回」在 Node 侧已验证（安装版内未实机复现）

### 数据与架构
- StorageRepository 统一抽象 + 三个驱动（InMemory / SQLite / Supabase-Postgres）：同一份契约 `packages/storage/test/repository-contract.ts` 逐驱动执行，作用域隔离、幂等 upsert、错误码（`not_found` / `conflict` / `storage_error`）、时间戳与 rowid tie-break 排序、关键词相关性、向量维度不混用在三者间语义一致
- **SQLite 本地文件仓储**（`packages/storage/src/sqlite.ts` + `sqlite-schema.ts` + `sqlite-vectors.ts`）：Node 内置 `node:sqlite`（不需要随包携带原生模块）、WAL + `synchronous=FULL` + `busy_timeout` + `foreign_keys=ON`、`PRAGMA user_version` 分步迁移、FTS5 + CJK bigram 关键词索引（原始文本仍存实体表，可原样回显）、Float32 BLOB 精确余弦向量（登记 model / 维度 / 归一化 / 源文本 sha256 / builder 版本；查询宽度与存储宽度不一致的行绝不参与打分）、`integrity_check` + `foreign_key_check`、SQLite backup API 一致性快照；P3 在 `user_version=2` 给 `raw_sources` 加 `request_id`／`client_id` 两列、一条「键必须成对」的 CHECK 与 partial unique index（21 项契约测试 + 22 项 schema／落盘／中文检索／备份专项测试 + 11 项迁移测试）
- 本地知识表 8 张 + 2 个本地检索结构（`vectors` / `keyword_index`）：raw_sources / knowledge_items / knowledge_nodes / knowledge_edges / item_node_links / version_records / conversations / conversation_messages；单用户本机工作区不设 `users` 表，但 `user_id` 列保留，使三个驱动共用同一套查询与契约
- InMemory 驱动（20 项契约测试全绿）—— 仅用于测试与明确标注的临时演示，**不作为生产本地存储**
- Supabase(Postgres) 仓储实现 + 迁移 SQL（`supabase/migrations/`，含 pgvector 向量列；storage 包实测 75 项通过 / 21 项跳过，跳过项全部是缺少 `NOLTRI_PG_TEST_URL` 时的 PG 集成用例，**不计通过**；P3 新增的幂等列／约束／partial unique index 迁移 `20261005000100_capture_idempotency.sql` 同样**通过静态审查，未在真实数据库执行**）
- AI Provider Adapter 抽象 + `offline`（确定性）与 `openai`（BYOK，OpenAI 兼容 chat + embeddings）两个实现（48 项测试；**未发起真实模型调用**）
- 结构变化版本记录与可逆基础（move/重命名均落 VersionRecord）
- 架构门禁 `pnpm gate`：core 无 pg/supabase/openai/express 依赖、四入口共用同一 ApiClient、MCP 不碰数据库、**浏览器 Native Host 不引用存储／AI 层且只在 `host.ts` 一处经 `@noltri/api-client` 触达 Core（不允许手写 fetch）**
- **`@noltri/shared` 领域视图模型层**（P2 UI 与业务拆分的落点）：树扁平化／展开折叠／键盘导航／子树计数、节点详情视图模型与移动目标选项、中文标签字典（归纳状态、来源类型、作用域、关系、匹配方式）、阈值与 env 解析；60 项测试。标签字典以「键集合必须等于 schema 枚举」的契约测试锁定，新增枚举值未翻译即测试失败，Web 与桌面共用同一份

### Web App（28 项测试 + next build + 代理实测；P2 后仍可运行，尚未删除）
- 登录（dev-token 策略已实测：401 信封、307→/login、写 cookie 后取得会话；**Supabase Auth 策略已实现但未连真实 Supabase 项目实测**）
- 首屏知识树三栏布局（键盘导航、展开/折叠、拖拽移动目标选项；树视图 27 项测试已随视图模型迁入 `@noltri/shared`）
- 节点详情：摘要 / 知识点数 / 来源数 / 关联节点 / 与 AI 讨论
- 搜索（走 `/api/web/*` 代理 → core）
- 节点 AI 对话界面（上下文携带截断至最近消息；offline 提供方回环验证，**未用真实模型**）
- `/api/web/*` 代理层 28 项测试直连真实 Next 路由处理器 + 独立 fake core
- P2 迁移后与桌面端的对等性由 `apps/desktop/test/workbench-render.test.tsx` 机器锁定：同一份 props 分别渲染 Web 与桌面的领域栏／知识树／节点详情，断言 `renderToStaticMarkup` 输出逐字节相同。该测试是迁移期脚手架，P7 删除 `apps/web` 时一并删除

### Desktop Companion、Setup Manager 与知识工作台（79 项前端测试 + 8 项 Rust 测试；Companion/Setup GUI 未实机运行，工作台已用浏览器驱动 dist 产物实机回归）
- Tauri 2 壳与原生能力层（25 个 `#[tauri::command]` 全部注册；TS 侧 `lib/tauri.ts` 调用其中 23 个，`get_selection_preview` 与 `runtime_info` 已注册但前端尚未调用；2 个事件名 `selection-changed`／`capture-result`，共 3 处 `emit`；`cargo check` 与 `cargo test`（8 项全通过）实测）
- macOS Accessibility 权限状态检测与引导（状态展示 + 打开系统设置 + 「我已授权」重新检查）
- Setup Manager Capture 状态区：观察者状态、捕获总开关、最小长度、测试选区捕获、按应用退出（opt-out chips）、不兼容应用列表与重试、最近收纳记录
- Setup Manager AI 连接区：5 个客户端（claude / claude_code / cursor / chatgpt_codex / other_mcp_client）连接测试（core 健康 + MCP tools/list 两段探针）、MCP 条目复制、按客户端写入配置文件（window.confirm 展示绝对路径与合并摘要，只替换自家条目、保留兄弟配置，**绝不存第三方密码**）、官方设置/文档直达
- 原生时间工具（UTC ISO-8601，Hinnant 算法）；`cargo test` 实测 8 项全通过：MCP 写入目标白名单 3、设置约束 3、时间形状 2

#### 知识工作台（P2 迁入，`apps/desktop/src/workbench/`）
- 独立 WebView 入口 `workbench.html`：`WebviewWindowBuilder` 在 setup 阶段一次性 hidden 预建（1280×820，最小 940×600，居中），`open_workbench_window` 只做 `show()` + `set_focus()`；关闭事件 `prevent_close()` + `hide()`，因此窗口不会被销毁、随时可再打开（Rust 生命周期；**未实机运行**，前端行为以浏览器驱动 dist 产物实机回归覆盖）
- 三个页签视图（收件箱 / 知识库 / 连接与设置）：知识库为三栏 §17.1（领域栏 / 树 / 节点详情）+ 节点对话抽屉，搜索常驻顶栏；不预先占位「研究项目」（P5 才有的能力）
- 收件箱：筛选「需要处理（默认）/待整理/整理中/归纳失败/已归纳/全部」，状态词表由 `processingStatusSchema` 派生；分页以服务端 offset 续拉，四态徽标计数恒为全库口径；`processing` 禁人工归档、仅 `failed` 可重试；同一节点上重复归档同一段文字返回 `conflict` 并如实提示
- 收件箱人工归档写 `isAiDerived=false` + `embeddingStatus='none'`，与 AI 归纳结果在库中可区分（实测库内两行各占一类）
- 节点对话消息只由 Core 持久化（桌面端不落 localStorage／sessionStorage，实测重载后读回）；按 (nodeId, scope) 取最近会话，绝不把无节点归属的会话串进节点面板
- 业务与 UI 拆分：`inbox-model.ts` / `chat-model.ts` 为纯函数视图模型，可在无 DOM 环境下测试；`api.ts` 以 `Pick<ApiClient, …>` 派生工作台所需契约面，上游改名即编译失败
- 领域状态、表单校验、查询逻辑从 `apps/web` 组件抽出后迁入 `@noltri/shared`（树视图模型 + 中文标签字典）与桌面端；未新增共享包
- 连接状态诚实化：首次探测未完成时显示「正在检测本机知识服务…」，只在真实失败后显示「不可用」（实机回归中发现并修复的缺陷）
- 原生依赖收口：Next.js server action / cookie / SSR session / Web-only route handler 在桌面端不存在，全部改为 `ApiClient` 直连 Core（`clientHint: 'desktop'` 落到版本记录）

### MCP（20 项测试 + 真实 SDK 客户端端到端验证）
- Streamable HTTP `/mcp` endpoint（无状态：每 POST 新建 Server + transport，JSON 响应模式）
- 7 个工具：capture_knowledge / search_knowledge / get_knowledge_tree / get_knowledge_node / update_knowledge_node / move_knowledge_node / get_node_context（中文文本 + structuredContent 双输出）
- MCP 鉴权：Bearer 令牌常量时间比较（sha256 摘要 + timingSafeEqual）；令牌绝不回显于 `/healthz` 或日志；401 带 `www-authenticate`
- MCP Client 连接验证脚本 `pnpm --filter @noltri/mcp-server run verify`（真实 `@modelcontextprotocol/sdk` Client 经 StreamableHTTPClientTransport 连接，已实测通过并产生真实数据）
- 客户端使用指引 `skills/knowledge-skill/SKILL.md`（工具地图 + 诚实规则：只用工具返回的节点 id、失败如实上报、原文不可改）

## 后续实现

### 验证缺口（代码已就绪，需真实环境补验）
- 浏览器插件在真实 Chrome 中加载并实测捕获闭环
- **扩展与 Native Host 之间的桥尚未接线**：`apps/extension/src/manifest.json` 的权限仍是 `contextMenus / storage / activeTab`，**不含 `nativeMessaging`**。增加它等于替用户在浏览器里领一项新权限，属 §16 明令不得静默进行的决定，需用户点头后单独一步完成（含 host 程序路径的打包解析、扩展 id 的取得与安装预览的实跑）。因此 P3-C 的 host 是由**独立的 stdio 测试驱动与真实 Core** 验证的（11 个请求场景／4 个会话），**不是**由 Chrome 进程驱动的
- 扩展的「粘贴框收纳」与全局快捷键：受限页面文案、队列、toast 均有测试，但**粘贴框在真实弹窗里的交互未实机走通**（ego-browser 无法加载未打包权限的 MV3 扩展）
- 待发送队列的无痕禁用是启动时的能力判定＋测试锁定的行为，**未在真实无痕窗口中实测**
- Native Host 的注册（`install-cli.ts install --confirm`）本轮**只做过预览与临时 HOME 下的写入测试**，没有对用户真实浏览器目录执行过写入；`~/Library/Application Support/Google/Chrome/NativeMessagingHosts` 保持原样
- Windows 的 host 注册需要注册表键，安装器**拒绝代改**，而手动导入的 `.reg` 样本与步骤文档**尚未编写**
- 桌面 Companion 实机运行：TCC 辅助功能授权流程、胶囊/粘贴窗/快捷键真机交互、MCP 配置写入真实客户端配置文件
- 桌面打包与签名（dmg / notarization）
- SQLite 本地库在安装版内的实机闭环：Tauri 启动、冷启动、异常退出后重启、磁盘不足／目录只读（当前只有 Node 侧文件库测试，异常退出已由 `SIGKILL` 用例覆盖 WAL 重放，但**未打包、未双击运行**，磁盘不足／只读目录未测）
- `node:sqlite` 为实验性 API：打包时携带的 Node 版本、`ExperimentalWarning` 的处理与 `better-sqlite3` 替代路径**均未实测**
- Supabase 真实项目接入：迁移执行、pgvector 相似检索、RLS 用户隔离实测（`NOLTRI_PG_TEST_URL` 就绪后 20 项集成测试自动启用）
- Web Supabase Auth 策略对真实 Supabase 项目的登录实测
- 真实模型调用（BYOK 网关）下的抽取/嵌入/对话质量验证
- Supabase SQL 在真实库的执行（当前仅静态审查）
- 知识工作台未进 WebView 截图：本轮以浏览器驱动 **dist 构建产物**（`vite preview`，非 `tauri dev`）完成 P2 实机回归，页面与 Tauri 加载的是同一份 bundle，但**窗口显示/隐藏、`close` 拦截、设置持久化等 Tauri 专有路径仍未实机运行**
- 工作台「重试归纳」「移动节点（拖拽）」「写摘要」三条写路径本轮**只在契约与单元测试层验证**，实机回归未触发（实机场景已覆盖重复归档的 conflict 提示与重命名）
- `apps/web` 尚未删除：P2 的验收口径是「桌面场景回归通过后」才删，删除动作排到 P7 云依赖清理，届时同步删除 `apps/desktop/test/workbench-render.test.tsx` 中的 Web 对等断言
- 桌面端错误文案仍为英文：`packages/api-client` 抛出的网络/服务端错误字符串直接进入工作台错误提示，与 `apps/web/lib/client-api.ts` 的 `describeError` 行为一致，因此**不构成对等性缺口**，但中文界面下会混现英文，属于已知体验缺口

### V1 收尾项
- 发布物整理：扩展打包产物上架准备、桌面 dmg、部署文档
- **P3 已交付（协议、幂等、降级队列、Native Host、身份门禁、安装器）；仍欠的一步是扩展的 `nativeMessaging` 权限与 host 路径接线**——它替用户向浏览器领新权限，必须用户点头后单独完成，随后才谈得上真实 Chrome 加载验收
- P4 Agent Setup：检测、配置预览、备份合并、授权、MCP handshake、scope 与卸载恢复
- P5–P6 Research 整合与偏移检查：旧领域与测试迁入、研究工作台、六类偏移与上下文包
- P7 云依赖清理：删除 Web／Supabase／Remote Bridge 的启动入口、env 示例、脚本与 CI 配置；`packages/storage/test/*supabase*` 的行为断言已由 SQLite 契约覆盖，**删除动作仍需按「替代已存在＋回归通过＋引用已清理」三项证据执行**
- P8 安装包、签名／notarization 与最终实机验收

### V2（已确认，未开始）
- 完整溯源视图
- 相似知识融合（当前仅相似检索 + attach/merge 决策，无融合工作流）
- 冲突检测
- 知识有效期与版本回溯 UI
- Knowledge Inbox
- 知识缺口分析
- 多类型关系图谱视图
- 完整可逆结构操作（merge / split UI）
- 高级 MCP tools

### V3（已确认，未开始）
- 知识掌握状态模型（注：`masteryLevel` 数据字段已随 V1 schema / 迁移占位落地，但无任何功能使用，不构成已实现）
- 节点 / 章节掌握度汇总
- AI 解释、出题、应用与复习基础
- 最终 UX 整合
