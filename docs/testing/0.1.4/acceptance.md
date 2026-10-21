# v0.1.4 旧分类兼容验收

状态：通过（knowledge-core 自动化兼容验收）。此记录只覆盖分类树与 Graph 兼容修复；正式桌面包升级和真实浏览器采集需由发布验收另行记录，本文不将其记为已通过。

## 缺陷与改动

旧手动分类可保存为 `domain → domain → topic`。树接口原样返回 `domain`，桌面端因此无法把根节点作为 Graph 学科；Graph 服务也只接受 `discipline`，点击旧根节点会返回“学科不存在”。

新增轻量 taxonomy helper：仅在树展示和 Graph 学科/二级学科校验时，把根 `domain` 投影为 `discipline`，把其直接子 `domain` 投影为 `subdiscipline`，其余层级继续显示为 `domain`。AI 分类与手动路径写入共用同一个路径层级规则，新路径写入 `discipline / subdiscipline / domain… / topic`；按相同标题和父 ID 命中的既有节点继续复用。没有迁移或改写旧节点、ID、parent、边、授权、来源、知识条目、关联或正文，也没有新增依赖。

## 独立验证

验收对象是基于 `v0.1.3`（HEAD `28c800336317651b3d1c9176810b0109b0f4f91b`）的冻结工作树 diff，验收范围文件 diff SHA-256：`8e4a7fa428760709e66193de3a0bf9125829d7cc9ae077f741b7d6a87e5f2205`。记录创建时尚未提交或推送。

| 检查 | 结果 |
| --- | --- |
| `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm --filter @noltri/knowledge-core test` | 14 个测试文件、148 项通过 |
| `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm --filter @noltri/knowledge-core typecheck` | 通过 |
| `git diff --check` | 通过 |

新增 HTTP/SQLite 回归使用临时目录和真实本地 HTTP server、SQLite repository、capture→classification→persistence 流程。为确保旧路径可确定复现，分类结果由测试 provider 固定返回；这验证应用分类管线，不验证外部模型分类质量或付费 API。测试覆盖：

- 从 SQLite 中已有的 `数学(domain) → 概率论(domain) → 概率基础(topic)` 执行 HTTP capture；结果复用原 topic ID，且没有为相同路径另建节点。
- `/api/tree` 以相同 ID 返回 `discipline / subdiscipline` 投影；一级和二级 `/api/graph/select` 均返回相应主题。root-only grant 因缺少返回节点的精确授权而被拒绝；授权节点集足够的 grant 成功。
- 共享章节在学科和二级学科范围内解析出两个候选主题；Graph 标记跨一级学科的无效关系，跨学科连接请求被拒绝且旧边不变。
- 四层 AI 新路径写入 `discipline / subdiscipline / domain / topic`；三层手工修改路径在复用旧 `数学(domain)` 根后写入二级学科与主题。另有分类测试覆盖单段 root topic 和两段手工路径。
- SQLite 关闭并重开后，旧节点仍保留原始 `domain` type 与原 ID；既有 source、knowledge item、item link、章节 note、edges 和 exact grant 仍可读取。

## 验收边界

本轮没有启动或修改已安装的正式应用，也没有操作用户资料库或浏览器；本验收用临时 SQLite 数据库，测试退出后清理。正式应用升级已在发布总记录中另行验收通过；真实浏览器 50 条、15 个主题采集仍待完成，并应在完成前保持待验收状态。
