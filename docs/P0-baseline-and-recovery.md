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
