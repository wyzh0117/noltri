# P0 基线核查、归档与恢复记录

核查时间：2026-10-04（本机 darwin arm64）。本文记录开发前的真实仓库状态与恢复点，不描述计划完成度。

## 1 目录与 Git 结构

| 项 | 实测结果 |
| --- | --- |
| 主工作树 | `/Users/youngi/Documents/MiniWork/知序-Noltri` · 分支 `main` · HEAD `9b9b4de` |
| 研究工作树 | `/Users/youngi/Documents/MiniWork/知序-Noltri-Research-V1` · 分支 `feature/research-v1` · HEAD `ad1d0c6` |
| worktree 关系 | `git worktree list --porcelain` 确认二者为同一仓库的 worktree（主目录 common dir 为仓库内 `.git`，研究目录 `.git` 为 gitdir 指针文件） |
| 远端 | `origin https://github.com/wyzh0117/noltri.git`；`main` 与 `feature/research-v1` 均已推送且与远端一致 |
| 旧研究分支真实名称 | `feature/research-v1`（非历史建议名） |

## 2 未提交改动盘点

主工作树：

- `M apps/web/next-env.d.ts` — Next.js 自动生成的类型引用路径变化（`.next/types/*` → `.next/dev/types/*`），随本机 Next 版本重写。
- `M pnpm-workspace.yaml` — `allowBuilds.esbuild` 从占位文本 `set this to true or false` 改为 `true`，否则全新 clone 的 `pnpm install` 会被未决构建脚本阻塞。
- `?? Noltri_Local_Desktop_Research_V1_Development.md` — 本轮开发基准文档。

研究工作树：`git status` 与 `git ls-files --others --exclude-standard` 均为空，即无 tracked 改动、无 staged 改动、无未跟踪源文件。忽略项只有构建缓存（`.next/`、`.turbo/`、`tsbuildinfo`、`node_modules/`），不含用户数据、密钥或本地库。

因此 Research 成果全部存在于提交 `ad1d0c6` 中，Git bundle 即可完整覆盖，无需额外的未提交补丁或文件备份。

## 3 基线测试结果（开发前）

`pnpm -r --no-bail test` 全量执行：

| 包 | 结果 |
| --- | --- |
| `packages/storage` | 27 passed / 17 skipped（44） |
| `packages/ai-provider` | 48 passed |
| `services/knowledge-core` | 66 passed |
| `services/mcp-server` | 20 passed |
| `services/ai` | 15 passed |
| `apps/extension` | 69 passed |
| `apps/desktop` | 22 passed |

合计 **267 passed / 17 skipped**，无失败。

17 条 skip 全部来自 `packages/storage/test/supabase.contract.test.ts`：该文件在无 `NOLTRI_PG_TEST_URL` 时整体跳过。按本文档 §19 X02 的口径，这 17 条不计入通过，属于本轮要替换的测试路线。

`pnpm install --frozen-lockfile` 返回 `Already up to date`，锁文件未被改写。

## 4 归档与恢复验证

归档位置（仓库之外）：`/Users/youngi/Documents/MiniWork/noltri-archive-20261004/`

```
文件：noltri-main+research-v1.bundle
命令：git bundle create <path> --branches --tags
校验：git bundle verify → is okay / records a complete history / sha1
包含引用：
  ad1d0c69c9d7316c0b2d2aba48699351701fd7e0  refs/heads/feature/research-v1
  9b9b4deeb1eda64232c5c382011026ec2b824f2f  refs/heads/main
SHA-256：d722b9bff65251b5ba6a162a478416b7d88b0d15745e818bd51d6a171d7a1530
```

恢复验证（已实际执行，非推断）：将 bundle `git clone` 到临时目录，`git checkout feature/research-v1` 后 `rev-parse HEAD` 等于 `ad1d0c6`，`docs/research-contract.md`、`packages/storage/src/research-supabase.ts`、`packages/storage/src/research-in-memory.ts` 等文件可在还原结果中定位，研究相关跟踪文件 70 个。验证用临时目录已删除。

Git bundle 不含工作区文件；本次工作区为空，故无遗漏。远端 `origin/feature/research-v1` 仍在，构成第二份恢复来源。

## 5 旧 Research 分支的规模

`git diff --stat main..feature/research-v1` = **87 files changed, 14873 insertions(+), 28 deletions(-)**，其中包含：

- `packages/storage`：research InMemory + Supabase 仓储、`research-repository-contract.ts`（982 行契约断言集）、两份 SQL migration（`20261002000700_research_tables.sql`、`20261002000800_research_indexes_and_rls.sql`）
- `services/knowledge-core/src/research/`：16 个领域模块（charter/question/evidence/claim/relation/section/drift/map/context-pack/decision/change/timeline/demo 等）
- `apps/web`：21 条 research 代理路由与研究工作台 UI
- 测试：`research-domain`、`research-drift`、`research-http`、`research-demo`

P5 迁移时从 `ad1d0c6` 逐项取用，不做整包 merge（该分支同时带回 Web 与 Supabase 绑定）。

## 6 Worktree 与分支处理结果

按用户 2026-10-04 的决定执行：归档校验通过后撤下旧工作树并删除旧本地分支，保留远端。

