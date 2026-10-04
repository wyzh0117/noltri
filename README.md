# 知序 Noltri

个人知识编译系统：Capture（捕获）→ Compile（归纳）→ Connect（连接）→ Complete（补全）。
用户从任意入口选中文本，一键「归纳知识点」：系统**先保存原文**（RawSource，永不覆盖），再由
Knowledge Core 抽取原子知识点、生成向量、做相似度检索，并按 attach（挂到已有节点）/
create（新建节点）/ merge（合并）三种决策把知识点挂进知识树。

总控文档：`PROJECT_MASTER.md`（架构与铁律）、`V1_DEVELOPMENT.md`（V1 开发计划）、
`FUNCTION_MAP.md`（已实现 / 后续实现 清单，唯一事实来源）。

## 仓库结构

| 位置 | 内容 |
| --- | --- |
| `packages/schema` | zod 契约（CaptureRequest / CaptureResult / KnowledgeNode / …），前后端共用 |
| `packages/shared` | 时间、ID、纯文本渲染（树形渲染、知识点行）、知识树视图模型与中文标签字典、KnowledgeError 等 |
| `packages/api-client` | 对 core REST 的类型安全客户端（全部入口共用） |
| `packages/storage` | InMemory + SQLite(本机文件，`node:sqlite`) + Supabase(Postgres) 三套仓储，同一份契约逐驱动执行 |
| `packages/ai-provider` | AI 抽象：`offline`（确定性测试）与 `openai`（BYOK，OpenAI 兼容 chat+embeddings） |
| `services/knowledge-core` | Knowledge Core：唯一知识逻辑来源，REST API，架构门禁 `pnpm gate` |
| `services/ai` | 归纳管线编排（原文落库 → 抽取 → 嵌入 → 相似度 → 分类决策 → 持久化） |
| `services/mcp-server` | MCP 服务器（Streamable HTTP，7 个工具），只经 ApiClient 访问 core |
| `apps/web` | Next.js 16 知识树 Web 应用 + `/api/web/*` 代理（supabase / dev-token 两种鉴权）。P2 已把知识树／收件箱／搜索／节点对话迁入桌面工作台，本应用仍在运行，删除排在 P7 |
| `apps/desktop` | Tauri 2 macOS 桌面伴侣：AX 选区观察、胶囊 UI、手动粘贴窗、设置管理器、MCP 配置写入，以及 **知识工作台**（收件箱整理 / 知识树三栏 / 搜索 / 节点对话，直连本机 Core） |
| `apps/extension` | Chrome MV3 扩展（选区捕获，SDK 打包内联） |
| `supabase/migrations` | Postgres 建表 SQL（静态审查通过；未在真实库执行过） |
| `skills/knowledge-skill` | MCP 客户端侧使用指引（7 个工具的地域与诚实规则） |

铁律（`pnpm gate` 机器检查）：core 不直接依赖 pg/supabase/openai/express；全文只有一处
`createRawSource`；四个入口共用同一 ApiClient；MCP 不碰数据库。

## 快速开始（零外部依赖）

```bash
pnpm install

# 1) 启动 Knowledge Core（离线确定性 AI，不需要任何 key）
#    内存存储（重启即丢，仅演示）：
STORAGE_DRIVER=memory AI_PROVIDER=offline PORT=8787 npx tsx services/knowledge-core/src/server.ts
#    本机文件存储（SQLite，重启仍在；profile 由 NOLTRI_SQLITE_FILE > NOLTRI_DATA_DIR > ~/.noltri/data 决定）：
STORAGE_DRIVER=sqlite NOLTRI_SQLITE_FILE="$HOME/.noltri/data/noltri.sqlite" AI_PROVIDER=offline \
  NOLTRI_DEV_USER_ID=you PORT=8787 npx tsx services/knowledge-core/src/server.ts
# 健康检查: curl http://127.0.0.1:8787/api/health

# 2) 启动 MCP 服务器（HTTP :3211，Bearer 令牌见环境变量）
KNOWLEDGE_API_URL=http://127.0.0.1:8787 MCP_HTTP_TOKEN=dev-token MCP_HTTP_PORT=3211 \
  npx tsx services/mcp-server/src/server.ts

# 3) Web 应用
pnpm --filter @noltri/web dev   # http://localhost:3000，登录页用 dev-token 模式

# 4) 桌面知识工作台（P2 迁入）
pnpm --filter @noltri/desktop run dev      # = tauri dev；主窗口（Setup Manager）里点「打开知识工作台」
```

