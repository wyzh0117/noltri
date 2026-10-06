# 知序 Noltri

个人知识编译系统：Capture（捕获）→ Compile（归纳）→ Connect（连接）→ Complete（补全）。
用户从任意入口选中文本，一键「归纳知识点」：系统**先保存原文**（RawSource，永不覆盖），再由
Knowledge Core 抽取原子知识点、生成向量、做相似度检索，并按 attach（挂到已有节点）/
create（新建节点）/ merge（合并）三种决策把知识点挂进知识树。

总控文档：`PROJECT_MASTER.md`（架构与铁律）、`FUNCTION_MAP.md`（已实现 / 后续实现 清单，唯一事实来源）。
本轮（本地桌面）的开发基准是 `Noltri_Local_Desktop_Research_V1_Development.md`；
`V1_DEVELOPMENT.md` 保留为 Web 时代的 V1 计划（已标注为历史文档）。

## 仓库结构

| 位置 | 内容 |
| --- | --- |
| `packages/schema` | zod 契约（CaptureRequest / CaptureResult / KnowledgeNode / …），前后端共用 |
| `packages/shared` | 时间、ID、纯文本渲染（树形渲染、知识点行）、知识树视图模型与中文标签字典、KnowledgeError 等 |
| `packages/api-client` | 对 core REST 的类型安全客户端（全部入口共用） |
| `packages/storage` | InMemory + SQLite(本机文件，`node:sqlite`) 两套仓储，同一份契约逐驱动执行（原 Supabase(Postgres) 驱动已随 P7 云依赖清理删除，归档 `ad1d0c6`） |
| `packages/ai-provider` | AI 抽象：`offline`（确定性测试）与 `openai`（BYOK，OpenAI 兼容 chat+embeddings） |
| `services/knowledge-core` | Knowledge Core：唯一知识逻辑来源，REST API，架构门禁 `pnpm gate` |
| `services/ai` | 归纳管线编排（原文落库 → 抽取 → 嵌入 → 相似度 → 分类决策 → 持久化） |
| `services/mcp-server` | MCP 服务器（Streamable HTTP，7 个工具），只经 ApiClient 访问 core |
| `apps/desktop` | Tauri 2 macOS 桌面伴侣：AX 选区观察、胶囊 UI、手动粘贴窗、设置管理器、MCP 配置写入，以及 **知识工作台**（收件箱整理 / 知识树三栏 / 搜索 / 节点对话 / Research，直连本机 Core） |
| `apps/extension` | Chrome MV3 扩展（选区捕获 + 右键菜单 + SDK 打包内联；Core 连不上时把原文留在本机待发送队列，重发沿用同一 `requestId`） |
| `services/native-host` | Chrome / Edge / Brave / Firefox 的 Native Messaging host：长度前缀帧协议，只接受 `hello｜health｜capture｜capture_batch`，转发前核验 Core 身份；附先预览后写入的注册安装器 |
| `skills/knowledge-skill` | MCP 客户端侧使用指引（7 个工具的地域与诚实规则） |

铁律（`pnpm gate` 机器检查）：core 不直接依赖 pg/supabase/openai/express；全文只有一处
`createRawSource`；四个入口共用同一 ApiClient；MCP 不碰数据库；浏览器 Native Host 不引用
存储／AI 层、也从不手写 fetch，只在 `host.ts` 一处经 ApiClient 触达 Core。

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

# 2) 启动 MCP 服务器（HTTP :8790；默认不校验调用方，AUTH_REQUIRED=true 时须配 NOLTRI_ACCESS_TOKEN）
KNOWLEDGE_API_URL=http://127.0.0.1:8787 MCP_PORT=8790 \
  npx tsx services/mcp-server/src/server.ts

# 3) 桌面知识工作台（P2 迁入）
pnpm --filter @noltri/desktop run dev      # = tauri dev；主窗口（Setup Manager）里点「打开知识工作台」

# 4) 浏览器 Native Host（P3）：正常由浏览器按 manifest 拉起，也可手动喂帧
#    帧 = 4 字节小端长度 + UTF-8 JSON；stdout 只出协议帧，日志一律走 stderr
STORAGE_DRIVER=sqlite AI_PROVIDER=offline PORT=8787 npx tsx services/knowledge-core/src/server.ts &
printf '\x11\x00\x00\x00{"type":"health"}' | NOLTRI_API_BASE_URL=http://127.0.0.1:8787 \
  npx tsx services/native-host/src/main.ts

