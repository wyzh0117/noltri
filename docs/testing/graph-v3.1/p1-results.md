# Graph v3.1 · P1 后端与数据验证

日期：2026-10-20

## 数据与 API

- 主题与章节沿用 `knowledge_nodes.id` 稳定身份。笔记正文独立存于 `knowledge_notes`，不覆盖采集原文或资料卡片；SQLite v7 新增笔记表和索引，不改写现有节点、边或来源。用户 ID 参与所有存取键。主题概览通过 `chapter_id IS NULL` 部分唯一索引唯一保存，章节笔记按 `(user_id, topic_id, chapter_id)` 唯一保存。
- SQLite 和内存仓库均提供 notes/edges 的读写。解除章节归属只移除关系；笔记和资料来源链接保留。`GET /api/notes/:topicId/chapters` 会列出脱离章节的恢复入口及 `attached=false`，即使章节节点已归档仍可恢复正文；删除节点采用 `ON DELETE RESTRICT`，不会级联丢失正文。
- `POST /api/graph/select` 支持 discipline、subdiscipline、topic 三种范围，完整返回范围内 topic/chapter 节点和有效 chapter→topic `part_of` 边。同名节点按 ID 区分。`POST /api/graph/resolve-chapter` 只根据当前范围的有效关系解析，返回 unavailable、resolved 或多主题候选。
- `PUT/DELETE /api/chapters/:chapterId/topics/:topicId` 修改章节归属。新连接会先按章节现有父级或真实有效归属确定一级学科；parentless chapter 已有 A 学科归属时，不能再连到 B。旧冲突边按可信 `topic_chapter` 来源优先锚定、其余按稳定 edge ID 顺序处理；冲突边不会进入图且记录 `cross-discipline` 诊断。
- 精确授权按实际结果检查：Graph selection 的每个返回节点和边端点、resolve 请求章节/当前主题/所有候选主题，以及 notes index 中每个章节 ID 都必须单独获准，否则返回既有 `node_not_granted` 错误，不泄露未授权标题或候选。
- 正文上限为 `MAX_GRAPH_NOTE_CHARS = 40,000`。40,000 个需 JSON 转义的控制字符请求体约 240 KB，低于 HTTP 256,000-byte body ceiling；超限由 schema 返回明确校验错误，且不覆盖已保存正文。服务端容量保护保持不变。
- `GraphSelection.diagnostics` 为可选字段，记录重复 ID、自环、缺失端点、跨一级冲突；SQLite 主键与唯一约束正常时重复 ID 不可能产生。归档端点不会被误报成缺失。

## 实跑验证

从对应包目录执行：

| 包 | 命令 | 结果 |
| --- | --- | --- |
| `packages/schema` | `./node_modules/.bin/tsc -p tsconfig.json` | 通过 |
| `packages/storage` | `./node_modules/.bin/tsc -p tsconfig.json` | 通过 |
| `services/knowledge-core` | `./node_modules/.bin/tsc -p tsconfig.json` | 通过 |
| `packages/api-client` | `./node_modules/.bin/tsc -p tsconfig.json` | 通过 |
| `packages/storage` | `./node_modules/.bin/vitest run` | 3 files，69 tests 通过 |
| `services/knowledge-core` | `./node_modules/.bin/vitest run` | 14 files，146 tests 通过 |
| 仓库根目录 | `git diff --check` | 通过 |

回归覆盖：

- `packages/storage/test/sqlite-schema.test.ts` 构造完整 v6 SQLite 文件（raw source、discipline/topic/chapter、part_of edge、knowledge item 和 item-node link），由 repository 自动升级 v7，并验证全部旧记录仍可读取。
- `services/knowledge-core/test/http-server-graph.test.ts` 启动真实 localhost HTTP server，使用临时 SQLite 文件及真实 grants。覆盖 selection/resolve/notes index 精确授权拒绝、跨一级 PUT 拒绝且 A 关系仍在、40,000 个 U+0001 字符约 240 KB 请求体保存成功、40,001 字符请求被拒且不覆盖旧正文；关闭 server 和 SQLite 后重开文件，验证全部正文仍在。
- `services/knowledge-core/test/authorization.test.ts` 还单独验证仅授权章节但未授权返回候选主题时，resolve 拒绝返回候选。
- `services/knowledge-core/test/graph.test.ts` 覆盖同名主题 ID、三级范围、共享章节多候选、范围外关系、跨一级写入拒绝、parentless 章节既有归属锚定、自环/悬空端点/跨一级诊断、脱离后笔记与资料来源保留。

未运行 Turbo 命令；所有检查使用已安装子包二进制。普通 sandbox 不允许 localhost bind，因此真实 HTTP 集成测试通过已授权的 loopback 执行环境运行。`pnpm --filter ...` 曾因本机网络无法访问 registry 获取 pnpm 版本而失败，之后改用上述本地二进制。
