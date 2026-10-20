# Graph v3.1 · P1 独立验收

日期：2026-10-20
范围：只读审查 P1 API、Graph 关系与 SQLite 持久化变更；没有修改实现。

## 结论

P1 暂不可发布。独立复现确认了范围授权可越权读取后代节点，以及 parent_id 为空的共享章节可绕过跨一级归属校验并改变既有关联。正文请求的字符上限也高于真实 HTTP 服务的字节上限。

## 需求证据

| 检查项 | 结果 | 证据与边界 |
| --- | --- | --- |
| 一级、二级、主题三种范围 | 部分通过 | selectGraph 分别建立范围，当前图测试覆盖一级、二级和共享章节的主题局部图；跨一级归属校验存在下述绕过。 |
| 同名身份、章节正文语境隔离 | 通过存储契约 | 笔记唯一键是 (user_id, topic_id, chapter_id)；存储契约对同名主题和相同章节 ID 下的不同主题正文分别读回。 |
| 真实 part_of 与 parent 隐式关系 | 部分通过 | 查询适配会把缺少边记录的 parent_id 作为隐式边；失效自环、缺端点和跨级边会过滤并产生诊断。parent 为空时无法从有效边推导章节一级归属，见跨级复现。 |
| 解除归属保留正文和原始来源 | 通过核心测试 | services/knowledge-core/test/graph.test.ts 验证断开后正文可读、note index 标记 attached=false，章节原来源链接不变。 |
| 旧 SQLite 数据迁移 | 代码安全，实迁移覆盖不足 | v7 只新建 notes 表和索引，迁移 runner 按版本在事务中应用；现有物理 SQLite 升级测试只播种 v1 raw_sources，没有 v6 旧节点、边和来源数据的保留断言。 |
| API 输入、鉴权与范围授权 | 失败 | Graph 读取仅校验范围根 ID，随后返回全部后代；范围受限 grant 可读取未授权节点。正文字符上限与 HTTP 字节上限不一致。 |

## 阻塞发现

### P1：Graph 范围 grant 可读取未授权后代

router.ts 的 Graph 查询只对 disciplineId、可选 subdisciplineId 或 anchorTopicId 调用 requireNodeAccess，然后直接返回完整范围。resolve-chapter 也只检查范围根。授权模块说明 nodeIds 是客户端恰好可访问的节点列表，并要求超范围列表请求拒绝。

复现：为一个一级学科签发 read grant，nodeIds=[disciplineId]；请求 POST /api/graph/select 并传该一级 scope，HTTP handler 返回 200，结果包含未授权的三级主题和章节。resolve-chapter 同样可能返回未授权候选主题 ID。笔记索引只检查主题 ID，也会返回未授权章节 ID 和标题；现有授权测试还明确断言了这一行为，需同步调整测试。

位置：services/knowledge-core/src/http/router.ts:324-341；授权约定见 services/knowledge-core/src/authorization.ts 的文件说明与 requireNodeAccess。

风险：受限客户端可通过扩大 Graph 范围读取 grant 未列出的知识节点标题、摘要、章节标题及候选关系。

### P1：parent 为空的章节可跨一级重关联

connectChapter 只通过 parent_id 向上寻找一级学科。一个 parent 为空、但仍有真实 part_of 边连向一级 A 主题的章节，会得到 chapterDiscipline=null。把它连到一级 B 主题时不会拒绝；服务随后把其 parent 移到 B，原 A 归属边便被跨级诊断过滤。

复现：创建 A、B 两个一级学科及各自主题；创建 parent_id=null 章节，写入章节→A主题 part_of 边；调用 core.connectChapter(chapterId, topicBId)。调用成功，B 的 Graph 含该章节，A 的原有效关系不再显示。

位置：services/knowledge-core/src/services/graph.ts:42-50、366-386。跨级边过滤也使用同一个仅看 parent ancestry 的 disciplineFor（约第 75-85 行）。

风险：章节会错误地从 A Graph 转入 B Graph，原 A 关系随后不再展示。正文仍按主题 ID 与章节 ID 分开存储；本次复现没有把 A 正文改写到 B。

### P2：正文允许大小超过真实 HTTP 请求上限

saveGraphNoteRequestSchema 接受最多 500,000 个字符，但 Node HTTP server 在读 JSON 前限制整个请求体为 256,000 字节。超过字节限制的请求直接返回 413，因此该 API 无法通过真实 HTTP 保存其 schema 所允许的大正文；非 ASCII 内容会更早碰到字节上限。

位置：packages/schema/src/graph.ts:77-80；services/knowledge-core/src/server.ts:19、52-59。

风险：长正文保存失败；UI 应保留本地恢复草稿并展示重试状态。需要让文档/API 上限与 HTTP 限制一致，并用真实 HTTP 验证边界。

## SQLite 迁移证据

迁移 DDL v7 只新增 knowledge_notes、唯一索引与章节查找索引，主题和章节外键为 ON DELETE RESTRICT；迁移 runner 对每个版本使用事务。因此源码中未见修改既有节点、边、来源或关系的语句。

但当前升级测试 packages/storage/test/sqlite-schema.test.ts:403-459 创建的是版本 1 文件，只含播种的原文行，再从 v1 跑至最新版本。它能证明老 SQLite 文件的版本循环可升级并保留该行，不能证明完整 v6 安装数据升级后旧节点、边和来源仍可读。发布前应补一个实际 v6 文件升级到 v7 的节点、边、来源保留检查。

