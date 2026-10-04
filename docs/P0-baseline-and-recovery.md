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
| 知识领域持久化 | `packages/storage/src/supabase.ts` + Postgres/pgvector | `packages/storage/src/sqlite.ts`（Node 内置 `node:sqlite`，本地文件） | 已实现，Node 侧实测；安装版内未实机运行 | `packages/storage/test/sqlite.contract.test.ts`（17）、`sqlite-schema.test.ts`（19） |
| 驱动语义一致性 | 各驱动各自表述 | 同一份契约逐驱动执行（memory / sqlite / supabase） | 已实现 | `packages/storage/test/repository-contract.ts` |
| 中文与中英混排关键词检索 | Postgres FTS + `tokenize()` | FTS5 取候选集，`tokenize()` 的 CJK bigram 预分词入索引，再用同一相关性分数排序 | 已实现；与 PG、memory 排序一致 | `sqlite-schema.test.ts` 中文／混排／英文／缺失词 8 组用例 |
| 向量检索 | pgvector 列 | `vectors` 表 Float32 BLOB + 精确余弦，登记 model／维度／归一化／源文本哈希／builder 版本 | 已实现（V1 无 ANN） | `sqlite-schema.test.ts` 维度隔离用例 + 契约向量组 |
| 一致性备份／恢复 | 云端快照 | SQLite backup API（含 WAL）、`backupTo()` + `verify()` | 已实现，未接 UI | `sqlite-schema.test.ts` 备份组 |
| Core 对云的假设 | 启动即需 `DATABASE_URL`／Supabase Auth | `STORAGE_DRIVER=sqlite` + `NOLTRI_SQLITE_FILE`，身份走 dev-open／dev-token，零云变量可跑 | 已实现（纵向切片实测） | `services/knowledge-core/test/local-storage-slice.test.ts`（4） |
| 数据目录决策 | 无（云端库地址） | `resolveSqliteFile()`：`NOLTRI_SQLITE_FILE` > `NOLTRI_DATA_DIR` > `~/.noltri/data/noltri.sqlite` | 已实现；Tauri 传入自身 app-data 目录属 P2 | `local-storage-slice.test.ts` 路径解析组 |
| 健康状态 | 只报驱动名 | 驱动自报 `storageHealth()`，storage 不自洽时整体降为 `degraded` | 已实现 | 契约新增健康项 + `http.test.ts` |
| 桌面工作台 UI | `apps/web` Next.js 页面 | `apps/desktop`（Tauri） | 未开始（P2） | — |
| 浏览器接入端 | 扩展直连公网 Core／Cloud Bridge | Native Messaging → 本地 Core | 未开始（P3）；本轮仅保证 Core 只绑 `127.0.0.1` | `services/knowledge-core/src/server.ts` |
| Agent Setup | 网页登录页 + 手动配置 | 本地检测／预览／备份合并／授权／卸载恢复 | 未开始（P4） | — |
| Research 领域与页面 | `feature/research-v1` worktree | 同一桌面 Core + 同一 SQLite 库 | 未开始（P5–P6）；归档已可取用 | §4–§6 |
| Web／Supabase／Bridge 依赖 | 存在且在默认启动路径上 | 目标为删除 | **本轮不删除**（留给 P7）：替代功能已存在，但 `apps/web` 55 项测试仍是唯一可回归的 Web 行为基线，删除条件未同时满足 | `pnpm turbo run test --force` |

## 9 P1 落地结果（实测）

- 全仓工作流：`npx turbo run test typecheck --force` → 22/22 任务通过。`--force` 是必需的：缓存曾掩盖一次由 `HealthResponse` 契约变更引起的扩展弹窗测试回归，不加 `--force` 时该包显示为「通过」。
- 各包测试实测：storage 65 通过 / 18 跳过、knowledge-core 70、shared 4（本轮新建 `packages/shared/test/env.test.ts`）、ai-provider 48、extension 69、mcp-server 20、desktop 22、ai-service 15；web 走 `node:test` 55 通过。合计 **368 通过 / 18 跳过**，基线为 267 通过 / 17 跳过。
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