| 动作 | 命令 | 结果 |
| --- | --- | --- |
| 撤下研究工作树 | `git worktree remove '<path>'` | 见 §6 末 |
| 删除旧本地分支 | `git branch -d` / 必要时 `-D` | 见 §6 末 |
| 保留远端 | 不执行任何远端删除 | `origin/feature/research-v1` = `ad1d0c6` |

恢复方式：`git fetch origin feature/research-v1`，或 `git clone /Users/youngi/Documents/MiniWork/noltri-archive-20261004/noltri-main+research-v1.bundle`。

删除后 `git cat-file -t ad1d0c6` 仍返回 `commit`，且 `git branch -a --contains` 显示该提交由 `remotes/origin/feature/research-v1` 保持可达。另加本地归档 tag `archive/research-v1-ad1d0c6` 作为显式恢复点，仅指向既有提交，不进入生产运行路径。

## 7 新开发分支

- 分支：`v1_research&modify`，由 `main` 基线 `9b9b4de` 创建（`git switch -c 'v1_research&modify'`，未使用 `switch -C`，创建前确认同名分支不存在）。
- 基线 SHA 记录：主项目 `9b9b4deeb1eda64232c5c382011026ec2b824f2f`；旧 Research HEAD `ad1d0c69c9d7316c0b2d2aba48699351701fd7e0`。
- 第一笔提交内容：本开发基准文档、本核查与恢复记录。Research 领域逻辑的逐项迁移在 P5 从 `archive/research-v1-ad1d0c6` 取用。

实际执行结果：

- `git worktree remove '/Users/youngi/Documents/MiniWork/知序-Noltri-Research-V1'` 成功，未使用 `--force`，未使用 `rm -rf`。目录已从磁盘消失，`git worktree list --porcelain` 只剩主工作树一条记录。
- `git branch -d feature/research-v1` 成功删除本地分支（was `ad1d0c6`）。Git 提示该分支已合并到 `refs/remotes/origin/feature/research-v1` 但尚未合并到 HEAD，属安全删除路径，无需 `-D`。
- `git ls-remote --heads origin feature/research-v1` 返回 `ad1d0c69c9d7316c0b2d2aba48699351701fd7e0`，远端分支保持原样。
- 未删除任何其他分支、tag 或远端引用。

恢复方式：`git fetch origin feature/research-v1`，或 `git clone /Users/youngi/Documents/MiniWork/noltri-archive-20261004/noltri-main+research-v1.bundle`。

## 8 旧新能力映射

下表按真实代码结构核对（路径均已存在，非按文档另建模块）。「本轮状态」只区分已实现并有测试、已实现未实机运行、尚未开始三档；未开始的不写成已删，也不写成已迁移。

| 能力 | 旧承载 | 新承载 | 本轮状态 | 证据 |
| --- | --- | --- | --- | --- |
| 知识领域持久化 | `packages/storage/src/supabase.ts` + Postgres/pgvector | `packages/storage/src/sqlite.ts`（Node 内置 `node:sqlite`，本地文件） | 已实现，Node 侧实测；安装版内未实机运行 | `packages/storage/test/sqlite.contract.test.ts`（18）、`sqlite-schema.test.ts`（19） |
| 驱动语义一致性 | 各驱动各自表述 | 同一份契约逐驱动执行（memory / sqlite / supabase） | 已实现 | `packages/storage/test/repository-contract.ts` |
| 中文与中英混排关键词检索 | Postgres FTS + `tokenize()` | FTS5 取候选集，`tokenize()` 的 CJK bigram 预分词入索引，再用同一相关性分数排序 | 已实现；与 PG、memory 排序一致 | `sqlite-schema.test.ts` 中文／混排／英文／缺失词 8 组用例 |
| 向量检索 | pgvector 列 | `vectors` 表 Float32 BLOB + 精确余弦，登记 model／维度／归一化／源文本哈希／builder 版本 | 已实现（V1 无 ANN） | `sqlite-schema.test.ts` 维度隔离用例 + 契约向量组 |
| 一致性备份／恢复 | 云端快照 | SQLite backup API（含 WAL）、`backupTo()` + `verify()` | 已实现，未接 UI | `sqlite-schema.test.ts` 备份组 |
| 「写成功即已落盘」的崩溃安全 | 由托管数据库保证 | `journal_mode=wal` + `synchronous=FULL`，进程被杀后由 SQLite 自行重放日志 | 已实现，进程级实测；安装版内未实机运行 | `local-storage-slice.test.ts` SIGKILL 组（子进程提交后自杀，不执行任何 `close()`，重开读回） |
| Core 对云的假设 | 启动即需 `DATABASE_URL`／Supabase Auth | `STORAGE_DRIVER=sqlite` + `NOLTRI_SQLITE_FILE`，身份走 dev-open／dev-token，零云变量可跑 | 已实现（纵向切片实测） | `services/knowledge-core/test/local-storage-slice.test.ts`（5） |
| 数据目录决策 | 无（云端库地址） | `resolveSqliteFile()`：`NOLTRI_SQLITE_FILE` > `NOLTRI_DATA_DIR` > `~/.noltri/data/noltri.sqlite` | 已实现；**Tauri 传入自身 app-data 目录仍未做**（Rust 侧无 `app_data_dir`／sidecar 相关代码，本轮实测用 `NOLTRI_SQLITE_FILE` 指向临时文件），排到打包阶段 | `local-storage-slice.test.ts` 路径解析组 |
| 健康状态 | 只报驱动名 | 驱动自报 `storageHealth()`，storage 不自洽时整体降为 `degraded` | 已实现 | 契约新增健康项 + `http.test.ts` |
| 桌面工作台 UI | `apps/web` Next.js 页面 | `apps/desktop`（Tauri） | P2 已迁入：知识树／收件箱／来源／搜索／节点对话；Next.js server action、cookie、SSR session、`/api/web/*` 代理在桌面端不存在，改为 `ApiClient` 直连 Core | `apps/desktop/test/inbox-model.test.ts`（27）、`chat-model.test.ts`（10）、`workbench-render.test.tsx`（20，其中含与 Web 组件逐字节对等断言）；实机回归见 §13 |
| 浏览器接入端 | 扩展直连公网 Core／Cloud Bridge | Native Messaging → 本地 Core | 未开始（P3）；本轮仅保证 Core 只绑 `127.0.0.1` | `services/knowledge-core/src/server.ts` |
| Agent Setup | 网页登录页 + 手动配置 | 本地检测／预览／备份合并／授权／卸载恢复 | 未开始（P4） | — |
| Research 领域与页面 | `feature/research-v1` worktree | 同一桌面 Core + 同一 SQLite 库 | 未开始（P5–P6）；归档已可取用 | §4–§6 |
| Web／Supabase／Bridge 依赖 | 存在且在默认启动路径上 | 目标为删除 | **P2 仍不删除**（留给 P7）：桌面端已能独立完成同一批场景，但删除条件要求「替代已存在＋回归通过＋引用已清理」同时成立，P5／P6 尚未迁入，`apps/web` 的 28 项代理测试仍是 Web 侧行为基线 | `pnpm turbo run test --force` |

