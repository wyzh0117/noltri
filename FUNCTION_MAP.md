# FUNCTION_MAP

> 唯一事实来源：本文件只允许两个分区。「已实现」只收录**有自动化测试或运行时证据**支撑的能力，
> 并在条目后标注验证方式；凡标注「未实机运行 / 未实测」的条目表示代码已完成且测试通过，但
> 尚未在真实环境中运行过。V2 / V3 范围的能力一律不进入「已实现」。

## 已实现

### Capture 入口
- MCP `capture_knowledge`（Streamable HTTP；SDK 真实客户端端到端验证：initialize → tools/list → tools/call，捕获结果落库并在知识树可见）
- 浏览器插件选区浮动「归纳知识点」按钮（MV3 content script；69 项测试、构建通过；**未在真实 Chrome 加载实测**）
- 浏览器插件右键菜单「归纳到知识树」（background service worker；同上，**未在真实 Chrome 加载实测**）
- 浏览器插件来源元数据提取：URL / 标题 / 域名 / 适量上下文（同上，**未在真实 Chrome 加载实测**）
- 浏览器插件归类结果提示（popup / 徽标反馈；同上，**未在真实 Chrome 加载实测**）
- 桌面 Companion macOS Accessibility 选区捕获（Rust AX 轮询观察者；8 项 Rust 测试、cargo check 通过；**GUI 未实机运行，TCC 授权流程未实测**）
- 桌面 Companion 浮动捕获胶囊（overlay 窗口 + 前端；22 项前端测试、vite 构建通过；**未实机运行**）
- 桌面 Companion 全局快捷键 → 粘贴式迷你捕获窗降级（Rust 快捷键注册 + paste 窗口；同上，**未实机运行**）
- 桌面 Companion 捕获管线前端流 `runCaptureFlow`：契约校验 → ApiClient 捕获 → 结果/失败文案 → `recordCaptureOutcome`（22 项测试覆盖：短文本本地拒绝不发包、原文已保存的 AI 失败提示、成功路径节点路径展示）

### Knowledge Core（66 项测试 + 本地 HTTP 实测闭环）
- RawSource **先保存**再 AI 处理（全文唯一 `createRawSource` 调用点，`pnpm gate` 机器检查）
- 原子知识点提取（offline 确定性提供方 + OpenAI 兼容 BYOK 提供方）
- 文本归一化
- 向量化（单批合并调用）与相似检索
- 自动归类决策：attach（挂已有节点）/ create（新节点）/ merge（合并）；置信度分层（高/中/低，阈值可配置）——实测中同一内容重复捕获被吸收进已有节点（itemCount 递增）
- AI 失败记录 `processingStatus='failed'` + `errorReason`，并支持 `retryCapture` 重试
- 知识树读取 / 节点详情 / 节点重命名 / 节点移动（含环检测与 VersionRecord 版本记录）
- 语义 + 关键词混合搜索
- 节点上下文装载（current_node / section / tree / whole_library）
- 节点级 AI 对话（会话 + 消息持久化）
- REST API 契约校验（zod）、健康检查、错误信封；身份仅取自凭证（JWT / dev-token / dev-open），绝不来自请求体

### 数据与架构
- 全部 9 张表模型：users / raw_sources / knowledge_items / knowledge_nodes / knowledge_edges / item_node_links / version_records / conversations / conversation_messages（InMemory 驱动 27 项契约测试全绿）
- StorageRepository 统一抽象 + InMemory 实现（完全实测）
- Supabase(Postgres) 仓储实现 + 迁移 SQL（`supabase/migrations/`，含 pgvector 向量列；27 项存储测试通过、17 项 PG 集成测试在无 `NOLTRI_PG_TEST_URL` 时自动跳过；迁移 SQL **通过静态审查，未在真实数据库执行**）
- AI Provider Adapter 抽象 + `offline`（确定性）与 `openai`（BYOK，OpenAI 兼容 chat + embeddings）两个实现（48 项测试；**未发起真实模型调用**）
- 结构变化版本记录与可逆基础（move/重命名均落 VersionRecord）
- 架构门禁 `pnpm gate`：core 无 pg/supabase/openai/express 依赖、四入口共用同一 ApiClient、MCP 不碰数据库

