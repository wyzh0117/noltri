# Research 实现契约（本分支 · P5 起）

> 面向实现的共享契约。**上位规格是 `Noltri_Local_Desktop_Research_V1_Development.md`**（下称开发文档），
> 两者冲突以开发文档为准。
>
> 本文取代归档 `ad1d0c6` 里的 `docs/research-contract.md`。归档那一份写于「云端 Web + 多 Agent 并行」时期，
> 它的上位文档（旧 Research V1 开发文档，§33 等编号）不在本分支，多 Agent 文件归属表也不再适用；
> 这里保留其中的规则口径（§1–§5、§7 的 P6 规则），把上下文换成本分支的真实结构。

## 0 铁律（与知识域一致）

1. **身份只来自凭证**：任何 create 请求体不含 `userId` / `projectId`。`projectId` 来自 URL 路径，
   `userId` 来自 identity（本机凭证 / dev-token / dev-open / grant），并校验该项目属于该用户，
   否则一律 `not_found`（不泄露存在性）。
2. **错误信封**复用 `apiErrorCodes`；文案中英双语，向所在包既有文件看齐。
3. **Decision / Change 是 append-only 历史对象**：没有 update / delete；变更用新增 Change 表达（开发文档 §13）。
4. **领域逻辑是纯的**：`services/knowledge-core/src/research/**` 不 import UI 代码，core `src/` 里不出现
   `pg|@supabase/|openai|express` 等依赖 —— 由 `test/architecture-gate.test.ts` 机器检查。
5. **Research 只新增、不改旧**：知识域 9 张表行为不变；research 表随阶段叠加 —— V3 的 11 张是 P5-A 的领域对象，
   V4 的 `research_charter_versions` / `research_review_marks` 是 P5-C 的批准基线与复核标记。
   没有哪一版改掉了前向版本的列。

## 1 REST 契约（Knowledge Core，`/api/research/*`）

路由在 `src/http/router.ts` 的 `ROUTES` 表里，派发统一走 `src/http/research.ts` 的 `handleResearch`
（先例是 `src/http/admin.ts`：路由形状由 router 判定，业务分支由 handler 模块判定）。
每条 research 路由最多含一个 `:` 段，这就是 router 能只递一个已解码 `id` 的原因。
`GET /api/research/references` 是唯一一条**不以 `projectId` 为键**的路由：一个出处可能被多个研究项目引用，
所以它按出处查、按项目回报。
响应体形状以 `packages/schema/src/research-api.ts` 的 zod schema 为准。

| Method | Path | Body / Query | Response |
| --- | --- | --- | --- |
| POST | `/api/research/projects` | `CreateResearchProjectRequest` | `ResearchProject` |
| GET | `/api/research/projects` | — | `{projects}` |
| GET | `/api/research/projects/:projectId` | — | `ResearchProject` |
| PATCH | `/api/research/projects/:projectId` | `PatchResearchProjectRequest` | `ResearchProject` |
| GET | `/api/research/projects/:projectId/charter` | — | `{charter\|null}` |
| PUT | `/api/research/projects/:projectId/charter` | `CharterRequest` | `ResearchCharter` |
| POST | `/api/research/projects/:projectId/charter/approve` | `ApproveCharterRequest` | `CharterVersion` |
| GET | `/api/research/projects/:projectId/charter/versions` | — | `{versions}` |
| GET | `/api/research/projects/:projectId/charter/baseline` | — | `{baseline\|null}` |
| GET | `/api/research/projects/:projectId/review-marks` | `?status=&entityType=&entityId=` | `{marks}` |
| POST | `/api/research/review-marks/:markId/clear` | — | `ResearchReviewMark` |
| GET | `/api/research/references` | `?nodeId=&rawSourceId=`（至少给一个） | `{references}` |
| POST | `/api/research/projects/:projectId/questions` | `CreateResearchQuestionRequest` | `ResearchQuestion` |
| GET | `/api/research/projects/:projectId/questions` | — | `{questions}` |
| PATCH | `/api/research/questions/:questionId` | `PatchResearchQuestionRequest` | `ResearchQuestion` |
| POST | `/api/research/projects/:projectId/evidence` | `CreateEvidenceRequest` | `Evidence` |
| GET | `/api/research/projects/:projectId/evidence` | `?type=` | `{evidence}` |
| PATCH | `/api/research/evidence/:evidenceId` | `PatchEvidenceRequest` | `Evidence` |
| POST | `/api/research/projects/:projectId/claims` | `CreateClaimRequest` | `Claim` |
| GET | `/api/research/projects/:projectId/claims` | `?status=&claimType=` | `{claims}` |
| PATCH | `/api/research/claims/:claimId` | `PatchClaimRequest` | `Claim` |
| POST | `/api/research/projects/:projectId/sections` | `CreateSectionRequest` | `ManuscriptSection` |
| GET | `/api/research/projects/:projectId/sections` | — | `{sections}` |
| PATCH | `/api/research/sections/:sectionId` | `PatchSectionRequest` | `ManuscriptSection` |
| POST | `/api/research/projects/:projectId/relations` | `CreateEntityRelationRequest` | `EntityRelation` |
| GET | `/api/research/projects/:projectId/relations` | `?sourceType=&sourceId=&targetType=&targetId=&relationType=` | `{relations}` |
| DELETE | `/api/research/relations/:relationId` | — | `{deleted,id}` |
| POST | `/api/research/projects/:projectId/decisions` | `CreateResearchDecisionRequest` | `ResearchDecision` |
| GET | `/api/research/projects/:projectId/decisions` | — | `{decisions}` |
| POST | `/api/research/projects/:projectId/changes` | `CreateResearchChangeRequest` | `ResearchChange` |
| GET | `/api/research/projects/:projectId/changes` | `?changeType=` | `{changes}` |
| GET | `/api/research/projects/:projectId/timeline` | — | `{events}` |
| POST | `/api/research/projects/:projectId/timeline` | `CreateTimelineEventRequest` | `TimelineEvent` |

