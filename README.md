# 知序 Noltri

个人知识编译系统：Capture（捕获）→ Compile（归纳）→ Connect（连接）→ Complete（补全）。
用户从任意入口选中文本，一键「归纳知识点」：系统**先保存原文**（RawSource，永不覆盖），再由
Knowledge Core 抽取原子知识点、生成向量、做相似度检索，并按 attach（挂到已有节点）/
create（新建节点）/ merge（合并）三种决策把知识点挂进知识树。

总控文档：`PROJECT_MASTER.md`（架构与铁律）、`V1_DEVELOPMENT.md`（V1 开发计划）、
`FUNCTION_MAP.md`（已实现 / 后续实现 清单，唯一事实来源）。
Research V1：`Noltri Research V1 开发文档.md`（科研连续性工作台规格）、
`docs/research-contract.md`（实现契约：REST 表、Drift 规则、Context Pack 格式）。

## 仓库结构

| 位置 | 内容 |
| --- | --- |
| `packages/schema` | zod 契约（CaptureRequest / KnowledgeNode / Research 实体 …），前后端共用 |
| `packages/shared` | 时间、ID、纯文本渲染（树形渲染、知识点行）、KnowledgeError 等 |
| `packages/api-client` | 对 core REST 的类型安全客户端（全部入口共用，含 27 个 research 方法） |
| `packages/storage` | InMemory + Supabase(Postgres) 两套仓储，同一接口（知识域 + Research 域各一对） |
| `packages/ai-provider` | AI 抽象：`offline`（确定性测试）与 `openai`（BYOK，OpenAI 兼容 chat+embeddings） |
| `services/knowledge-core` | Knowledge Core：唯一知识逻辑来源，REST API + Research Domain，架构门禁 `pnpm gate` |
| `services/ai` | 归纳管线编排（原文落库 → 抽取 → 嵌入 → 相似度 → 分类决策 → 持久化） |
| `services/mcp-server` | MCP 服务器（Streamable HTTP，7 个工具），只经 ApiClient 访问 core |
| `apps/web` | Next.js 16 知识树 Web 应用 + Research 工作台 + `/api/web/*` 代理（supabase / dev-token 两种鉴权） |
| `apps/desktop` | Tauri 2 macOS 桌面伴侣：AX 选区观察、胶囊 UI、手动粘贴窗、设置管理器、MCP 配置写入 |
| `apps/extension` | Chrome MV3 扩展（选区捕获，SDK 打包内联） |
| `supabase/migrations` | Postgres 建表 SQL（静态审查通过；未在真实库执行过） |
| `skills/knowledge-skill` | MCP 客户端侧使用指引（7 个工具的地域与诚实规则） |

铁律（`pnpm gate` 机器检查）：core 不直接依赖 pg/supabase/openai/express；全文只有一处
`createRawSource`；四个入口共用同一 ApiClient；MCP 不碰数据库。

## 快速开始（零外部依赖）

```bash
pnpm install

# 1) 启动 Knowledge Core（内存存储 + 离线确定性 AI，不需要任何 key）
STORAGE_DRIVER=memory AI_PROVIDER=offline PORT=8787 npx tsx services/knowledge-core/src/server.ts
# 健康检查: curl http://127.0.0.1:8787/api/health

# 2) 启动 MCP 服务器（HTTP :3211，Bearer 令牌见环境变量）
KNOWLEDGE_API_URL=http://127.0.0.1:8787 MCP_HTTP_TOKEN=dev-token MCP_HTTP_PORT=3211 \
  npx tsx services/mcp-server/src/server.ts

# 3) Web 应用
pnpm --filter @noltri/web dev   # http://localhost:3000，登录页用 dev-token 模式
```

MCP 端到端验证（需要 core 在 8787 运行）：

```bash
pnpm --filter @noltri/mcp-server run verify
```

## 环境变量

| 变量 | 取值 | 说明 |
| --- | --- | --- |
| `PORT` | 默认 8787 | core 监听端口 |
| `STORAGE_DRIVER` | `memory` \| `supabase` | 存储驱动；`supabase` 需要下一组变量 |
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
pnpm -r run typecheck                 # 全部 12 个工作区
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

## Research V1：科研文章连续性工作台

Research 是 Noltri 新增的 Project Type（不是独立 App）：把一篇科研文章管理成
Question → Evidence → Claim → Argument → Manuscript → Evolution 的长期项目。
知识树仍是首屏主体；顶栏「知识库 / 研究项目」切换进入 Research 工作台。

核心链路（开发文档 §34）每步均可达并有端到端测试：

```text
创建 Research Project → Research Charter（含 Research/Claim Boundary）→ RQ
→ Evidence → Claim → Evidence supports Claim → Claim answers RQ → Claim appears_in Section
→ Research Map（RQ→Evidence→Claim→Section→Contribution）
→ Drift Checker（六类：RQ/Contribution/Evidence/Causality/Method/Journal）
→ Research Context Pack
```

- 领域层：`services/knowledge-core/src/research/`（Drift Checker 为确定性纯函数，V1 不调用模型）；
- API：`/api/research/*` 21 端点 + `/api/web/research/*` 21 代理（全经共享 ApiClient）；
- 数据：11 张 research 表（只新增、不改旧表，RLS + 枚举 CHECK 门禁）；
- 测试种子：`buildResearchDemoData()` / `seedResearchDemo()`（§36「Noltri Research Demo」），
  在 `services/knowledge-core/test/research-demo.test.ts` 中驱动 §34 全链路验收。

## 验证状态（诚实边界）

以下能力有自动化测试或运行时证据支撑；凡未列出的（真实浏览器加载扩展、桌面 GUI 实机
运行、真实模型调用、真实 Supabase 实例、桌面打包签名）均未验证，详见 `FUNCTION_MAP.md`
的「后续实现」。

Research V1 同此口径：§34 核心链路、六类 Drift 规则、§36 Demo 种子与 21 端点 HTTP 闭环
均有自动化测试（knowledge-core 121 项、storage 41+31skip、web 96 项）；Research 工作台
`next build` 通过但**未在真实浏览器实机验收**，research 迁移 SQL 静态校验通过但**未在真实
Postgres 执行**（`NOLTRI_PG_TEST_URL` 就绪后 30 项 Supabase research 契约测试自动启用）。