工作台通过 Rust 设置存储里的 Core 地址与 Bearer 令牌直连本机 Core；未配置 AI（`AI_PROVIDER=offline`）
时收件箱的人工归档仍可用。

MCP 端到端验证（需要 core 在 8787 运行）：

```bash
pnpm --filter @noltri/mcp-server run verify
```

## 环境变量

| 变量 | 取值 | 说明 |
| --- | --- | --- |
| `PORT` | 默认 8787 | core 监听端口 |
| `STORAGE_DRIVER` | `memory` \| `sqlite` \| `supabase` | 存储驱动，默认 `memory`（重启即丢）；`sqlite` 为本机文件库，`supabase` 需要下一组变量 |
| `NOLTRI_SQLITE_FILE` | 路径 | 本机 SQLite 文件地址，优先级最高 |
| `NOLTRI_DATA_DIR` | 目录 | profile 目录；两者都不设时用 `~/.noltri/data/noltri.sqlite` |
| `NOLTRI_DEV_USER_ID` | 用户 id | 本机单用户身份（`dev-open` / `dev-token` 策略） |
| `NOLTRI_DEV_TOKEN` / `NOLTRI_DEV_REQUIRE_TOKEN` | 任意串 / 开关 | dev-token 策略的令牌与是否强制校验；令牌绝不回显于健康检查或日志 |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | URL / JWT | Supabase REST 访问（service role，仅服务端） |
| `AI_PROVIDER` | `offline` \| `openai` | `openai` 为 BYOK：OpenAI 兼容的 chat + embeddings |
| `OPENAI_API_KEY` | sk-… | BYOK 密钥，仅服务端读取，绝不落库/落日志 |
| `OPENAI_BASE_URL` | 默认官方 | 可指向任何 OpenAI 兼容网关 |
| `OPENAI_CHAT_MODEL` / `OPENAI_EMBEDDING_MODEL` | 模型名 | 例如 `gpt-4o-mini` / `text-embedding-3-small` |
| `MCP_HTTP_TOKEN` | 任意串 | MCP Bearer 令牌（常量时间比较，绝不回显） |
| `MCP_HTTP_PORT` | 默认 3211 | MCP HTTP 端口 |
| `KNOWLEDGE_API_URL` | URL | MCP → core 的基地址 |
| `AUTH_MODE` | core 内部 | `supabase`（验证 JWT）\| `dev-token` \| `dev-open` |

## 各工作区常用命令

```bash
pnpm -r run typecheck                 # 全部 11 个工作区包
pnpm -r --no-bail run test            # 全部测试（PG 集成测试需 NOLTRI_PG_TEST_URL，缺失时自动 skip）
pnpm gate                             # core 架构门禁
pnpm build                            # turbo 全量构建
```

单工作区示例：

```bash
pnpm --filter @noltri/knowledge-core run test
pnpm --filter @noltri/web run test          # node --import tsx --test
pnpm --filter noltri-desktop run test       # vitest
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## BYOK 说明

系统默认不内置任何云服务凭据。`AI_PROVIDER=openai` 时由使用者自带
`OPENAI_API_KEY`（兼容 OpenAI 接口规范的任意服务商皆可，通过 `OPENAI_BASE_URL` 切换）。
密钥只存在于服务端进程环境；测试一律走 `offline` 提供方，不会产生真实计费调用。
真实云数据库（Supabase）同理：代码与迁移已就绪并静态审查，但本仓库提交时不携带任何
真实项目凭据，接入时自行配置 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`。

## 验证状态（诚实边界）

以下能力有自动化测试或运行时证据支撑；凡未列出的（真实浏览器加载扩展、桌面 GUI 实机
运行、真实模型调用、真实 Supabase 实例、桌面打包签名）均未验证，详见 `FUNCTION_MAP.md`
的「后续实现」。