**P6 才开的 5 条**（schema 已在 `research-api.ts` 落地，domain / HTTP 未接）：
`POST …/drift-check`、`GET …/drift-findings`、`PATCH /api/research/drift-findings/:findingId`、
`GET …/map`、`GET …/context-pack`。开发文档 §18 把「六类检测、人工处理、决策版本、研究地图和上下文包」
明确排在 P6；本轮不因为 `drift_findings` 表已经能存就顺手把产生它的规则也发出去。

`packages/api-client/src/client.ts` **还没有** research 方法与路由常量（`apiRoutes` 只覆盖知识与
`api/admin/grants`）。桌面工作台必须经 `ApiClient` 调 Core，所以 P5-D 的第一步是补这两样，
而不是在 UI 里手写 `fetch`。本分支没有 `/api/web/research/*` 云代理；`apps/web` 存活到 P7。

## 2 服务层行为约定

- 创建 Decision / Change 时**同批写入** `research_timeline_events`（`eventType` = `decision` / `change`，
  `sourceType` + `sourceId` 指回来源对象，`occurredAt` = 该对象 `createdAt`）。
- POST timeline 只用于 `milestone`（`sourceType='manual'`、`sourceId=null`）；`occurredAt` 解析不了就 `invalid_request`。
- Timeline 按 `occurredAt` 倒序（新的在前）。
- 创建 relation 时先查**配对表** `RELATION_PAIRINGS`（`packages/schema/src/research.ts`）：`supports` 一类
  五种只能 `evidence → claim`，`answers` 只能 `claim → research_question`，`appears_in` 只能
  `claim → manuscript_section`，`changes|affects` 只能由 decision/change 出发指向任意实体，`relates_to` 任意。
  方向是含义的一部分：反过来的 `supports` 不是「弱一点的论断」，而是写错了的边（R02）。
  再校验 `sourceId` / `targetId` 在**本项目内**存在，否则 `invalid_request`；
  `(sourceType, sourceId, relationType, targetType, targetId)` 五元组重复创建返回既有记录（幂等，不报错）。
- 所有 list 只返回本项目 + 本用户数据；不属于该用户的 `projectId` 一律 `not_found`。
- **批准章程（R06）**：`approveCharter` 只读当前 `research_charters` 行作为草稿快照，不改它 —— 批准之后仍可继续编辑。
  版本号为 `上一版 + 1`（首版 = 1，`previousVersion` 为 `null`），`changedFields` 是草稿与上一版快照的**字段名差集**
  （字段集合是 `charterFieldsSchema` 的键、并且**冻结**，所以新增字段不会漏进差集，也没有调用方能改写这份账本
  —— `packages/schema/test/research-baseline.test.ts` 钉住这两点）；驱动层不参与比对，版本语义只在 domain。
  `revisionReason` 必填（1..2000）；`decisionId` 与 `affectedEntities` 里每个引用都必须**先证明属于本项目**才允许落库，
  任一不成立即 `invalid_request` 且两张表都不写（`ResearchRepository` 没有事务，所以顺序是「先证明、后写」）。
  基线读取 `findCharterBaseline` 与其他 `find*` 一样不加属主守卫，返回 `null` 而不是泄露存在性；列表 `listCharterVersions` 走 `requireProject`。