## 9 P1 落地结果（实测）

- 全仓工作流：`npx turbo run test typecheck --force` → 22/22 任务通过。`--force` 是必需的：缓存曾掩盖一次由 `HealthResponse` 契约变更引起的扩展弹窗测试回归，不加 `--force` 时该包显示为「通过」。
- 各包测试实测：storage 65 通过 / 18 跳过、knowledge-core 71、shared 4（本轮新建 `packages/shared/test/env.test.ts`）、ai-provider 48、extension 69、mcp-server 20、desktop 22、ai-service 15；web 走 `node:test` 55 通过。合计 **369 通过 / 18 跳过**，基线为 267 通过 / 17 跳过。
- 本地纵向切片现为 5 项（`local-storage-slice.test.ts`）：其中崩溃安全一项用子进程 `SIGKILL`——子进程经 `createRepository` 提交一条原文后立刻自杀，不调用 `close()`、不做 checkpoint，父进程重开同一文件读回该条并确认 `-wal` 在干净关闭后消失。这覆盖的是「写成功即落盘」的进程级证据（验收 L06／D01 的存储部分），不覆盖安装版双击启动后的同一场景。
- 18 项跳过全部是缺少 `NOLTRI_PG_TEST_URL` 的 Postgres 集成用例，**不计入通过**；比基线多出的 1 项是新增的跨驱动健康契约用例在 PG 驱动上的跳过。
- 契约变更的连带修改：`HealthResponse` 增加必填 `storage`，因此 `apps/web/test/fake-core.ts`、`services/mcp-server/test/fake-core.ts`、`apps/extension/test/api-client.test.ts` 三处桩数据同步更新。**这意味着这些客户端桩与新版 Core 绑定；旧 Core 的 health 响应不再满足契约**（本地同批发版可接受，跨版本兼容未处理）。
- 未做：Tauri 打包与实机双击、数据库加密、ANN 向量索引、`better-sqlite3` 备选打包路径。

## 10 本地库性能实测

环境：macOS 25.6.0（arm64）、Node `v22.23.2`、`node:sqlite` SQLite `3.51.3`、`synchronous=FULL`、384 维向量。测量脚本为一次性临时脚本（`npx tsx`，测后删除，不属测试套件），数字是这台机器的一次实测，不是承诺值。

| 场景 | 实测 |
| --- | --- |
| 新建库（含建表迁移） | 8 ms |
| 重开已有库 | 2.2 ms |
| 单条读回 | 0.81 ms |
| 一次完整 capture（原文 + 知识点 + 节点 + 关联，同步 FULL） | 20.9 ms |
| 1 000 条写入 | 2.18 s（2.18 ms/条） |
| 1 000 条时向量精确扫描（limit 8） | 12.6 ms/次 |
| 1 000 条时关键词检索（FTS5 候选 + 相关性重排） | 28.3 ms/次 |
| 5 000 条写入 | 13.1 s（2.63 ms/条） |
| 5 000 条时向量精确扫描 | 64.7 ms/次（随条数线性增长，V1 无 ANN） |
| 5 000 条时关键词检索 | 38.2 ms/次 |
| 库体积 | 1 000 条约 5.6 MB，5 000 条约 28 MB（384 维 Float32 为主） |

