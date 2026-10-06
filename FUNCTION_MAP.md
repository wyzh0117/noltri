# FUNCTION_MAP

> 唯一事实来源：本文件只允许两个分区。「已实现」只收录**有自动化测试或运行时证据**支撑的能力，
> 并在条目后标注验证方式；凡标注「未实机运行 / 未实测」的条目表示代码已完成且测试通过，但
> 尚未在真实环境中运行过。V2 / V3 范围的能力一律不进入「已实现」。

## 已实现

### Capture 入口
- MCP `capture_knowledge`（Streamable HTTP ＋ **P4 stdio 双transport**；SDK 真实客户端端到端验证：initialize → tools/list → tools/call，捕获结果落库并在知识树可见。stdio 进程只代理本机 Core，且**在 Core 自证身份之前拒绝开始服务**）
- **每客户端一份可撤销的授权凭据（P4-D）**：连接中心以设备凭据签发／列出／撤销客户端授权（`capture`／`read` 两类 scope、可限定项目、可限定返回片段），明文只显示一次、库里只存 SHA-256 摘要，Core 每个请求重新读授权——撤销后同一条已建立的 MCP 连接立刻被拒（实测见 `docs/P0-baseline-and-recovery.md` §15.5）
- **统一 CaptureRequest（P3-A）**：`requestId`（8–64 位）＋ `source`（内容来自哪里）＋ `capture`（谁在什么设备采集）三段分离，四个入口共用 `packages/api-client` 的键生成与 zod 契约；**payload 里没有用户身份字段**，多带的键被 schema 剥掉，身份只取自凭证。`apps/extension/src/capture/build-request.ts` 保证一条采集的键只生成一次，重发沿用同一个键（`packages/api-client/test/capture-request.test.ts` 7 项、`apps/extension/test/capture-payload.test.ts` 9 项）
- **按键幂等回放（P3-A）**：Core 以 `(userId, clientId, requestId)` 认键。同键重复提交返回**同一个** `rawSourceId` 且 `duplicate=true`、不再写入第二条原文；**内容相同但键不同（或客户端／设备不同）则各占一条原文行，来源关系不丢弃**。落库由 `raw_sources.request_id / client_id` 两列＋一条 partial unique index 保证（SQLite `user_version=2`；历史行的 null 键不入索引。原 Postgres 版迁移已随 P7 云依赖清理删除）。`services/knowledge-core/test/idempotency.test.ts` 12 项锁定键控与阶段判定，跨驱动的落库行为由 `packages/storage/test/repository-contract.ts` 逐驱动断言；实测见 `docs/P0-baseline-and-recovery.md` §14.2
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
- 桌面 Companion macOS Accessibility 选区捕获（Rust AX 轮询观察者；8 项 Rust 测试、cargo check 通过；P8 已实机冷启动安装版，**选区捕获的 TCC 授权流程与真机交互仍未实测**）
- 桌面 Companion 浮动捕获胶囊（overlay 窗口 + 前端；Setup/捕获侧 22 项前端测试、vite 构建通过；**未实机点验**）
- 桌面 Companion 全局快捷键 → 粘贴式迷你捕获窗降级（Rust 快捷键注册 + paste 窗口；同上，**未实机点验**）
- 桌面 Companion 捕获管线前端流 `runCaptureFlow`：契约校验 → ApiClient 捕获 → 结果/失败文案 → `recordCaptureOutcome`（`apps/desktop/test/capture-contract.test.ts` 5 项覆盖：payload 无身份字段、短文本本地拒绝不发包、原文已保存的 AI 失败提示、成功路径节点路径展示）