- **复核标记（R03/R06）**：批准时按 `affectedEntities`（按 `type:id` 去重）为每个对象 raise 一条
  `raisedBy='charter_baseline'`、`charterVersion=` 新版本号的标记；点名为空就一条也不加。
  `(user, project, entityType, entityId, raisedBy, charterVersion)` 唯一：同一对象同一基线重复批准**原地刷新**
  `reason` 并把 `status` 复位为 `pending`，不新增行。`clearReviewMark` 只把 `status` 改成 `cleared`，**不删行** ——
  这行本身就是「什么时候处理过」的记录（开发文档 §14）。`source_archived` 那一类由 P5-C3 从知识域侧写入。
- **出处指针与手动定位（R03）**：`Evidence` 在 `sourceReference` / `sourceLocation`（人读的定位，永远是用户自己写的
  文本，系统不改写）之外带三个机器读的字段：`rawSourceId`、`nodeId`、`locationOrigin`（`manual|captured`）。
  存储层是**可空列且不建外键** —— 本产品不做删除，`on delete restrict` 会承诺一个根本不存在的动作，cascade
  则会抹掉 R03 正要保护的证据。`listEvidenceBySource(userId, filter)` 跨项目按出处查引用；`filter` 两个键都不给
  就返回 `[]` 而不是「全部」：一次查询悄悄变成全表扫描，正是「漏传的 `nodeId` 把没被引用的证据也标上记」的起点。
- **只读的归档前检查**：`GET /api/research/references`（domain `findReferences`）要求 `nodeId` / `rawSourceId`
  至少给一个，否则 `invalid_request`；每条命中回报所属项目（`projectId` + `projectName`）、证据与它经由**五种证据关系**
  连着的 `claimIds`（`relates_to` 不属于那五种，因此不算影响）。**它不写任何标记** —— 决定权在调用方。
- **归档知识节点（R03）**：`src/services/node.ts` 的 `patchNode` 在 `status` 变为 `archived` 时**先**调
  `deps.research.markSourceArchived(...)` 再写节点 —— 顺序反过来就会出现「节点已归档、引用却没被标记」的半态，
  而 `raiseReviewMark` 幂等，重试只会刷新同一条记录。被引用的证据与它们支撑的论点各得一条
  `raisedBy='source_archived'` 标记（同一论点被两条证据引用只留一条）。**ID 永不重绑**：指针继续指着那个已归档对象，
  只是加上「需要重新确认」。恢复节点**不清标记**（出处回来了 ≠ 这条引用已被核验过），只有 `clearReviewMark` 改状态；
  宿主没接 research（`deps.research === undefined`）就整步跳过，归档照旧成功。
- 时间统一 ISO-8601 UTC 字符串（`@noltri/shared` 的 `nowIso`）；ID 用同包的 `createId`。

## 3 存储与装配

`createResearchRepository(options)`（`packages/storage/src`）与知识域共用同一个 `RepositoryOptions`，
桌面 profile 把同一个 `sqliteFile` 交给两个工厂：两个 `node:sqlite` 句柄打开一个 WAL 文件，
靠 WAL 让第二个句柄在第一个写的时候仍可读。这是设计，不是意外，所以 **`close()` 必须关两次**；
Core 自己只监听 `127.0.0.1`，这两个句柄都不对外。

- research 只有 `memory` 与 `sqlite` 两个驱动；`supabase` 会抛错（归档的 `research-supabase.ts` 与它的
  两个 migration 留在 `ad1d0c6`，没有带进本地桌面构建）。
- **选驱动的只有一处**：`packages/storage`。架构门禁禁止 core `src/` 出现
  `driver === 'memory' | 'supabase'` 这类字面量比较。宿主问的是
  `supportsResearchDriver(driver)`，而不是自己比对驱动名 —— 这样「哪些驱动支持 research」只写在实现它们的那个文件里。
- `buildHandler` 在驱动不支持时把 `research` 置为 `null` 并记 `'not wired'`，而不是让 bundle 构造失败
  （`apps/web` 的 supabase 装配在 P7 之前仍然要能起来）。
- `KnowledgeCoreOptions.research` 是**可选**的：只嵌知识域的宿主（MCP bundle、测试 harness）
  不必为了构造 Core 而开第二个它永远用不到的数据库句柄。请求打到未装配的 Core 时返回
  `internal_error` + `reason: 'research_not_wired'`。