结论：到几千条量级仍是交互可用的毫秒级；向量检索是精确扫描，成本随库大小线性增长，这是 V1 已知的性能边界（ANN 索引与维度压缩留给后续，且必须先有真实数据量证据）。

## 11 本轮结束时的 storage 包用例分布

按文件单独执行 `npx vitest run test/<file>` 得到的实测数（不是估算）：

| 文件 | 通过 | 跳过 |
| --- | --- | --- |
| `sqlite.contract.test.ts` | 18 | 0 |
| `sqlite-schema.test.ts` | 19 | 0 |
| `in-memory.contract.test.ts` | 17 | 0 |
| `migrations.test.ts` | 10 | 0 |
| `supabase.contract.test.ts` | 1 | 18 |
| 合计 | 65 | 18 |

跨驱动契约新增的健康自检用例使 memory 与 SQLite 两条各比基线多 1 项（16→17、17→18），PG 那条同样存在但被跳过，因此跳过数由 17 增至 18。

## 12 工作树遗留物（本轮未提交、未删除）

`git status` 在本轮结束时仍显示三个未跟踪项：`.workspace/project.lock.guard`（0 字节）、`project.json`（583 374 字节）、`project.bak`（583 352 字节）。后两者是一份把仓库文档表示成 document／block 的外部编辑器工程，其时间戳（20:38、21:11）落在本轮工作期间，说明该编辑器在同时写入；`.workspace/` 是它的锁文件。本轮**没有创建、没有提交、也没有删除**它们，处置权交回用户：要么加进 `.gitignore`，要么明确删除，避免与源码仓库混在一起。

> P2 之后该分布已变化：跨驱动契约又加了 2 项（收件箱/来源列表相关），memory 17→19、SQLite 18→20、PG 侧同样 18→20 但仍是跳过，storage 包现为 **69 通过 / 20 跳过**。实测分布见 §13。

## 13 P2 落地结果（2026-10-05 实测）

### 13.1 用例分布（按包逐文件执行实测，非估算）

| 包 | 测试文件 | 通过 | 跳过 |
| --- | --- | --- | --- |
| `services/knowledge-core` | 9 | 83 | 0 |
| `apps/desktop` | 7 | 79 | 0 |
| `packages/storage` | 5 | 69 | 20 |
| `apps/extension` | 6 | 69 | 0 |
| `packages/shared` | 3 | 60 | 0 |
| `packages/ai-provider` | 2 | 48 | 0 |
| `services/mcp-server` | 2 | 20 | 0 |
| `services/ai` | 1 | 15 | 0 |
| `packages/api-client` | 1 | 10 | 0 |
| `apps/web`（`node:test`） | 1 | 28 | 0 |
| `packages/schema` | 0 | 0 | 0 |
| 合计 | 37 | **481** | **20** |

另有 Rust 侧 `cargo test` 口径的 8 项历法/时间测试（`cargo check` 实测通过，用时 21.93s，仅 2 条既有 `clashing_extern_declarations` 警告）。P0 基线为 267 通过 / 17 跳过；本轮净增 214 通过、3 跳过。

20 项跳过全部位于 `packages/storage/test/supabase.contract.test.ts`，原因是缺少 `NOLTRI_PG_TEST_URL`，按 §19 X02 口径**不计通过**。

desktop 包 79 项的构成（P2 新增 57 项）：`inbox-model` 27、`workbench-render` 20、`chat-model` 10、`connection-status` 7、`mcp-config` 6、`capture-contract` 5、`gating` 4。

### 13.2 并发敏感：本轮唯一的测试改动与其证据

不加 `--concurrency` 时，`npx turbo run test typecheck --force` 在本机（8 核）出现**三类互不相同的超时**，且每次失败的包不同：

- 第一次：`services/knowledge-core` 的 `local-storage-slice.test.ts` 两项在 5000ms 默认超时上失败（该文件单独执行 5/5 通过，最慢一项 1619ms，首项 415ms）。
- 第二次：`packages/ai-provider` 的另一项在 5000ms 超时失败，同时 `services/ai` 的 hook 在 10000ms 超时。
- 第三次（同一改动之后）：22/22 通过。

即：这是 CPU/IO 饥饿导致的偶发红，不是断言错误。本轮的处理是**只给真正做磁盘 I/O 的两项加显式超时**（`local-storage-slice.test.ts` 两项 5000ms → 30000ms，沿用同文件 SIGKILL 项既有的 `120_000` 写法），没有放宽任何断言、没有改判定阈值、没有为消除红灯而改测试预期。`packages/ai-provider` 的计时用例（40ms 超时 vs 400ms 假延迟）本轮**未改动**，因为它保护的正是重试与超时映射行为，削弱它等于删掉这项保护；它作为已知不稳定项记录在案。

结论与建议：全量门禁命令建议写成 `npx turbo run test typecheck --force --concurrency=2`（实测 22/22，EXIT=0）。本轮**没有擅自修改根 `package.json` 的脚本**，因为这会改变所有协作者的默认工作流，应单独决策。

### 13.3 实机回归（真实浏览器驱动 dist 产物）