### Knowledge Core（224 项测试 + 本地 HTTP 实测闭环 + SQLite 纵向切片 + 真实 stdio Agent 实测）
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
- REST API 契约校验（zod）、健康检查、错误信封；身份仅取自凭证（grant / dev-token / dev-open），绝不来自请求体
- `/api/health` 是**产品身份声明**：除状态外必须返回 `productId='noltri-knowledge-core'`、`instanceId`（进程实例号，重启即变，供客户端识别「App 换了一个」）、`protocolVersion='1'`、`version`、`storageDriver` 与真实 `storage` 自检结果。「端口上有 JSON」或「`ok:true`」都不构成判定依据（§7.6）；Native Host 在**每一次**转发前重新核验这三项
- **采集幂等**：`POST /api/capture` 认 `(userId, clientId, requestId)` 键，同键第二次提交直接返回第一条的 `rawSourceId` ＋ `duplicate=true` ＋ 已到达的 `stage`，不重跑 AI、不写第二条原文；无键（缺 `requestId`）请求在契约层 400 拒绝（`invalid_request`、`retryable=false`、带 `traceId`）。归纳失败后 `POST /api/capture/:id/retry` 成功重跑并返回 `stage='completed'`
- 错误信封统一为 `{error:{code,message,retryable,traceId,details?}}`，`retryable` 由 `RETRYABLE_ERROR_CODES` 单点决定，客户端不必再各自猜（`services/knowledge-core/test/http.test.ts` 15 项：按码标注可重试＋带 traceId 的信封、400／401／404 与 405 的区分、意外失败不回显内部）
- **本地客户端授权（P4-D，`services/knowledge-core/src/authorization.ts`，取代 §569 里作为用户入口的 `NOLTRI_DEV_TOKEN`）**：`NOLTRI_GRANT_FILE`（或 `NOLTRI_DATA_DIR/grants.json`）存在才启用，未启用的部署行为与今天完全一致。一份授权＝`label`＋`client`＋`scopes ⊆ {capture, read}`＋可选 `nodeIds`＋可选 `snippetChars`＋`revokedAt`；**`mutate` 永不由授权界面提供**。凭据明文 32 字节 base64url、只在签发响应里出现一次，落盘的是 SHA-256 摘要；bearer 先查授权表，命中即 `via='grant'` 并携带授权，未命中才回落到旧的设备凭据／开放模式
- **scope 与撤销在每个请求上生效**：授权表每次请求重读，因此撤销能杀死一条**已经建立**的 MCP 连接（M04）；`requireScope` 按动作表拒绝越权（`capture` 不能读、`read` 不能改），管理端点对 grant 调用者一律关闭，未配置设备凭据的 Core（`dev-open`）**不能签发任何长期凭据**（§569）。拒绝复用 `unauthorized` ＋ `details.reason`，不改 `apiErrorCodes` 冻结枚举
- **限制返回片段（P4-D5，§435）**：`ActorContext.snippetChars` 由授权带入读取服务，裁剪发生在**服务层内部**而非路由出口，因此 `search`、节点详情、上下文包（`markdown`／`items`／`sources`／`estimatedTokens` 自洽）、收件箱预览与 `GET /api/inbox/:id` 原文说的是同一份被裁过的文本，无法绕过。**标题与树结构不裁剪，只裁正文**；设备凭据与开放模式**不裁剪**（收件箱复核与桌面工作台需要全文），因此「片段上限」只约束 Agent 客户端。上下限 20–4000 由 schema 单点决定，越界在连接中心就拒绝，不落库
- `/api/health` 报告**真实存储状态**：驱动自检 `storageHealth()` 由两个驱动各自实现并纳入契约测试，返回文件名（不返回绝对路径）、journal mode、schema 版本、SQLite 版本、FTS5 可用性与本库数量；storage 自报不可用时整体状态降为 `degraded`
- 本地零云配置纵向切片实测：仅设 `STORAGE_DRIVER=sqlite` / `NOLTRI_SQLITE_FILE` / `AI_PROVIDER=offline` / `NOLTRI_DEV_USER_ID` 四个环境变量，即可 capture → 落盘 → 关闭句柄 → 重开同一文件 → 读回原文/知识/树/关键词搜索/节点详情（`services/knowledge-core/test/local-storage-slice.test.ts`，5 项）；profile 路径由 `resolveSqliteFile()` 统一解析（`NOLTRI_SQLITE_FILE` > `NOLTRI_DATA_DIR` > `~/.noltri/data`），Core 内不再出现驱动名分支
- 崩溃安全实测：子进程（`services/knowledge-core/test/crash-writer.ts`）经 `createRepository` 提交一条原文后立刻 `SIGKILL` 自身，不执行 `close()` 也不做 checkpoint；父进程重开同一文件读回该条，干净关闭后 `-wal` 侧文件不存在——即「写入返回成功」等于「进程被杀后仍可读回」在 Node 侧已验证（安装版内未实机复现）