- 同一个可选对象也挂在 `CoreDeps.research` 上，但只有**一处**用它：`patchNode` 归档节点时标记引用（R03）。
  HTTP 侧仍然只经 `core.research`（`router.ts` 把它交给 `handleResearch`），知识域其余服务看不见 research。

## 4 授权边界（默认关闭，直到片段被限制）

这些路径**故意没有** `SCOPE_BY_ACTION` 条目。带「本地客户端授权」grant 的请求在
`requireScope` 就被拒成 `route_not_granted`，根本进不到 `research.ts`。原因：开发文档 §11
（第 435 行「限制返回片段」）靠 `capText(actor, text)` 兑现，而 research 的文本（章程、证据描述、论点正文）
还没有接入这条路径；即使 grant 要求限制片段，这里也兑现不了。打开 Research 给 Agent 客户端必须是**和 capping 一起决定**，
不能先开后补。桌面工作台走 dev-token / dev-open（`identity.grant === undefined`），
`requireScope` 是 no-op，33 条端点全部可达。P5-C 新增的 6 条（批准 / 版本列表 / 基线读取 / 标记列表 / 标记清空 /
引用检查）**同样没有** scope 条目：`CharterVersion.charter` 是整份章程文本，`reviewMark.reason` 里带着批准理由，
`references` 里带着证据标题与它所属项目的名字 —— 兑现不了片段限制就一律不开。

这条边界要有测试撑着：架构门禁从 `ROUTES` 里收集出全部 `api/research/*` 形状，既钉住条数（现为 33，
新增路由不登记就会失败），也钉住「这些形状没有一个能在 `SCOPE_BY_ACTION` 里查到条目」。

## 5 Research Map / 上下文包 / 六类偏移的口径（P6 落地，规则在此存档）

从归档契约继承，避免 P6 重新发明或漏掉细节。

**Map**（`GET …/map`）：聚合层图 `questions → evidence → claims → sections → contribution`
（contribution 取 `charter.coreContribution`）。`edges` 只含
`supports | partially_supports | contradicts | qualifies | contextualizes | answers | appears_in`；
`unsupportedClaimIds` = 没有任何 `supports|partially_supports` 的 claim，`claims[].supported` 同口径。
服务端不做布局，排版归 UI（开发文档 §12 要求图与可访问列表给出等价信息）。

**Drift-check**（`POST …/drift-check`）：确定性规则，V1 不调模型（诚实记录在 FUNCTION_MAP）。每次运行先生成草稿，
再按 `(driftType, sourceEntityId, targetEntityId)` 去重（已有 `status='open'` 的直接并入返回，不重复创建），
最后返回全部 findings + `summary{total,info,warning,critical}`（针对本次返回的 findings）。
severity 未注明处为 `warning`：

- **evidence_drift**：claim 无 `supports|partially_supports` → source=claim；`status==='confirmed'` 时 `critical`。
- **causality_drift**：claim 文本命中强因果词
  （`cause|causes|caused|lead(s)? to|result(s)? in|impact|impacts|determine(s)?|drive(s)?|导致|影响|决定|造成`，
  不区分大小写），且其支持证据全部/主要为非统计类型
  （`expert_judgement|note|interview|document|external_source|other`）或没有支持证据；`boundary` 为空 → `critical`；
  boundary 含弱化词（`suggest|indicate|association|associat|correlat|not causal|may|might|可能|相关|关联|非因果|不构成因果`）→ 降为 `info`。
- **rq_drift**：仅当请求带 `manuscriptText`。扫描正文疑问句（`?`/`？` 结尾）、`RQ\d+` 代号、
  `whether|how|what|why|to what extent` 开头句、含 `研究问题|我们是否` 的句子，
  与 `charter.researchQuestionsText` 及已登记 question 的 code/text 做归一化包含匹配，未匹配项生成 finding（source=charter，
  `description` 引用原句）。无 `manuscriptText` 时跳过，不产生 finding。
- **contribution_drift**：`claimType==='contribution'` 的 claim 文本与 `charter.coreContribution`
  停用词过滤后 token 重合率 < 0.2 → source=claim，target=charter；`coreContribution` 为空 → 直接 `critical`。
  `manuscriptText` 里出现贡献表述（`contribut|贡献` 所在句）而重合率 < 0.2 也生成一条。
- **method_drift**：存在 `changeType==='method'` 的 Change 且 `createdAt > charter.updatedAt` → source=该 change，target=charter。
- **journal_drift**：存在 `changeType==='journal'` 的 Change 且 `createdAt > charter.updatedAt`；
  或 `charter.targetJournal` 非空且存在 `changeType` 为 `contribution|scope` 且晚于章程的 Change。