### Web App（55 项测试 + next build + 代理实测）
- 登录（dev-token 策略已实测：401 信封、307→/login、写 cookie 后取得会话；**Supabase Auth 策略已实现但未连真实 Supabase 项目实测**）
- 首屏知识树三栏布局（键盘导航、展开/折叠、拖拽移动目标选项；27 项树视图测试）
- 节点详情：摘要 / 知识点数 / 来源数 / 关联节点 / 与 AI 讨论
- 搜索（走 `/api/web/*` 代理 → core）
- 节点 AI 对话界面（上下文携带截断至最近消息；offline 提供方回环验证，**未用真实模型**）
- `/api/web/*` 代理层 28 项测试直连真实 Next 路由处理器 + 独立 fake core

### Desktop Companion 与 Setup Manager（22 项前端测试 + 8 项 Rust 测试；GUI 未实机运行）
- Tauri 2 壳与原生能力层（20 个 `#[tauri::command]` + 3 事件，TS 侧 commands 桥一一对应；cargo check 通过）
- macOS Accessibility 权限状态检测与引导（状态展示 + 打开系统设置 + 「我已授权」重新检查）
- Setup Manager Capture 状态区：观察者状态、捕获总开关、最小长度、测试选区捕获、按应用退出（opt-out chips）、不兼容应用列表与重试、最近收纳记录
- Setup Manager AI 连接区：5 个客户端（claude / claude_code / cursor / chatgpt_codex / other_mcp_client）连接测试（core 健康 + MCP tools/list 两段探针）、MCP 条目复制、按客户端写入配置文件（window.confirm 展示绝对路径与合并摘要，只替换自家条目、保留兄弟配置，**绝不存第三方密码**）、官方设置/文档直达
- 原生时间工具（UTC ISO-8601，Hinnant 算法，8 项 Rust 测试中的历法部分）

### MCP（20 项测试 + 真实 SDK 客户端端到端验证）
- Streamable HTTP `/mcp` endpoint（无状态：每 POST 新建 Server + transport，JSON 响应模式）
- 7 个工具：capture_knowledge / search_knowledge / get_knowledge_tree / get_knowledge_node / update_knowledge_node / move_knowledge_node / get_node_context（中文文本 + structuredContent 双输出）
- MCP 鉴权：Bearer 令牌常量时间比较（sha256 摘要 + timingSafeEqual）；令牌绝不回显于 `/healthz` 或日志；401 带 `www-authenticate`
- MCP Client 连接验证脚本 `pnpm --filter @noltri/mcp-server run verify`（真实 `@modelcontextprotocol/sdk` Client 经 StreamableHTTPClientTransport 连接，已实测通过并产生真实数据）
- 客户端使用指引 `skills/knowledge-skill/SKILL.md`（工具地图 + 诚实规则：只用工具返回的节点 id、失败如实上报、原文不可改）

## 后续实现

### 验证缺口（代码已就绪，需真实环境补验）
- 浏览器插件在真实 Chrome 中加载并实测捕获闭环
- 桌面 Companion 实机运行：TCC 辅助功能授权流程、胶囊/粘贴窗/快捷键真机交互、MCP 配置写入真实客户端配置文件
- 桌面打包与签名（dmg / notarization）
- Supabase 真实项目接入：迁移执行、pgvector 相似检索、RLS 用户隔离实测（`NOLTRI_PG_TEST_URL` 就绪后 17 项集成测试自动启用）
- Web Supabase Auth 策略对真实 Supabase 项目的登录实测
- 真实模型调用（BYOK 网关）下的抽取/嵌入/对话质量验证
- Supabase SQL 在真实库的执行（当前仅静态审查）

### V1 收尾项
- 发布物整理：扩展打包产物上架准备、桌面 dmg、部署文档

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