### 数据与架构
- StorageRepository 统一抽象 + 两个驱动（InMemory / SQLite）：同一份契约 `packages/storage/test/repository-contract.ts` 逐驱动执行，作用域隔离、幂等 upsert、错误码（`not_found` / `conflict` / `storage_error`）、时间戳与 rowid tie-break 排序、关键词相关性、向量维度不混用在两者间语义一致
- **SQLite 本地文件仓储**（`packages/storage/src/sqlite.ts` + `sqlite-schema.ts` + `sqlite-vectors.ts`）：Node 内置 `node:sqlite`（不需要随包携带原生模块）、WAL + `synchronous=FULL` + `busy_timeout` + `foreign_keys=ON`、`PRAGMA user_version` 分步迁移、FTS5 + CJK bigram 关键词索引（原始文本仍存实体表，可原样回显）、Float32 BLOB 精确余弦向量（登记 model / 维度 / 归一化 / 源文本 sha256 / builder 版本；查询宽度与存储宽度不一致的行绝不参与打分）、`integrity_check` + `foreign_key_check`、SQLite backup API 一致性快照；P3 在 `user_version=2` 给 `raw_sources` 加 `request_id`／`client_id` 两列、一条「键必须成对」的 CHECK 与 partial unique index（storage 包 118 项全绿：知识契约 41、research 契约 34、schema／枚举对齐 43；原 Postgres 迁移测试已随 P7 删除，其枚举对齐断言并入 `sqlite-schema.test.ts`）
- 本地知识表 8 张 + 2 个本地检索结构（`vectors` / `keyword_index`）：raw_sources / knowledge_items / knowledge_nodes / knowledge_edges / item_node_links / version_records / conversations / conversation_messages；单用户本机工作区不设 `users` 表，但 `user_id` 列保留，使两个驱动共用同一套查询与契约
- InMemory 驱动（20 项契约测试全绿）—— 仅用于测试与明确标注的临时演示，**不作为生产本地存储**
- **P7（2026-10）移除 Supabase(Postgres) 驱动与 `supabase/migrations/`**：知识域的跨驱动行为断言由 SQLite 真库契约与枚举对齐测试承接后删除，`requiresServer` 等只服务于 PG 的测试选项一并移除；归档留在 `ad1d0c6`（`origin/feature/research-v1`），本地桌面构建不含任何托管存储，storage 包与锁文件已无 pg／@supabase 依赖
- AI Provider Adapter 抽象 + `offline`（确定性）与 `openai`（BYOK，OpenAI 兼容 chat + embeddings）两个实现（48 项测试；**未发起真实模型调用**）
- 结构变化版本记录与可逆基础（move/重命名均落 VersionRecord）
- 架构门禁 `pnpm gate`：core 无 pg/supabase/openai/express 依赖、四入口共用同一 ApiClient、MCP 不碰数据库、**浏览器 Native Host 不引用存储／AI 层且只在 `host.ts` 一处经 `@noltri/api-client` 触达 Core（不允许手写 fetch）**
- **`@noltri/shared` 领域视图模型层**（P2 UI 与业务拆分的落点）：树扁平化／展开折叠／键盘导航／子树计数、节点详情视图模型与移动目标选项、中文标签字典（归纳状态、来源类型、作用域、关系、匹配方式）、阈值与 env 解析；107 项测试。标签字典以「键集合必须等于 schema 枚举」的契约测试锁定，新增枚举值未翻译即测试失败，工作台各视图共用同一份

