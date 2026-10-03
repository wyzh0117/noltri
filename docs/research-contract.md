# Research V1 实现契约（Implementation Contract）

> 面向实现 Agent 的共享契约。上位规格是《Noltri Research V1 开发文档》；两者冲突时以开发文档为准。
> 契约基座已落地：`packages/schema/src/research.ts`（实体/枚举/输入）、`research-api.ts`（REST 请求/响应）、
> `packages/storage/src/research-types.ts`（`ResearchRepository` 接口）、`packages/api-client/src/client.ts`
> （`researchApiRoutes` + `ApiClient` research 方法，四入口共用，不得绕过）。

## 0. 铁律（与知识域一致）

1. **身份只来自凭证**：任何 create 接口的请求体不含 `userId` / `projectId`；`projectId` 来自 URL 路径，
   `userId` 来自 identity（JWT / dev-token / dev-open），并校验该项目属于该用户，否则 `not_found`。
2. **错误信封**复用 `apiErrorCodes`（`invalid_request | unauthorized | not_found | conflict | provider_error |
   storage_error | rate_limited | internal_error`）。
3. **Decision / Change 是 append-only 历史对象**：不提供 update/delete；变更用新增 Change 表达。
4. **Drift Checker 与 Context Pack 是纯领域逻辑**（`services/knowledge-core/src/research/`），不 import 任何 UI 代码；
   核心不得出现 pg/supabase/openai/express 等依赖（`pnpm gate` 机器检查，勿破坏）。
5. **Research 只新增、不改旧**：不修改知识域 9 张表行为；旧 Coding/Knowledge 项目行为保持不变。

## 1. REST 契约（Knowledge Core，`/api/research/*`）

路由全部走 `services/knowledge-core/src/http/router.ts` 的 `handle`（web/Next 与 node:http 共用）。
响应体形状以 `research-api.ts` 的 zod schema 为准；下表是语义索引：

| Method | Path | Body / Query | Response |
| --- | --- | --- | --- |
| POST | `/api/research/projects` | `CreateResearchProjectRequest` | `ResearchProject` |
| GET | `/api/research/projects` | — | `{projects}` |
| GET | `/api/research/projects/:projectId` | — | `ResearchProject` |
| PATCH | `/api/research/projects/:projectId` | `PatchResearchProjectRequest` | `ResearchProject` |
| GET | `/api/research/projects/:projectId/charter` | — | `{charter\|null}` |
| PUT | `/api/research/projects/:projectId/charter` | `CharterRequest` | `ResearchCharter` |
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
| POST | `/api/research/projects/:projectId/drift-check` | `DriftCheckRequest` | `DriftCheckResponse` |
| GET | `/api/research/projects/:projectId/drift-findings` | `?status=&driftType=&severity=` | `{findings}` |
| PATCH | `/api/research/drift-findings/:findingId` | `PatchDriftFindingRequest` | `DriftFinding` |
| GET | `/api/research/projects/:projectId/map` | — | `ResearchMapResponse` |
| GET | `/api/research/projects/:projectId/context-pack` | — | `ResearchContextPackResponse` |

`ApiClient` 已提供一一对应的类型化方法（`createResearchProject` / `researchMap` / `runResearchDriftCheck` …），
Web 代理 `/api/web/research/*` 必须经 `ApiClient` 调 core（`apps/web/lib/core.ts` 的 `proxyCore`）。

## 2. 服务层行为约定（domain services）

- 创建 Decision / Change 时**同时写入** `timeline_events`（`eventType` = `decision` / `change`，
  `sourceType` + `sourceId` 指回来源对象，`occurredAt` = 该对象 `createdAt`）。
- POST timeline 仅用于 `milestone` 事件（`sourceType='manual'`）。
- Timeline 按 `occurredAt` 倒序返回（新的在前）。
- 创建 relation 时校验 `sourceId` / `targetId` 在本项目内存在（对应实体类型），否则 `invalid_request`；
  同 (sourceType,sourceId,relationType,targetType,targetId) 重复创建返回既有记录（幂等，不报错）。
- 所有 list 默认仅返回本项目 + 本用户数据；对不属于该用户的 `projectId` 一律 `not_found`（不泄露存在性）。

## 3. Research Map（GET map）

聚合层式图：`questions` → `evidence` → `claims` → `sections` → contribution（在 `charter.coreContribution`）。
`edges` 只含 `supports | partially_supports | contradicts | qualifies | contextualizes | answers | appears_in`
（E→C、C→RQ、C→Section）；`unsupportedClaimIds` = 无任何 supports/partially_supports 的 claim。
`claims[].supported` 同口径。UI 负责排版，服务端不做布局。

## 4. Drift Checker（POST drift-check）

确定性规则（V1 不调用模型；诚实记录在 FUNCTION_MAP）。每次运行：
1. 按下述规则生成 finding 草稿；
2. **去重**：同 `(driftType, sourceEntityId, targetEntityId)` 已存在 `status='open'` 的 finding 时不重复创建，
   直接并入返回列表；