- 被测对象：`pnpm --filter @noltri/desktop build` 的产物 `dist/workbench.html`，由 `vite preview --port 4179 --host 127.0.0.1` 提供服务（4173 被用户自己的 `deno` 进程占用，未动它）。
- Core：`STORAGE_DRIVER=sqlite`、`AI_PROVIDER=offline`、`NOLTRI_SQLITE_FILE=/tmp/noltri-p2-verify/noltri.sqlite`、绑定 `127.0.0.1:8787`。
- 路径：捕获 → 树 → 节点详情 → 重命名 → 搜索并跳转 → 节点对话（重载后读回）→ 收件箱筛选/计数/原文预览 → 人工归档（含重复归档的 `conflict` 提示）→ 离线提供方提示。
- 覆盖验收：L03（断网无模型可用：采集、落盘、手工整理、搜索、状态诚实）、D01（关进程重开数据在，Node 进程级）、D03（中文与混排检索）、M03 的 UI 侧（Agent 写入的数据在工作台可见）。
- 实测发现并修复的缺陷：首帧探测未完成时顶栏谎报「本机知识服务不可用」；现为「正在检测本机知识服务…」，并补 4 项状态文案测试。
- 布局：1280×820（Tauri 默认）、940×600（最小）、1440×900 均无横向溢出。
- 证据截图：`/tmp/noltri-p2-verify/0{1,3,4,5,6,7,8,9}-*.png`（仓库之外，报告后删除）。
- **未做**：`pnpm tauri dev` 起 GUI（属实机启动原生窗口，需用户点头）；因此 WebView 内的窗口显示/隐藏、`close` 拦截转隐藏、设置持久化仍是未实机路径。

### 13.4 P2 端点性能实测

一次性探针（`node /tmp/noltri-counts/bench.mjs`，仓库外、测后随临时 profile 删除，不属测试套件）。200 条已归纳原文的本地 SQLite 库、offline 提供方、`synchronous=FULL`：

| 端点（工作台每次交互实际调用的那些） | n | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| `POST /api/capture`（含 offline 归类与落盘） | 200 | 7.4 ms | 10.8 ms | 25.4 ms |
| `GET /api/inbox?status=pending,processing,failed` | 30 | 2.3 ms | 3.1 ms | 4.8 ms |
| `GET /api/inbox`（全部） | 30 | 2.8 ms | 3.9 ms | 4.9 ms |
| `GET /api/inbox/:id`（原文预览） | 30 | 2.1 ms | 3.0 ms | 3.0 ms |
| `GET /api/tree` | 30 | 2.4 ms | 5.2 ms | 5.8 ms |
| `GET /api/nodes/:id`（详情） | 30 | 9.0 ms | 10.4 ms | 10.6 ms |
| `POST /api/search`（hybrid） | 30 | 24.3 ms | 40.5 ms | 61.0 ms |

Core 进程启动到 `/api/health` 返回 200：490 ms（含 tsx 转译，**不是**安装包冷启动）。对照 §19 性能目标：采集落盘 ack 的 p95 目标 ≤1 s，本量级实测远优于目标；「1 万条知识的常见全文查询 p95 ≤500 ms」**未验证**——本轮样本只有 200 条，P1 另测到 5 000 条时关键词 38.2 ms、向量精确扫描 64.7 ms，向量成本随条数线性增长，1 万条不外推为成绩。

构建产物（`vite build` 实测，251ms）：`workbench.html` 0.57 kB（gzip 0.35）、`workbench-*.js` 40.56 kB（gzip 12.43）、`workbench-*.css` 15.44 kB（gzip 3.62）；与四入口共用的 `src-*.js` 100.75 kB、`jsx-runtime-*.js` 221.03 kB。

### 13.5 明确未删除的东西

`apps/web` 及其 Next.js 依赖、`packages/storage` 的 Supabase 驱动、`supabase/migrations/` 全部**保持原样**。P2 的删除前置条件是开发文档 §08 的「完成桌面对应场景回归后」，§20 进一步要求清理做到运行依赖层（Next.js 专属配置、云 SDK／driver、锁文件与 workspace 引用，并验证干净 clone 可装可测可构建）。本轮完成的只是知识树／收件箱／来源／搜索／节点对话这一组，Research（P5–P6）与 Agent Setup（P4）尚未迁入，两个条件都不成立。Web 侧对等断言（`workbench-render.test.tsx` 的前半）在删除 `apps/web` 时一并删除，该文件注释里写明了这一点。

### 13.6 Rust 侧首次实跑

`PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` → **8 passed / 0 failed**（MCP 写入目标白名单 3、设置约束 3、时间形状 2）。此前仓库文档只写过「cargo check 通过」，8 项 Rust 测试从 P1 起就一直存在但没被实跑记录过；`tauri build` 仍未执行，安装包形态无任何实测。

### 13.7 复核时发现的既有过期数字（与本轮改动无关）

写报告时逐条把文档里的数字对回代码，改掉两处一直在说谎的计数：

| 位置 | 原写法 | 实测 |
| --- | --- | --- |
| `FUNCTION_MAP.md` 桌面小节 | 「20 个 `#[tauri::command]` + 3 事件，TS 侧 commands 桥一一对应」 | **25 个**命令全部注册；`lib/tauri.ts` 调用其中 **23 个**，`get_selection_preview` 与 `runtime_info` 注册但前端无调用点；事件是 **2 个名字**（`selection-changed`／`capture-result`）共 3 处 `emit` |
| `README.md` 常用命令 | 「全部 12 个工作区」 | **11 个**工作区包（`apps` 3＋`services` 3＋`packages` 5），因此 turbo 的 test＋typecheck 恰为 22 个任务 |