### Web App（P7 已删除）
- `apps/web`（Next.js 16 三栏知识树 + `/api/web/*` 代理，28 项测试 + next build）与 Web 时代的 Supabase 装配（登录、cookie 会话、SSR）已随 P7 云依赖清理整体删除；归档留在 `ad1d0c6`（`origin/feature/research-v1`）。迁入桌面工作台的功能见上一节。
- P2 的 Web↔桌面对等脚手架（`apps/desktop/test/workbench-render.test.tsx` 前半）随删除一并移除；该文件保留「V1 词汇」断言（树行文案、`role="treeitem"`、选中态类名），仍是桌面工作台渲染的回归证据。

### Desktop Companion、Setup Manager 与知识工作台（183 项前端测试 + 28 项 Rust 测试；安装版已实机冷启动，Companion 捕获交互与 Setup 面板点验仍未实机，工作台已用浏览器驱动 dist 产物实机回归）
- Tauri 2 壳与原生能力层（32 个 `#[tauri::command]` 全部注册；TS 侧 `lib/tauri.ts` 调用其中 30 个，`get_selection_preview` 与 `runtime_info` 已注册但前端尚未调用；2 个事件名 `selection-changed`／`capture-result`，共 3 处 `emit`；`cargo check` 与 `cargo test`（28 项全通过）实测）
- macOS Accessibility 权限状态检测与引导（状态展示 + 打开系统设置 + 「我已授权」重新检查）
- Setup Manager Capture 状态区：观察者状态、捕获总开关、最小长度、测试选区捕获、按应用退出（opt-out chips）、不兼容应用列表与重试、最近收纳记录
- **Agent 支持矩阵（P4-B，M06）**：7 张卡片（Claude Desktop / Claude Code / ChatGPT‑Codex / Cursor / Hermes / Qoder / 其他 MCP Client），每张分别报告**检测**（`.app` bundle 是否存在、`Info.plist` 版本号）、**支持状态**（`writable` 可代写配置／`guided` 仅引导／`unverified` 未验证需人工配置）、**配置路径**、**连接方式**、**权限**。只有 Claude 家族的 JSON 文件会被代写；Codex 是 TOML、Cursor 与其它客户端一律引导；Hermes／Qoder 检测到安装也**不给写路径、不给伪造 URL**，界面文案是「验证前不显示为已连接」。`agentRows()` 对未知的 support 值降级为「未验证」而不是「已支持」，`official_settings_url`／`docs_url` 只在真实官方地址已知时才出现（M06「不能伪造已连接」）
- **配置预览 → 备份 → 原子替换 → 可撤销卸载（P4-C，M02）**：写入前由系统确认框给出**绝对路径＋合并摘要＋这份授权的说明**（`summarizeMerge` 说明会替换哪一项、保留哪几项兄弟配置、原文件将先备份）；取消确认时**刚签发的凭据同步撤销**，不留一份没人知道的授权。`write_text_atomically` 先把旧文件复制成 `<file>.noltri-backup.<时间戳>` 再 `rename`，**备份失败即中止写入**，连续两次写各自留一份备份（新的不会盖掉旧的），`list_backups` 只列本应用命名的备份文件（用户手制的 `.bak` 不会被冒充成可撤销点），`restore_backup` 拒绝恢复非本应用所有、或不在目标文件同目录的文件，且恢复动作本身又先备份一次因此**撤销恢复也是可撤销的**。卸载 `removeServerEntry` 只摘自家条目：兄弟服务器／键顺序／未知字段全部保留，**重复安装产出逐字节相同的文档**（幂等），文档不是 JSON 或没有 `mcpServers` 位即拒绝动笔，已存在的自家条目解析失败也拒绝覆盖；卸载成功后同时撤销该客户端仍然生效的授权
- **连接中心：授权与写入验证（P4-D，M01／M03／M04／§435）**：一次配置写入同时签发**该客户端专属**的可撤销凭据（`capture+read` 或勾选「只写采集」＝仅 `capture`），界面在签发前显示这份授权到底给了什么（`describeGrant`：scope · 项目范围 · 片段上限 · 生效中／已撤销）；§435 的隐私边界原文写在授权步骤上（「MCP 通信在本机，并不保证 Agent 的推理也在本机…」）；三项选项（只写采集／限制项目／限制返回片段）中互相矛盾的组合在**签发前**就被指出（`grantOptionConflict`），非法片段上限（非整数、越界）不静默丢弃而是挡住写入按钮；项目复选框上限 100 项与 Core 的拒绝阈值取自同一个导出常量。「写入验证完成」按 §433 只由**探针** earn：以该客户端凭据 capture 一条带 nonce 标记的原文 → 经收件箱单条端点读回同一 `rawSourceId` → 检索命中并报告归类位置，任一步失败就不给出「完成」；另有「检查 Agent 是否已写入」按钮，用同一 nonce 的 B 标记判断 Agent 自己是否真的调过工具。凭据明文只在签发响应里出现一次，撤销按钮随时可撤
- 原生时间工具（UTC ISO-8601，Hinnant 算法）；`cargo test` 实测 28 项全通过：配置写入／备份／卸载守卫 13（`mcp`）、文档形状与 removal 边界 4（`commands`）、随包运行时状态与停止 3（`runtime`）、浏览器通道 launcher／守卫 2（`browser_host`）、设置约束 3、时间形状 3
- **随包运行时托管（P8-B／P8-C）**：官方 Node v24.18.0（sha256 `ee6fb0e0…`）以 sidecar 形式随包携带（`binaries/noltri-runtime-aarch64-apple-darwin`），一鱼三吃——App 启动时用它拉起 `core-server.mjs`（`STORAGE_DRIVER=sqlite`＋`NOLTRI_DATA_DIR`＝App 数据目录）与 `mcp-server.mjs`（`KNOWLEDGE_API_URL=:8787` 指回 Core），浏览器 launcher 也指向它。就绪判定＝两侧探针（Core 验 `productId`＋`instanceId`，MCP 验 `/healthz`），500ms 间隔、20s 超时；退出只杀自己拉起的进程，dev 模式不拉起。实测：随包运行时冷启动到可应答 Core 273ms／MCP 139ms；从挂载的 dmg 完整冷启动在数秒内两侧就绪、退出后端口关闭。`runtime_info` 命令输出 `core_runtime` 诊断（前端未调用）
- **安装包（P8-B）**：`pnpm tauri build` 产出 `知序 Companion.app`（133.57 MiB）与 `知序 Companion_0.1.0_aarch64.dmg`（43.37 MiB，sha256 `b94ad7e4…`）；arm64、最低 macOS 11；ad-hoc 签名、未公证（本机无 Developer ID，`spctl` rejected 属预期）；包内 strings 扫描 0 处开发目录引用
- **浏览器通道（P8-C，M05）**：launcher（`host/noltri-native-host`，指向随包运行时而非开发目录）写入 App 数据目录并提供 status／repair／uninstall 三命令＋设置面板区块；实测经 4 字节长度帧协议调起随包 host 并回报 Core 身份；注册写入仍先预览后确认（未对浏览器目录落盘）

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