#    注册：先打印预览（写入位置 / host 程序 / 允许的扩展），不带 --confirm 时不写任何东西
npx tsx services/native-host/src/install-cli.ts install --host <host 可执行文件> --extension-id <32 位扩展 id> [--browser chrome|edge|brave|firefox]
npx tsx services/native-host/src/install-cli.ts install ... --confirm   # 确认后才会落盘，已存在的 manifest 先备份
npx tsx services/native-host/src/install-cli.ts uninstall               # 撤下本机写入的，并恢复安装前的备份
```

> Native Host 目前只能被测试与脚本驱动：扩展的 manifest 仍**没有** `nativeMessaging` 权限，浏览器侧的桥尚未接线。
> 加这项权限等于替用户向浏览器领新权限，需要单独确认，不做静默变更（见 `FUNCTION_MAP.md` 的「验证缺口」）。

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
| `STORAGE_DRIVER` | `memory` \| `sqlite` | 存储驱动，代码默认 `memory`（重启即丢，仅测试／演示）；模板 `.env` 与桌面端用 `sqlite`（本机文件库） |
| `NOLTRI_SQLITE_FILE` | 路径 | 本机 SQLite 文件地址，优先级最高 |
| `NOLTRI_DATA_DIR` | 目录 | profile 目录；两者都不设时用 `~/.noltri/data/noltri.sqlite` |
| `NOLTRI_DEV_USER_ID` | 用户 id | 本机单用户身份（`dev-open` / `dev-token` 策略） |
| `NOLTRI_DEV_TOKEN` / `NOLTRI_DEV_REQUIRE_TOKEN` | 任意串 / 开关 | dev-token 策略的令牌与是否强制校验；令牌绝不回显于健康检查或日志 |
| `AI_PROVIDER` | `offline` \| `openai` | `openai` 为 BYOK：OpenAI 兼容的 chat + embeddings |
| `OPENAI_API_KEY` | sk-… | BYOK 密钥，仅服务端读取，绝不落库/落日志 |
| `OPENAI_BASE_URL` | 默认官方 | 可指向任何 OpenAI 兼容网关 |
| `OPENAI_CHAT_MODEL` / `OPENAI_EMBEDDING_MODEL` | 模型名 | 例如 `gpt-4o-mini` / `text-embedding-3-small` |
| `MCP_PORT` | 默认 8790 | MCP HTTP 端口 |
| `AUTH_REQUIRED` | 默认 false | MCP HTTP 是否要求调用方 Bearer；开启时未配 `NOLTRI_ACCESS_TOKEN` 直接拒绝启动 |
| `KNOWLEDGE_API_URL` | URL | MCP → core 的基地址；stdio 入口**没有它就不开始服务**（工具不知道该转给谁） |
| `NOLTRI_ACCESS_TOKEN` | 任意串 | MCP（HTTP 与 stdio）向 core 出示的凭据；可以是设备凭据，也可以是连接中心签发的**某客户端专属授权凭据**（后者带 scope／项目／片段上限且可撤销）。绝不写入日志 |
| `NOLTRI_GRANT_FILE` | 路径 | 本地客户端授权表位置。**不设＝该部署不启用授权体系**，行为与 P4 之前完全一致；桌面端会把它写在 `NOLTRI_DATA_DIR/grants.json`。落盘只存 SHA-256 摘要，明文只在签发响应里出现一次 |
| `NOLTRI_API_BASE_URL` | URL | Native Host → core 的基地址；缺省 `http://127.0.0.1:8787`，被 `native-host.json` 覆盖 |
| `NOLTRI_API_TOKEN` | 任意串 | Native Host 使用的运行期凭据；同上被文件覆盖，**绝不写入日志或安装预览**（启动日志只记 `hasToken` 布尔） |
| `~/.noltri/data/native-host.json` | `{baseUrl,token,...}` | 本机 App 写给 Native Host 的端点文件；组位或他人位非 0 即被拒绝使用（不解析、不读取内容） |

## 各工作区常用命令

```bash
pnpm -r run typecheck                 # 全部 11 个工作区包
pnpm -r --no-bail run test            # 全部测试（68 个测试文件 / 1110 项，无 skip；P7 后已无依赖外部数据库的用例）
npx turbo run test typecheck --force --concurrency=2   # 全量门禁：22 个任务（11 包 × 2），必须带 --force
pnpm gate                             # core 架构门禁（含 MCP／Native Host 的入口边界检查）
pnpm build                            # turbo 全量构建
```

单工作区示例：