3. 全部返回（含既有 open findings），并给出 `summary{total,info,warning,critical}`（针对本次返回的 findings）。

规则（severity 未注明处为 `warning`）：

- **evidence_drift**：claim 无 `supports|partially_supports` 关系 → source=claim；
  `claim.status==='confirmed'` 时 severity=`critical`，否则 `warning`。
  建议动作：补充 Evidence、弱化 Claim 或改为 Future Research。
- **causality_drift**：claim 文本命中强因果词
  （`cause|causes|caused|lead(s)? to|result(s)? in|impact|impacts|determine(s)?|drive(s)?|导致|影响|决定|造成`，不区分大小写）
  且其支持证据（supports/partially_supports）全部或主要为非统计类型
  （`expert_judgement|note|interview|document|external_source|other`）或 claim 无支持证据；
  若 `claim.boundary` 为空 → `critical`；若 boundary 含弱化词
  （`suggest|indicate|association|associat|correlat|not causal|may|might|可能|相关|关联|非因果|不构成因果`）→ 降为 `info`。
  建议动作：弱化为相关性表述或在 boundary 中限定推断程度（对照 Claim Boundary）。
- **rq_drift**（仅当请求带 `manuscriptText`）：扫描正文中研究问题信号
  （以 `?`/`？` 结尾的疑问句；`RQ\d+` 代号；`whether|how|what|why|to what extent` 开头的句子；
  含 `研究问题|我们是否` 的句子），与 charter.`researchQuestionsText` 及已登记 question 的
  code/text 做归一化包含匹配；未匹配项生成 finding（source=charter，`description` 引用原句）。
  无 manuscriptText 时跳过本规则（不产生 finding）。
- **contribution_drift**：`claimType==='contribution'` 的 claim 文本与 charter.`coreContribution`
  做停用词过滤后的 token 重合率 < 0.2 → source=claim，target=charter；`coreContribution` 为空 → 直接 `critical`。
  另若 manuscriptText 出现贡献表述（`contribut|贡献` 所在句）与 coreContribution token 重合率 < 0.2 也生成一条。
- **method_drift**：存在 `changeType==='method'` 的 ResearchChange 且 `createdAt > charter.updatedAt`
  （方法已变而 Charter 的 Research Method / RQ / Boundary 未同步）→ source=该 change，target=charter。
- **journal_drift**：存在 `changeType==='journal'` 的 ResearchChange 且 `createdAt > charter.updatedAt`；
  或 charter.`targetJournal` 非空且存在 `changeType` 为 `contribution|scope` 且 `createdAt > charter.updatedAt` 的 change
  （为期刊调整贡献/范围但 Charter 未同步）。

## 5. Research Context Pack（GET context-pack）

返回 `{markdown, blocks, generatedAt}`；`blocks` 顺序即 §33 列表，`markdown` 为同内容的拼接：

PROJECT（项目名 + currentStage）→ Current Research Question（code+text+status；区块名按开发文档 §33 用单数）→ Core Contribution →
Research Boundary → Claim Boundary → Current Method（researchMethod + relatedMethod）→
Confirmed Claims（status==='confirmed'，含 code+text）→ Key Evidence（支撑 confirmed claim 的证据 title+type）→
Important Decisions（最近 5 条，title+decision）→ Recent Changes（最近 5 条，changeType+before→after）→
Open Issues（status='open' 的 RQ + open findings 数量）→ Current Drift Warnings（open findings，含 severity+description）。

## 6. 模块布局与文件归属（防止并行冲突，勿越界改他人文件）

```
packages/schema/src/research.ts|research-api.ts      [已完成·契约] 只读参考，发现问题回报统筹
packages/storage/src/research-types.ts               [已完成·契约] 同上
packages/api-client/src/client.ts                    [已完成·契约] 同上
packages/storage/src/research-in-memory.ts           → 存储 Agent（A）
packages/storage/src/research-supabase.ts            → 存储 Agent（A）
packages/storage/test/research*.ts                   → 存储 Agent（A）
supabase/migrations/*research*.sql                   → 存储 Agent（A）
services/knowledge-core/src/research/**              → 领域 Agent（B）
services/knowledge-core/src/http/router.ts（追加）   → 领域 Agent（B）
services/knowledge-core/src/core.ts、src/config.ts   → 领域 Agent（B）
services/knowledge-core/test/research*.ts            → 领域 Agent（B）
apps/web/**（research 页面/组件/代理/测试）          → Web Agent（C）
docs/research-contract.md                            → 统筹（只读）
```

其他约定：
- 时间统一 ISO-8601 UTC 字符串（`@noltri/shared` 的 `nowIso`）；ID 用 `@noltri/shared` 的 id 工具。
- 编码风格、错误处理、测试写法向所在包的既有文件看齐（vitest；中文文案风格一致）。
- **不要执行 git commit**（由统筹统一按功能提交）；不要动 `FUNCTION_MAP.md`（由统筹回写）。
- 每完成一个模块跑一次所在包的 `pnpm --filter <pkg> run typecheck` 与 `test`，绿了再继续。