### MCP（27 项测试 + 真实 SDK 客户端端到端验证 + 真实 stdio 进程对真实 Core）
- Streamable HTTP `/mcp` endpoint（无状态：每 POST 新建 Server + transport，JSON 响应模式）
- **stdio endpoint（P4-A，`services/mcp-server/src/stdio.ts`）**：默认 transport，同一份 7 工具实现复用同一个 `buildServer()`，进程**只代理本机 Core、绝不另建数据库**；stdout 是 JSON-RPC 通道，因此所有给人看的字一律走 stderr；启动前先用 `KNOWLEDGE_API_URL` 探测 `/api/health` 并核验身份（`productId`／`protocolVersion`／`version`），**核验不过就不开始服务并以退出码 1 结束**（`missing_api_url`｜`core_unreachable`｜`not_noltri_core`｜`protocol_mismatch` 四种拒绝各有明确文案）——「找到配置文件」不等于「已连接」。凭据来自 `NOLTRI_ACCESS_TOKEN`，工具调用按该凭据在 Core 侧的授权范围执行
- 7 个工具：capture_knowledge / search_knowledge / get_knowledge_tree / get_knowledge_node / update_knowledge_node / move_knowledge_node / get_node_context（中文文本 + structuredContent 双输出）
- MCP 鉴权：HTTP 侧 Bearer 令牌常量时间比较（sha256 摘要 + timingSafeEqual）＋**把调用方凭据原样转发给 Core**，因此每客户端授权／scope／撤销／片段上限对 Agent 同样生效；令牌绝不回显于 `/healthz` 或日志；401 带 `www-authenticate`。工具失败以 MCP `isError` ＋ 中文原因返回，Agent 会话不崩
- MCP Client 连接验证脚本 `pnpm --filter @noltri/mcp-server run verify`（真实 `@modelcontextprotocol/sdk` Client 经 StreamableHTTPClientTransport 连接，已实测通过并产生真实数据）
- 客户端使用指引 `skills/knowledge-skill/SKILL.md`（工具地图 + 诚实规则：只用工具返回的节点 id、失败如实上报、原文不可改）