## 最小复现

以下命令在 services/knowledge-core 运行，仅使用 InMemoryRepository 和 HTTP handler，不写数据库或仓库文件：

~~~sh
node --import tsx --input-type=module -e '
import { makeHarness } from "./test/fakes.ts";
import { createRequestHandler } from "./src/http/router.ts";
import { createGrantResolver, InMemoryGrantStore, issueGrant } from "./src/authorization.ts";
import { resolveIdentity } from "./src/auth.ts";
const h = makeHarness();
const uid = h.actor.userId;
const node = (title, nodeType, parentId = null) => h.repository.createNode({ userId: uid, title, nodeType, parentId });
const d1 = await node("范围A", "discipline");
const s1 = await node("分支A", "subdiscipline", d1.id);
const t1 = await node("未授权主题", "topic", s1.id);
const ch1 = await node("未授权章节", "chapter", t1.id);
const d2 = await node("范围B", "discipline");
const s2 = await node("分支B", "subdiscipline", d2.id);
const t2 = await node("跨级目标", "topic", s2.id);
const detached = await node("父节点为空的共享章节", "chapter");
await h.repository.createEdge({ userId: uid, fromNodeId: detached.id, toNodeId: t1.id, relationType: "part_of", source: "topic_chapter" });
const store = new InMemoryGrantStore();
const { secret } = await issueGrant(store, { label: "仅授权范围A", scopes: ["read"], nodeIds: [d1.id] });
const handle = createRequestHandler({ core: h.core, config: h.config, grants: store, identityResolver: createGrantResolver(store, (request, config) => resolveIdentity(request, config)) });
const response = await handle(new Request("http://core.local/api/graph/select", { method: "POST", headers: { authorization: "Bearer " + secret, "content-type": "application/json" }, body: JSON.stringify({ kind: "discipline", disciplineId: d1.id }) }));
const payload = await response.json();
await h.core.connectChapter(detached.id, t2.id, h.actor);
const graphB = await h.core.selectGraph({ kind: "discipline", disciplineId: d2.id }, h.actor);
console.log(JSON.stringify({ grantStatus: response.status, grantReturnedUnauthorized: payload.nodes?.some((n) => n.id === t1.id || n.id === ch1.id), grantReturnedCount: payload.nodes?.length, crossDisciplineConnectAccepted: true, crossDisciplineChapterReturned: graphB.nodes.some((n) => n.id === detached.id), graphBDiagnostics: graphB.diagnostics ?? [] }));
'
~~~

实际输出：

~~~json
{"grantStatus":200,"grantReturnedUnauthorized":true,"grantReturnedCount":3,"crossDisciplineConnectAccepted":true,"crossDisciplineChapterReturned":true,"graphBDiagnostics":[{"entityId":"…","reason":"cross-discipline"}]}
~~~

数据库迁移和真实 HTTP+SQLite 页面流程未在本轮执行；上面的复现只用于证明两项服务逻辑缺陷。

## 修复后的独立复核（2026-10-20）

本节保留上面的缺陷发现作为历史记录，并更新当前 P1 结论。复核者未参与实现；仅检查变更并在临时 SQLite/localhost 测试环境重跑针对性验证。

| 原阻塞项 | 当前结果 | 独立复核证据 |
| --- | --- | --- |
| Graph 精确 grant 越权返回范围内未授权节点/端点/候选/章节标题 | 已修复 | `router.ts` 对 selection 实际节点与边两端、resolve 的章节/当前主题/所有候选主题、notes index 的章节逐一执行 `requireNodeAccess`。授权集成测试及真实 HTTP 集成测试通过。 |
| parentless 章节凭 null 跨一级重关联 | 已修复 | 现有有效章节关系参与归属锚定；写入前拒绝跨一级连接。测试断言 B 拒绝后 A 原边仍在。 |
| Schema 500,000 字符但 HTTP body ceiling 256,000 字节 | 已修复 | Schema 与 UI 共用 40,000 字符上限；真实 HTTP 测试以 U+0001 生成约 240 KB JSON 正常保存，40,001 字符返回 400 且旧正文不变。 |
| 迁移只验证 v1 原文行而未验证完整 v6 数据 | 已修复 | 物理 v6 SQLite fixture 升至 v7，验证原文、节点、边、知识项和 item-node link 均保留。 |

独立执行结果：

~~~text
services/knowledge-core: ./node_modules/.bin/vitest run test/http-server-graph.test.ts
1 file, 1 test passed (real localhost HTTP + temporary SQLite; escalation required for loopback)

packages/storage: ./node_modules/.bin/vitest run test/sqlite-schema.test.ts test/sqlite.contract.test.ts
2 files, 48 tests passed

services/knowledge-core: ./node_modules/.bin/vitest run test/graph.test.ts test/authorization.test.ts
2 files, 38 tests passed
~~~

截至本节日期，以上四项 P1 阻塞已由独立复核确认关闭。该结论只覆盖 P1 API/关系/持久化；完整页面导航、图交互、保存失败恢复和 A01–A16 的产品验收以单独的最终验收矩阵为准。