```bash
pnpm --filter @noltri/knowledge-core run test
pnpm --filter @noltri/desktop run test      # vitest
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## BYOK 说明

系统默认不内置任何云服务凭据。`AI_PROVIDER=openai` 时由使用者自带
`OPENAI_API_KEY`（兼容 OpenAI 接口规范的任意服务商皆可，通过 `OPENAI_BASE_URL` 切换）。
密钥只存在于服务端进程环境；测试一律走 `offline` 提供方，不会产生真实计费调用。
数据层没有云侧：V1 使用本机 SQLite 文件库（`STORAGE_DRIVER=sqlite`）；仓库、锁文件与
依赖树均不包含托管数据库 SDK 或驱动。

## 本地客户端授权与 MCP 连接（P4）

V1 §569 要求把「用户入口上的 `NOLTRI_DEV_TOKEN`」换成「后台管理的本地客户端授权」。落地形态是：
设备凭据只用于本机 App 自己，Agent 客户端各持一份**可撤销、可收窄**的凭据。

```bash
# 1. 启动一个「启用授权 + 要求凭据」的 Core（两个开关缺一不可）
STORAGE_DRIVER=sqlite AI_PROVIDER=offline PORT=8787 \
NOLTRI_DEV_TOKEN=<本机设备凭据> NOLTRI_DEV_REQUIRE_TOKEN=true \
NOLTRI_GRANT_FILE=$HOME/.noltri/data/grants.json \
npx tsx services/knowledge-core/src/server.ts

# 2. 连接中心为某个 Agent 签发一份授权（明文只在响应里出现一次，库里只存摘要）
curl -s -X POST http://127.0.0.1:8787/api/admin/grants \
  -H "authorization: Bearer <本机设备凭据>" -H 'content-type: application/json' \
  -d '{"label":"知序 · Claude Desktop","client":"claude","scopes":["capture","read"],"snippetChars":200}'

# 3. 把返回的 secret 交给该客户端（stdio 入口的形式）；撤销即刻对已建立的连接生效
KNOWLEDGE_API_URL=http://127.0.0.1:8787 NOLTRI_ACCESS_TOKEN=<secret> \
npx tsx services/mcp-server/src/stdio.ts
curl -s -X POST http://127.0.0.1:8787/api/admin/grants/<id>/revoke \
  -H "authorization: Bearer <本机设备凭据>"
```

三条口径值得在文档里说死，因为它们都不是显然的：

- `snippetChars` 只裁**正文**（检索命中、节点详情、上下文包、收件箱预览、原文全文），标题与树结构不裁；
  **设备凭据与未启用授权的 Core 不受片段上限**——收件箱复核需要全文，而那时根本没有授权可裁。
- 「只写采集」（`scopes:["capture"]`）与「限制项目」是互斥的：限制项目只对读取有意义，
  连接中心在**签发之前**就指出这个矛盾，而不是签出一份 Core 会拒绝的授权。
- `NOLTRI_DEV_REQUIRE_TOKEN` 未设时 Core 是 `dev-open`，此时**签发端点直接 401**（开放 Core 不得发放
  长期凭据）。这条是本轮实测撞出来的：只设 `NOLTRI_DEV_TOKEN` 会让签发失败，而失败的凭据传给 MCP 后
  所有工具调用仍会「成功」，但走的是不受片段上限约束的开放通路——只看「调用成功」会得出错误结论。

## 验证状态（诚实边界）

以下能力有自动化测试或运行时证据支撑；凡未列出的（真实浏览器加载扩展、桌面 GUI 实机
运行、真实模型调用、桌面打包签名）均未验证，详见 `FUNCTION_MAP.md`
的「后续实现」。

P3 的边界要说清楚：Native Messaging host 的协议、身份门禁、幂等与安装器由 135 项测试＋
真实 stdio 进程对真实 Core 的实测覆盖（独立实现的帧解析器驱动，11 个请求场景／4 个会话），
但**浏览器还没有真正拉起过这个 host**——扩展未申请 `nativeMessaging` 权限，这项决定留给用户。

P4 的边界同样要说清楚：Agent 连接一侧的握手、`tools/list`、写入、读回、片段上限与撤销，是由
**真实的 stdio MCP 进程 × 真实的 SQLite Core** 实测出来的（18 项断言全通过，见
`docs/P0-baseline-and-recovery.md` §15.5），而**不是**在 Claude Desktop 的界面里点出来的；
Setup Manager 的矩阵、授权选项与备份／恢复按钮只有单元与契约层证据，本轮**未运行 `tauri dev`、
未打包、未对用户真实客户端配置文件执行过写入**。「复制 MCP 条目」这一条通路仍沿用设备凭据
（不可撤销、不受片段上限约束），界面已把这句话说在按钮旁边。

P7 的边界：云依赖清理已做到运行依赖层——`apps/web`、Supabase 驱动与迁移 SQL、云 env、
workspace／锁文件引用全部删除；审计线索词只剩归档引用、拒绝样例与历史文档（已列入 P7 报告
的允许清单）。干净 clone 验证（`git clone` → `pnpm install --frozen-lockfile` → `pnpm test`
→ 桌面 `vite build`）在 P7 提交上实测通过。