### Research（P5–P6，研究工作台）
- **Research 域全链路（P5-A/B，R01）**：schema 契约（含冻结的 `CHARTER_FIELD_NAMES` 字段词表与 `RELATION_PAIRINGS` 端点配对表）→ storage 双驱动（memory／SQLite 共用同一份 `research-repository-contract.ts`，桌面 profile 两域共用同一 `sqliteFile`、WAL 双句柄）→ 领域门面 **39 方法**（每个方法先从凭据取 `userId`、再证明项目归属）→ **38 条 REST 端点**（18 读 ＋ 20 写）。研究端点**故意全部不进授权 scope 表**（研究文本未接 §435 片段上限，grant 一律拒绝），架构门禁同时钉住条数（38）与「无 scope 条目」两条（`services/knowledge-core/test/architecture-gate.test.ts` 12 项）
- **R02 关系方向由端点配对表钉死**：五种证据关系（`supports｜partially_supports｜contradicts｜qualifies｜contextualizes`）只允许 evidence→claim，`answers` 只允许 claim→RQ，`appears_in` 只允许 claim→章节；schema 与 domain 两侧拒绝非法配对；「有支撑」口径只认前两种，反证／限定从不计入
- **R06 批准章程基线**：批准 append-only 增版、快照批准即冻结、`changedFields` 相对上一版（首版空表）；按名打 `charter_baseline` 复核标记（同基线重复批准原地刷新，不新增行）；**drift-check 以最新基线快照为对照**（无基线回退草稿行）—— R06「后续检查绑定新基线」，只改草稿不批准偏移不消失
- **R03 出处指针与归档安全**：证据出处（`nodeId`／`rawSourceId`／`locationOrigin`）可空、不重绑；`GET /api/research/references` 只读跨项目检查（至少给一个 id）；归档知识节点时**先**标 `source_archived`（引用证据与其支撑的论点）再完成归档、恢复不误清、未接线不阻断；V1 无删除／合并，`rawSourceId` 列已预留
- **R04／R05 六类偏移检查（P6）**：确定性规则、**V1 不调模型**（`drift.ts` 纯函数：无 IO／时钟／模型调用）；按 `(driftType, sourceEntityId, targetEntityId)` 对 open findings 去重并入；demo 种子三个刻意缺口逐类命中（C-03→evidence_drift warning、C-05→causality_drift critical、journal change→journal_drift warning，summary `{3,0,2,1}`；`research-drift.test.ts` 29 项 ＋ `research-demo.test.ts` 7 项）
- **R07 研究地图与上下文包（P6）**：map 聚合 questions→evidence→claims→sections→contribution 与七种边、`unsupportedClaimIds` 与「有支撑」同口径；context-pack 12 区块、`markdown`＝`blocks` 拼接、默认按需最小化（`research-map-context.test.ts` 3 项）
- **客户端与桌面（P5-D／P6-C）**：api-client **38 个类型化调用**（45 行 WIRE 表逐行核对方法、路径与载荷形态；`packages/api-client/test/research.test.ts` 59 项）；`@noltri/shared` 补齐研究中文词表（现 20 张 map 以「键集合＝schema 枚举」契约测试锁定）；桌面「研究工作台」**九个视图**（总览／章程与边界／研究问题／证据工作台／论点与章节／决策与时间线 ＋ 偏移检查／研究地图／上下文包），纯决策逻辑在 `research-model.ts`（25 项）、渲染以 `renderToStaticMarkup` 断言（24 项）
- **R08 重启／导出往返（P5-E）**：`research-restart.test.ts` 按桌面 profile 双句柄布局关掉再开 ＋ 库文件复制到新路径重开，13 条关系五元组、首个基线快照、pending／cleared 标记与出处指针逐项读回