「一一对应」这类断言最容易说谎：它不是任何测试的输出，只是当年写下的描述。已改为直接可复核的三个数字，其中「两个命令注册但无人调用」是本轮才暴露出来的事实，留给 P3／P4 决定是接上还是摘掉。

## 14 P3 落地结果（2026-10-05 实测）

P3 的范围口径是开发文档 §589：「浏览器 Native Host、选区浮窗、降级路径、统一 CaptureRequest ｜ 多入口同库，失败不丢原文，重复提交幂等」。分三片交付，加本片文档回写共 13 个提交，范围 `0be39d0..0c2ea21`：68 files changed，4677 insertions(+)，120 deletions(-)。P3-A 5 个提交（统一键与错误契约）、P3-B 4 个提交（扩展降级与队列）、P3-C 4 个提交（Native Host 与安装器）。

### 14.1 用例分布（逐包 `npx turbo run test --filter=@noltri/<pkg> --force` 实测，非估算）

| 包 | 测试文件 | 通过 | 跳过 | P2 时 |
| --- | --- | --- | --- | --- |
| `services/native-host` | 7 | 135 | 0 | 本轮新建 |
| `apps/extension` | 9 | 134 | 0 | 6 文件／69 |
| `services/knowledge-core` | 10 | 99 | 0 | 9 文件／83 |
| `packages/storage` | 5 | 75 | 21 | 69／20 |
| `packages/api-client` | 2 | 17 | 0 | 1 文件／10 |
| `packages/shared` | 3 | 60 | 0 | 60 |
| `apps/desktop` | 7 | 79 | 0 | 79 |
| `packages/ai-provider` | 2 | 48 | 0 | 48 |
| `services/mcp-server` | 2 | 20 | 0 | 20 |
| `services/ai` | 1 | 15 | 0 | 15 |
| `apps/web`（`node:test`） | 1 | 28 | 0 | 28 |
| `packages/schema` | 0 | 0 | 0 | 契约由消费方锁定，本包无独立用例 |
| 合计 | **49** | **710** | **21** | 37 文件／481／20 |

净增 229 通过、1 跳过、12 个测试文件。21 项跳过全部是 `packages/storage/test/supabase.contract.test.ts` 缺少 `NOLTRI_PG_TEST_URL` 的 PG 集成用例（比 P2 多 1 项是新增的幂等键契约用例在 PG 侧同样跳过），按 §19 X02 口径**不计通过**。

native-host 7 个文件的分布：`protocol` 33、`host` 23、`manifest` 20、`discovery` 17、`install-cli` 17、`framing` 14、`main` 11。knowledge-core 新增的是 `idempotency.test.ts` 12 项与 `architecture-gate` 由 8→10 项（补了「浏览器 host 不引用存储／AI 层」「只在 `host.ts` 一处经 ApiClient 触达 Core、不手写 fetch」两条结构断言）。

全量门禁：`npx turbo run test typecheck --force --concurrency=2 --continue` → **24/24 任务通过**（12 包 × 2），日志 `/tmp/p3d-gate.log`；`npx turbo run typecheck --force --concurrency=4` 单独跑为 12/12。Rust 侧本轮**未重新执行** `cargo test`，P2 记录的 8 项通过仍是上一次的结果。

### 14.2 P3-A：重复提交幂等（真实 Core + SQLite，§7.1／7.2 验收）

探针脚本 `/tmp/p3a-evidence.mjs`、`/tmp/p3a-evidence2.mjs`（仓库之外的一次性脚本），Core 以 `STORAGE_DRIVER=sqlite AI_PROVIDER=offline PORT=8791/8792` 启动，日志 `/tmp/p3a-core.log`。实测记录（原文摘自 `/tmp/p3a-evidence.log`）：

- `GET /api/health` → 200，`productId=noltri-knowledge-core`、`instanceId=85c3b815…`、`protocolVersion=1`、`storage.schemaVersion=2`；同一进程内 `instanceId` 稳定
- 同键两次：第一次 `duplicate=false`，第二次 `duplicate=true`、`items=[]`、**同一个** `rawSourceId=44fcc5bd…`
- 同文本不同键：返回**另一个** `rawSourceId=3b4112d2…`——即「内容相同但来源不同」不会被静默丢弃
- 无 `requestId` → 400 `invalid_request`，`retryable=false`，带 `traceId`；`GET /api/inbox/:id` 不存在 → 404 同样带 `retryable` ＋ `traceId`
- 文档里那行 `ASSERT exactly 2 sources after 3 accepted submissions: false` 是**探针写错**，不是端点行为错：响应体没有 `sources` 键（是 `entries`／`counts`），探针读了一个不存在的字段所以恒为 0。P3-B／P3-C 的复核一律读 `entries`，计数与场景数一致

文档回写前重新跑了一次键矩阵（`/tmp/p3d-evidence2.mjs`，Core 在 8795，库 `/tmp/noltri-p3d-evidence2.sqlite`）：