**Context Pack**（`GET …/context-pack`）：返回 `{markdown, blocks, generatedAt}`，`blocks` 顺序即区块顺序，
`markdown` 是同内容拼接：
PROJECT（项目名 + currentStage）→ Current Research Question（code+text+status）→ Core Contribution →
Research Boundary → Claim Boundary → Current Method（researchMethod + relatedMethod）→
Confirmed Claims → Key Evidence（支撑 confirmed claim 的证据 title+type）→
Important Decisions（最近 5 条）→ Recent Changes（最近 5 条）→ Open Issues（open 的 RQ + open findings 数量）→
Current Drift Warnings（open findings，含 severity+description）。
上下文包默认按需最小化，不一次输出全库（开发文档 §13）。

## 6 文件归属（本分支单线推进，按阶段划界）

```
packages/schema/src/research.ts|research-api.ts        P5-A 已落地（P5-C 追加基线/标记与出处引用 schema，含 P6 的 drift/map/context）
packages/storage/src/sqlite-schema.ts                  P5-A（P5-C 追加 V4 两张基线/标记表、V5 的三个出处列）
packages/storage/src/research-types.ts                 P5-A（P5-C 追加 8 个方法 + ReviewMarkListOptions/EvidenceSourceFilter）
packages/storage/src/research-in-memory.ts             P5-A（同上，P5-C 两个驱动都实现）
packages/storage/src/sqlite-research.ts                P5-A
packages/storage/test/research-repository-contract.ts  两驱动共用契约测试（新增方法必须两侧同语义）
packages/api-client/src/client.ts                      P5-D（research 路由常量 + 类型化方法）
services/knowledge-core/src/research/**                P5-B（34 方法 façade；baselines.ts / references.ts 是 P5-C）
services/knowledge-core/src/research/support.ts        P5-B（P5-C 把端点归属判断 `entityIsInProject` 提到这里）
services/knowledge-core/src/services/node.ts           知识域唯一伸进 research 的一处：归档时标记引用（R03）
services/knowledge-core/src/http/research.ts|router.ts  P5-B（P5-C 追加 6 条，P6 再追加 5 条）
services/knowledge-core/test/research*.ts              P5-B（`research-archive.test.ts` 是 R03 的跨域面）
apps/desktop/**                                        P5-D（研究工作台面板，prop 驱动、纯展示可测）
docs/research-contract.md                              本文件
```

- `demo.ts` 的 fixture 是**测试造数**，界面上要标明是测试项目；展示用的论文与引文不得虚构为真实科研材料（开发文档 §19）。
  它刻意留的三个缺口就是 P6 的输入：C-03 无任何支持证据、C-05 用因果强表述且无 boundary、
  一条 `journal` change 落在章程之后。
- 每完成一个模块跑所在包的 `typecheck` + `test`，绿了再继续；提交按路径窄范围分批，不用 `git add .`，
  push 单独确认。

## 7 与验收矩阵的对应（开发文档 §19）

| ID | 本轮口径 | 状态 |
| --- | --- | --- |
| R01 | 研究项目全流程 Charter→RQ→Evidence→Claim→Section 可建可读可修订 | ✅ P5-B（27 端点 + domain 测试；P5-C 后端点为 33 条） |
| R02 | 五种证据关系可表示，反证与限定不被当作支持 | ✅ P5-C1：`RELATION_PAIRINGS` 钉住方向，domain 与 schema 两侧有测试 |
| R03 | 来源删除／修改／合并安全，原始版本与复核提示可追溯 | ✅ P5-C2＋P5-C3：出处指针可空不重绑、`GET /api/research/references` 只读检查、归档时对证据与其论点打 `source_archived` 标记、恢复不误清、未接 research 不阻断归档。V1 只有「归档」，没有删除／合并，所以那两条路径尚无代码可挂（`rawSourceId` 已预留，删除落地时同一套标记即可复用） |
| R06 | 批准章程修订：历史保留、影响对象被标记、后续检查绑定新基线 | ✅ P5-C2（append-only 版本 + 快照不可变 + 按名标记）；「后续检查绑定新基线」等 P6 的 drift-check 读 `findCharterBaseline` |
| R08 | 重启／导出恢复后关系完整 | P5-E（sqlite 往返） |
| R04 / R05 / R07 | 六类偏移 fixture、无 AI 诚实、上下文包给 Agent | P6 |