## 后续实现

### 验证缺口（代码已就绪，需真实环境补验）
- 浏览器插件在真实 Chrome 中加载并实测捕获闭环
- **扩展与 Native Host 之间的桥尚未接线**：`apps/extension/src/manifest.json` 的权限仍是 `contextMenus / storage / activeTab`，**不含 `nativeMessaging`**。增加它等于替用户在浏览器里领一项新权限，属 §16 明令不得静默进行的决定，需用户点头后单独一步完成（含 host 程序路径的打包解析、扩展 id 的取得与安装预览的实跑）。因此 P3-C 的 host 是由**独立的 stdio 测试驱动与真实 Core** 验证的（11 个请求场景／4 个会话），**不是**由 Chrome 进程驱动的
- 扩展的「粘贴框收纳」与全局快捷键：受限页面文案、队列、toast 均有测试，但**粘贴框在真实弹窗里的交互未实机走通**（ego-browser 无法加载未打包权限的 MV3 扩展）
- 待发送队列的无痕禁用是启动时的能力判定＋测试锁定的行为，**未在真实无痕窗口中实测**
- Native Host 的注册（`install-cli.ts install --confirm`）本轮**只做过预览与临时 HOME 下的写入测试**，没有对用户真实浏览器目录执行过写入；`~/Library/Application Support/Google/Chrome/NativeMessagingHosts` 保持原样
- Windows 的 host 注册需要注册表键，安装器**拒绝代改**，而手动导入的 `.reg` 样本与步骤文档**尚未编写**
- 桌面 Companion 实机运行：TCC 辅助功能授权流程、胶囊/粘贴窗/快捷键真机交互、MCP 配置写入真实客户端配置文件
- **Setup Manager 连接中心的面板没有在真实应用窗口里点过**：Agent 矩阵、授权选项、确认框文案、备份列表与恢复按钮都只有单元／契约层证据（137 项前端测试＋28 项 Rust 测试），`vite build` 通过；P8 已实机冷启动安装版并截图 Setup Manager（AX 未授权边界如实显示），但上述面板仍未实际点验，也未对用户真实 Claude 配置文件执行过写入
- **M03 的「指定可用 Agent」一支是通过真实 stdio MCP 进程 × 真实 Core 证明的**（握手＋`tools/list`＋写入＋读回＋撤销，见 `docs/P0-baseline-and-recovery.md` §15.5），**不是**在 Claude Desktop 的界面里点出来的；第三方 Agent 客户端的 UI 行为本轮未验证
- **「复制 MCP 条目」按钮仍沿用设备凭据**（不可撤销、不受片段上限约束），界面已把这句话写在按钮旁；要彻底去掉这条后门路径需要客户端配置写入全部走「签发→写入」，P8 未改这条通路，仍是后续收尾项
- **M05 已由 P8 验证**：launcher（`host/noltri-native-host`，指向随包运行时而非开发目录）写入 App 数据目录后，经 4 字节长度帧协议实测调起随包 host 并回报 Core 身份（`productId`／`instanceId`）；包内 strings 扫描 0 处开发目录引用。「被 Setup 修复」由 repair 命令＋单元测试覆盖、界面区块已就位；注册写入仍未对浏览器目录落盘（见上一条 nativeMessaging 决定）
- 桌面打包已完成（P8：`.app`／`.dmg`、arm64、ad-hoc 签名）；**notarization 仍欠**——本机无 Developer ID，对外分发前必须补正式签名与公证
- **SQLite 安装版实机闭环（P8 已验）**：从挂载的 dmg 冷启动（随包运行时拉起 Core／MCP）、强杀全部进程后重启（WAL 580 KB 未合并 → 重放后计数与原文一致）、SQLite `.backup` 备份快照在新路径读回同一数据、100 次同键重复提交只落 1 行；**未测**：磁盘不足、只读目录、8787／8790 被占用时的表现、从旧版本升级覆盖安装
- `node:sqlite` 随包 Node v24.18.0 实测：模块加载与 Core／MCP 进程运行**均无 `ExperimentalWarning` 输出**；`better-sqlite3` 替代路径未采用（无必要）
- 真实模型调用（BYOK 网关）下的抽取/嵌入/对话质量验证
- 知识工作台未进 WebView 截图：本轮以浏览器驱动 **dist 构建产物**（`vite preview`，非 `tauri dev`）完成 P2 实机回归，页面与 Tauri 加载的是同一份 bundle，但**窗口显示/隐藏、`close` 拦截、设置持久化等 Tauri 专有路径仍未实机运行**
- 工作台「重试归纳」「移动节点（拖拽）」「写摘要」三条写路径本轮**只在契约与单元测试层验证**，实机回归未触发（实机场景已覆盖重复归档的 conflict 提示与重命名）
- `apps/web` 已随 P7 云依赖清理删除（归档 `ad1d0c6`）；`apps/desktop/test/workbench-render.test.tsx` 中的 Web 对等断言同步移除，保留「V1 词汇」断言
- 桌面端错误文案仍为英文：`packages/api-client` 抛出的网络/服务端错误字符串直接进入工作台错误提示，与 `apps/web/lib/client-api.ts` 的 `describeError` 行为一致，因此**不构成对等性缺口**，但中文界面下会混现英文，属于已知体验缺口