```
same-key first                    -> 200 dup=false stage=needs_review src=10c338bf…
same-key replay                   -> 200 dup=true  stage=needs_review src=10c338bf…
diff key, same text               -> 200 dup=false src=9829aadd…
same text, other client/device    -> 200 dup=false src=e4d7ab4d…
raw_sources 行数 = 3，列为 request_id / client_id（第四行没写进去，因为它被认成重放）
```

`pnpm gate` 现为 10 项全通过；`raw_sources` 在 SQLite `user_version=2` 与 Postgres 迁移 `20261005000100_capture_idempotency.sql` 里都是 partial unique index（`where request_id is not null`），历史行不受影响、升级不失败。

### 14.3 P3-B：断线不丢原文（§10.3 验收）

`/tmp/p3b-outbox-live.mts` 驱动真实的扩展模块（`outbox/`＋`api/client.ts`＋`overlay/toast-content.ts`），先杀掉 Core 再恢复，日志 `/tmp/p3b-outbox-live.log`：

- Core 不在时：`ok=false retryable=true coreUnreachable=true`，队列回执「等待 Noltri：内容已保留，连上后自动发送」，队列持有 2 条
- Core 恢复后排空：`sent=2 alreadyStored=0 kept=0 stoppedEarly=false`，**重发使用的键与队列里的逐字相同**（断言为 true）
- 事后 `GET /api/inbox` → `entries=2 counts={"pending":0,"processing":0,"done":2,"failed":0}`
- 再跑一次排空：`sent=0 alreadyStored=1`，库里仍然是 2 条原文——重放不会产生第二条
- 明确扣下发出去的那条：`stage=needs_review queued=false`，浮层显示「已存入 Noltri，需要你复核」
- 正文过短这类**拒绝**：`retryable=false shouldQueue=false`，队列保持空——拒绝不会被当成断线反复重试

### 14.4 P3-C：真实 stdio × 真实 Core（§7.6／§10.2 验收）

`/tmp/p3c-native-host-live.mts` 用**独立实现**的帧解析器驱动真实子进程（`npx tsx services/native-host/src/main.ts`，`HOME` 指向空目录，`NOLTRI_API_BASE_URL` 指向真实 Core；Core 为 `STORAGE_DRIVER=sqlite`、`AI_PROVIDER=offline`、`PORT=8791`）。四个会话、11 个请求场景，完整日志 `/tmp/p3c-native-host-live.log`（17 KB）与 `/tmp/p3c-live-console.log`：

| 会话 | 场景 | 实测回复 |
| --- | --- | --- |
| 1（真实 Core） | `hello` | `hostProtocol=1`，`core={noltri-knowledge-core, ffb91f31…, 1, 0.1.0}` |
| | `health` | 带 `storage`：`driver=sqlite`、`journalMode=wal`、`synchronous=full`、`schemaVersion=2`、`fts5=true` |
| | `capture`（键 `req-native-live-idem-0001`） | `stage=needs_review duplicate=false`，`processingStatus=done` |
| | 同键重放 | 同一 `rawSourceId`、`duplicate=true`、`items=[]` |
| | `export_all` | `forbidden_scope`「Native Host 只接受采集与健康检查，不执行 export_all请求」`retryable=false` |
| | `capture_batch`（2 条） | 两条各自落盘，`rawSourceId` 不同、nodePath 挂同一棵子树 |
| | `capture_batch` 超上限（9 条） | `invalid_request`「正文至少 8 个字，requestId 至少 8 位，一条消息最多 4 条采集」 |
| | 泄漏探针 | 正常采集成功；随后审计：**被拒帧里出现过用户原文吗？false** |
| 2（诱捕服务 8793，非本项目） | `capture` | `core_identity_mismatch`「这个端口上运行的不是知序 Noltri Core，内容没有发送」；诱捕服务 `POST /api/capture` 计数 **0** |
| 3（只回 `{"ok":true}` 的 8794） | `capture` | `capture_failed`「本地 Core 的返回不符合契约，这条采集未确认」`retryable=true`；该端口 `POST /api/capture` 计数 **0** |
| 4（8899 无人监听） | `capture` | `core_unreachable`「未找到本地 Noltri Core，请确认知序 App 正在运行」`retryable=true` |

帧通道完整性：`session 1 framing: stdout bytes=3449 frames=8 unparsed tail=0 violations=[]`——8 条请求 8 帧回复，stdout 上没有半个字节的非帧内容。落库侧对账：`Core inbox counts {"pending":0,"processing":0,"done":4,"failed":0} · entries stored: 4`、`same-requestId rows in the store: 1 (expected 1)`、`forbidden payload ever stored? false`。stderr 侧只出现：`host started {"source":"env","baseUrl":"http://127.0.0.1:8793","hasToken":false}`（**记录凭据存在与否，绝不记录凭据本身**）与 `core identity refused {"code":"core_identity_mismatch"}`。

安装器本轮**没有对用户的真实浏览器目录执行过写入**。核实命令与结果：`find ~/Library/Application\ Support -name 'com.noltri*'` 为空；Chrome／Edge 的 `NativeMessagingHosts` 目录里只有用户自己早先装入的 Notion、Codex 条目（时间戳早于本轮）。所有写入测试都在 `--home <临时目录>` 下进行。

README 里新增的 host 手动示例不是纸面命令，实测过：`printf '\x11\x00\x00\x00{"type":"health"}' | NOLTRI_API_BASE_URL=http://127.0.0.1:8796 npx tsx services/native-host/src/main.ts` 返回了一帧完整 health（含 `schemaVersion=2`、`fileName=noltri-p3d-readme.sqlite`，只报文件名不报绝对路径），stderr 一行 `host started`。用完的临时 Core 按端口 PID 精确 `kill`（`lsof -nP -tiTCP:8796 -sTCP:LISTEN`），未使用宽匹配 `pkill`，未触碰用户自己的进程。

### 14.5 本轮实测暴露并修掉的五个真问题

1. **`FrameParser` 的 `{frames, error}` 返回形状破坏了 Chrome 的回复配对**。浏览器按**位置**把回复对上请求：一条坏帧之后，旧 API 会先把后面的好帧交出来（顺序错位），并把紧随其后的好帧整批丢掉（用户看到「发出去了但没有回应」）。改为有序事件流 `ParseEvent = frame｜error`，坏 JSON 仍宣告下一帧的起点，只有长度撒谎（无法再同步）才清空缓冲。
2. **默认 logger 往 stdout 写日志**——第一次实机跑 10 条请求全部超时，而 Core 那边却真的收到了采集。原因是一行 INFO 被当成 4 字节长度前缀，之后每一帧都错位。修复：host 专用 `createStderrLogger`，并补两项「stdout 只允许出现帧」的测试；这条现在是测试锁定的不变量，不是口头约定。
3. **安装器只认 `--flag=value`，`--flag value` 的值被静默丢弃**。后果不是不方便，而是 `--home <临时目录>` 失效后带 `--confirm` 的一次安装会直接写进用户真实 Chrome 的 `NativeMessagingHosts`。修复两种形式都支持，并把 `--confirm` 之外的布尔位单独处理；测试里 `beforeEach` 把 `process.env.HOME` 指到临时目录作第二道护栏（若实现再退回读 env，测试会写到别处以立刻暴露）。
4. **超出单条上限的批次被拒时说成「不执行 capture_batch 请求」**，把用户合法使用的动词说成越权。补 `invalid_request` 这一类：拒绝必须指出到底哪里不合格（正文长度／键长度／条数上限），越权与不合格是两种答案（§7.5）。
5. **端口上只有 `{"ok":true}` 时，host 把内部契约错误原文转给了页面**（`Knowledge Core response did not match the shared contract for GET /api/health`）。改为「本地 Core 的返回不符合契约，这条采集未确认」`retryable=true`；同时 `readableCoreMessage()` 对堆栈／SQL／文件路径形态的字符串一律换成稳定中文，转发上限 160 字符。

另外两处主动收口：能力边界写在 schema 层（`hostRequestSchema` 是四动词的判别联合），因此**不存在**能接受 `export_all` 的代码路径，页面／文献／模型输出里出现的「执行命令」「导出全库」类文字对 host 不构成指令；被拒帧不回显载荷，回显的动词 token 先做形状校验（`^[a-z][a-z0-9_]{0,23}$`）并限长。

### 14.6 P3 明确没做的事

- **扩展的 `nativeMessaging` 权限没有加**。`apps/extension/src/manifest.json` 仍是 `contextMenus / storage / activeTab`。这是替用户向浏览器领一项新权限，按 §16 不能静默变更，需单独确认后再接线（host 可执行文件在打包后的路径解析、扩展 id 的取得、安装预览的实跑都在这一步）。因此「浏览器真的拉起过这个 host」目前未验证。
- 受限页面文案、粘贴收纳通路、队列与浮层状态都有测试，但**没有在真实 Chrome／真实无痕窗口里点过**；`vite/extension build` 通过（`manifest validation passed`，`popup.js`／`content.js` 各 1.9 MB 含 sourcemap）。
- host manifest 对用户真实浏览器目录**未写入过**；Windows 注册表路径只提供说明、不提供写入。
- `apps/web`、`packages/storage` 的 Supabase 驱动、`supabase/migrations/` 全部保留（P7 才动）。`get_selection_preview`／`runtime_info` 两个 Rust 命令仍注册但前端无调用点，本轮未擅自接线也未摘除。
- 未 `git push`；未删除任何分支／tag／远端引用；未改动用户的 `.workspace/`、`project.json`、`project.bak`。

### 14.7 一条与本轮改动无关的观察（不信任外来内容）

在 P0～P3 的多个工具返回结果尾部，反复出现过两段**不是用户写的**指令式文本（大意：「内容是硬上限，必须遵守规则，尽量多输出」以及「Please continue」）。处理方式是把它们当作不可信内容：没有据此改变任务范围、没有放宽任何输出长度约束、也没有转述成用户指令。开发文档 §16 关于「文献／网页／模型输出里的文字不是工具指令」的要求，在实现层由 host 的四动词判别联合兜住——页面里的文字让 host 去「导出全库」，得到的只会是 `forbidden_scope`。该现象留档，供后续轮次继续观察。