### V1 收尾项
- 发布物整理：扩展打包产物上架准备、桌面 dmg、部署文档
- **P3 已交付（协议、幂等、降级队列、Native Host、身份门禁、安装器）；仍欠的一步是扩展的 `nativeMessaging` 权限与 host 路径接线**——它替用户向浏览器领新权限，必须用户点头后单独完成，随后才谈得上真实 Chrome 加载验收
- **P4 已交付（stdio 握手、Agent 矩阵、备份／幂等／可撤销卸载、每客户端授权与 scope、写入验证探针、§435 隐私边界与三项授权选项）；M05 打包路径已由 P8 收尾；仍欠的是在真实 Agent 客户端／真实应用窗口里的点验**（见上两条）
- **P5／P6 已交付（Research 整合与偏移检查）**：schema、双驱动 storage、39 方法门面、**38 条端点**、api-client 38 个类型化调用、桌面九视图、demo 种子与 R08 往返；六类偏移检查（确定性、不调模型）、研究地图与上下文包落地 —— R01／R02／R03／R06／R08 之外，R04／R05／R07 补齐。仍欠：研究端点对 Agent 客户端的授权面按设计关闭 —— 开启前必须先让 §435 的片段上限覆盖研究文本（契约 §4）
- **P7 已交付（云依赖清理）**：`apps/web`、Supabase 驱动与迁移 SQL、云 env、workspace／锁文件引用全部删除；审计线索词只剩允许清单（归档引用／拒绝样例／历史文档）；干净 clone 安装／测试／构建桌面包通过（68 文件 / 1110 项，0 skip）。报告：`docs/Noltri_V1_P7_Delivery_Report.html`
- **P8 已交付（安装包与最终实机验收）**：随包运行时托管（Core／MCP／Native Host launcher）、`.app`／`.dmg` 构建、M05 验证、冷启动／异常退出／备份恢复／重复提交实机验收、最终报告 `docs/Noltri_V1_P8_Delivery_Report.html`；仍欠：公证（本机无 Developer ID）、从旧版本升级覆盖安装、端口占用／磁盘不足／只读目录的实机演练、真实模型调用（BYOK 网关）

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
