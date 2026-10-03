# Noltri Research V1 开发文档

**版本：V1.0**  
**项目：Noltri / 知序**  
**模块：Research Project**  
**开发性质：现有 Noltri 的功能扩展，不建立独立产品**  
**核心定位：科研文章的研究连续性工作台**

---

# 1. 项目背景

Noltri 当前解决的核心问题，是个人在长期复杂项目中不断使用 AI、Agent、网页工具及本地开发环境后，项目容易出现信息分散、决策失忆、目标漂移以及后续 Agent 无法准确理解项目历史等问题。

科研文章具有与软件开发高度相似的长期连续性问题。

一篇科研文章通常经历：

选题 → 文献阅读 → 研究问题形成 → 研究设计 → 数据处理 → 分析 → 写作 → 修改 → 投稿 → 审稿 → 再修改 → 再投稿。

整个周期可能持续数月甚至数年。

随着项目推进，经常出现以下问题：

- 最初的研究问题逐渐变化，但研究者无法准确回忆变化原因；
- 文献、数据、分析结果与论文正文之间缺乏清晰对应关系；
- 一个结论究竟来自哪项证据，后期难以追溯；
- Discussion 中的解释逐渐超出数据真正能够支持的范围；
- 为适应不同目标期刊不断修改文章后，论文可能偏离最初研究定位；
- AI 多轮协助写作以后，新 Agent 无法知道哪些观点已经确认、哪些只是临时讨论；
- 审稿意见、修改决策和最终正文之间缺乏结构化记录。

Research V1 的目标不是建立“AI 论文代写工具”，而是把 Noltri 已有的项目连续性思想扩展至科研场景。

---

# 2. 产品定位

Research V1 定义为：

> **面向个人科研工作者的科研文章连续性管理系统。**

系统主要管理：

**Question → Evidence → Claim → Argument → Manuscript → Evolution**

其底层逻辑仍然延续 Noltri：

**Intent → Boundary → Evidence → Decision → State → Change → History → Continuity**

Research 不作为独立 App，而作为 Noltri 新增的一种 Project Type。

系统至少支持：

```text
Project
├── Coding Project
└── Research Project
```

后续其他复杂个人项目仍可继续基于同一底层架构扩展。

---

# 3. V1 开发目标

Research V1 不追求一次性覆盖科研全过程。

本阶段重点验证：

> Noltri 是否能够把科研文章从“文档”转化成一个具有研究目标、研究边界、证据链、论点链、决策历史和版本演进的长期项目。

V1 建立以下核心链路：

```text
Research Charter
       ↓
Research Question
       ↓
Evidence
       ↓
Claim
       ↓
Manuscript Section
       ↓
Research Drift Detection
```

同时建立：

```text
Research Decision
Research Change
Research Map
Research Timeline
```

---

# 4. V1 非目标

V1 暂不开发以下完整能力：

- 不重新开发 Zotero 类参考文献管理系统；
- 不开发 Word 替代编辑器；
- 不开发统计分析软件；
- 不开发 SPSS / R / Python 替代能力；
- 不开发完整 PDF 阅读器；
- 不开发查重系统；
- 不开发期刊推荐算法；
- 不开发自动投稿系统；
- 不直接自动生成完整科研论文；
- 不开发完整 Reviewer Response Letter 自动化流程；
- 不建立大型学术知识图谱。

这些能力可以在后续版本建立，但不能影响 Research V1 核心链路的验证。

---

# 5. 开发隔离方案

## 5.1 采用方案

本次开发采用：

> **新 Git Branch + 独立 Git Worktree**

而不是仅建立新 Branch。

建议开发分支：

```text
feature/research-v1
```

建议 Worktree：

```text
/Users/youngi/Documents/MiniWork/知序-Noltri-Research-V1
```

原项目保持：

```text
/Users/youngi/Documents/MiniWork/知序-Noltri
```

---

# 6. 为什么采用 Worktree

仅使用 Branch 时，开发者必须在同一个目录不断：

```text
git switch ...
```

这会造成：

- 前后版本不能同时运行；
- 开发环境需要重复切换；
- 本地未提交改动容易影响版本切换；
- 对照测试效率低；
- 很难同时观察旧版和 Research V1 的行为。

Git Worktree 可以让两个 Branch 同时存在于两个独立目录。

形成：

```text
知序-Noltri
│
│ 当前稳定版本
│ 原有功能
│ 原测试环境
│
└── Git Repository
         │
         └── feature/research-v1
                    │
                    ▼
知序-Noltri-Research-V1
│
│ Research V1
│ 独立开发
│ 独立运行
│ 独立测试
```

这样可以直接同时打开：

```text
Old Version
Research V1
```

进行功能、界面、数据行为和 Agent 工作流的前后对照。

因此，本项目明确采用 **Branch + Worktree**。

---

# 7. Worktree 建立规范

在确认当前稳定版本没有未处理的重要修改后，从当前稳定基线创建：

```bash
git status
git branch --show-current
git rev-parse HEAD
```

记录当前基线 Commit。

随后创建：

```bash
git worktree add \
  ../知序-Noltri-Research-V1 \
  -b feature/research-v1
```

创建完成后：

```bash
git worktree list
```

应同时看到：

```text
知序-Noltri
知序-Noltri-Research-V1
```

Research V1 的所有研发工作原则上仅在：

```text
知序-Noltri-Research-V1
```

进行。

除非明确决定合并，否则不得直接修改原稳定版本。

---

# 8. 双版本测试要求

Worktree 建立后，应保证两个版本能够独立运行。

例如：

```text
Stable Version
localhost:3000

Research V1
localhost:3001
```

实际端口根据现有项目技术栈确定，不应为了实现双版本运行而硬编码端口。

通过环境配置区分即可。

如果项目存在本地数据库、本地文件存储、SQLite、IndexedDB 或其他可写数据源，则 Research V1 应优先使用独立测试数据空间。

原则是：

> **代码隔离，同时尽量保证测试数据隔离。**

不得因为同时运行两个版本导致旧版测试数据被新版迁移、覆盖或破坏。

---

# 9. Research Project

新增 Project Type：

```text
research
```

创建 Research Project 后，项目拥有自己的 Research Domain。

Research Project 不改变普通 Project 的基础结构。

推荐：

```text
Project
├── Common Project Layer
│   ├── Identity
│   ├── State
│   ├── Event
│   ├── Decision
│   ├── Change
│   ├── Timeline
│   └── Context
│
└── Research Domain
    ├── Research Charter
    ├── Research Question
    ├── Evidence
    ├── Claim
    ├── Research Decision
    ├── Research Change
    ├── Research Map
    └── Drift Finding
```

原则：

> Research 尽量复用 Noltri 已经存在的底层能力，只新增科研领域语义，不重复建立第二套系统。

---

# 10. Research Charter

Research Charter 是一篇科研文章的最高层约束。

它相当于 Coding Project 中项目初始设计和核心边界的科研版本。

至少包含：

```text
Working Title

Research Topic

Research Problem

Research Gap

Research Questions

Core Contribution

Theoretical Lens

Research Context

Unit of Analysis

Research Method

Target Article Type

Target Journal

Research Boundary

Claim Boundary

Current Stage
```

其中最重要的是：

```text
Research Boundary
Claim Boundary
```

---

# 11. Research Boundary

Research Boundary 用来明确：

```text
What this research addresses

What this research does NOT address
```

例如：

```text
研究对象：
冷链物流服务质量因素之间的结构关系。

研究范围：
因素之间的专家判断依赖关系。

不包含：
统计意义上的因果推断。
```

Research Boundary 应可以被 Drift Checker 使用。

---

# 12. Claim Boundary

Claim Boundary 描述：

> 当前研究证据最多能够支持到什么程度。

例如：

```text
ISM relationship
≠ statistical causality

ANP priority
≠ economic value

Expert judgement
≠ objective population parameter

Robustness
≠ external validity
```

系统后续检测正文 Claim 时，应参考 Claim Boundary。

---

# 13. Research Question

Research Question 必须成为独立实体，而不是 Charter 中的一段普通文字。

数据结构建议：

```text
id
project_id

question_code
question_text

status

rationale

related_method

created_at
updated_at
```

例如：

```text
RQ1

How are service-quality factors structurally
organized within the cold-chain logistics system?
```

RQ 可以关联：

```text
Evidence
Claim
Method
Finding
Section
Decision
Change
```

---

# 14. Evidence

Evidence 是 Research V1 最核心的数据实体之一。

Evidence 表示：

> 支撑某一科研判断的信息来源。

类型至少支持：

```text
literature
dataset
analysis_result
figure
table
interview
expert_judgement
document
note
external_source
other
```

Evidence 建议至少包含：

```text
id
project_id

type
title
description

source_reference
source_location

reliability_note

created_at
updated_at
```

V1 不要求建立复杂文献管理功能。

重点不是保存完整文献数据库，而是保存：

> **这份证据为什么与当前研究有关。**

---

# 15. Claim

Claim 是 Research V1 的关键创新对象。

Claim 表示：

> 当前论文准备向读者表达的一个可以被验证、支持或限制的科研判断。

例如：

```text
C-021

Reliability-related factors occupy relatively
high structural levels in the elicited ISM model.
```

Claim 至少包含：

```text
id
project_id

claim_code
claim_text

claim_type

status

confidence

boundary

created_at
updated_at
```

Claim Type 建议包括：

```text
descriptive
empirical
methodological
interpretive
theoretical
contribution
limitation
```

---

# 16. Claim–Evidence Relationship

Evidence 与 Claim 之间必须建立显式关系。

关系可以包括：

```text
supports
partially_supports
contradicts
qualifies
contextualizes
```

例如：

```text
Evidence E-031
       │
       ├── supports
       ▼
Claim C-021
```

同一 Claim 可以拥有多个 Evidence。

同一 Evidence 也可以支撑多个 Claim。

---

# 17. Claim–Section Relationship

Claim 可以进一步关联 Manuscript Section。

例如：

```text
Claim C-021
├── Results 4.2
├── Discussion 5.1
└── Conclusion
```

V1 不要求开发完整论文编辑器。

只需要能够保存：

```text
section_id
section_name
section_reference
```

后续可以与真实 Markdown、Word、LaTeX 或 Google Docs 集成。

---

# 18. Research Decision

Research Decision 用于记录科研过程中已经确认的重要判断。

例如：

```text
为什么采用 ISM + ANP？

为什么删除 Hypothesis 3？

为什么修改 RQ2？

为什么增加 robustness analysis？

为什么更换目标期刊？
```

结构建议：

```text
id

title

decision

reason

alternatives

rejected_alternatives

impact

related_entities

created_at
```

Decision 应属于不可轻易覆盖的历史对象。

后续发生变化时，应新增 Change，而不是直接删除历史记录。

---

# 19. Research Change

Research Change 表示正式研究设计或论文逻辑发生变化。

结构：

```text
id

change_type

before

after

reason

impact

related_entities

created_at
```

Change Type 可以包括：

```text
research_question
method
scope
claim
contribution
journal
structure
evidence
other
```

例如：

```text
CHANGE-014

Type:
Research Question

Before:
RQ2 focused on overall importance.

After:
RQ2 focuses on goal-dependent decision priority.

Reason:
ANP output represents relative priorities under
the specified decision goal rather than universal importance.

Impact:
Introduction
Method
Results
Discussion
Conclusion
```

---

# 20. Research Timeline

Decision 与 Change 应共同进入 Research Timeline。

例如：

```text
2026-03-18
RQ2 modified

2026-04-02
Method baseline frozen

2026-05-11
Robustness analysis added

2026-06-03
Contribution narrowed

2026-07-22
Submission V1

2026-08-01
Target journal changed
```

点击 Timeline Event 后，可以查看：

```text
What changed
Why
Related objects
Affected sections
```

---

# 21. Research Map

Research Map 是 V1 的核心可视化之一。

最低目标：

能够看到：

```text
Research Question
       ↓
Evidence
       ↓
Claim
       ↓
Section
       ↓
Contribution
```

例如：

```text
RQ1
│
├── E12
├── E17
│
▼
C03
│
├── Results 4.1
├── Discussion 5.1
│
▼
Contribution 1
```

Research Map 的目标不是展示复杂漂亮的知识图谱。

目标是让研究者快速回答：

> 我的研究结论是怎样被一步一步支撑起来的？

---

# 22. Research Drift Checker

Research Drift Checker 是 Research V1 最重要的 Agent 能力。

V1 首先支持六类 Drift。

## RQ Drift

正文出现新的主要研究问题，但 Research Charter 中不存在。

---

## Contribution Drift

当前摘要、Discussion 或 Conclusion 宣称的贡献超出 Charter 中定义的 Core Contribution。

---

## Evidence Drift

Claim 没有 Evidence 支撑。

例如：

```text
Claim C-037
Status:
Unsupported
```

---

## Causality Drift

Claim 使用：

```text
cause
lead to
result in
impact
determine
```

等强因果表达，但 Evidence 类型或 Claim Boundary 不支持该程度推断。

---

## Method Drift

研究方法发生实质变化，但：

```text
Research Method
Research Question
Research Boundary
```

尚未同步更新。

---

## Journal Drift

由于针对目标期刊调整论文，新的 Contribution 或 Research Scope 与原 Research Charter 出现明显偏离。

---

# 23. Drift Finding

Drift 检测结果必须作为独立对象保存。

建议结构：

```text
id

drift_type

severity

description

source_entity

target_entity

reason

recommended_action

status

created_at
```

Severity：

```text
info
warning
critical
```

例如：

```text
Research Drift

Type:
Evidence Drift

Severity:
Warning

Claim:
C-037

Finding:
该 Claim 当前没有关联 Evidence。

Suggested Action:
补充 Evidence，弱化 Claim，
或将其改为 Future Research。
```

---

# 24. AI / Agent 行为原则

Research Agent 不应默认直接重写论文。

核心职责是：

```text
识别
分类
关联
比较
检测
提醒
解释
```

例如用户输入：

```text
我们是不是应该把 RQ2 改成研究决策优先级？
```

系统不应仅生成修改后的句子。

首先应识别：

```text
Potential Research Change
```

随后判断：

```text
Affected:
RQ2
Method
Claim
Discussion
Contribution
```

并形成 Change Proposal。

---

# 25. Capture → Compile

Noltri 原有：

```text
Capture
→ Compile
→ Connect
→ Complete
```

在 Research 中继续使用。

例如用户导入一段内容：

```text
ANP weight reflects relative priority
under a particular decision goal.
```

Compile 阶段可以判断：

```text
Potential Claim Boundary
```

然后关联到：

```text
Method
ANP
RQ2
```

而不是仅仅存成 Note。

---

# 26. Research Inbox

V1 可以复用 Knowledge Inbox 思想增加 Research Inbox。

所有尚未被系统完全分类的科研输入进入：

```text
Research Inbox
```

可能包括：

```text
Idea
Evidence
Potential Claim
Potential Decision
Potential Change
Literature
Question
Conflict
Unknown
```

用户确认后进入正式 Research Graph。

---

# 27. 数据关系模型

推荐逻辑：

```text
ResearchProject
      │
      ├── ResearchCharter
      │
      ├── ResearchQuestion
      │
      ├── Evidence
      │
      ├── Claim
      │
      ├── ResearchDecision
      │
      ├── ResearchChange
      │
      ├── DriftFinding
      │
      └── TimelineEvent
```

同时建立通用 Relation：

```text
EntityRelation

id

project_id

source_type
source_id

relation_type

target_type
target_id
```

这样可以表达：

```text
Evidence
supports
Claim

Claim
answers
ResearchQuestion

Claim
appears_in
Section

Decision
changes
ResearchQuestion
```

不建议为每一种关系单独建立一张表。

---

# 28. 与现有 Noltri 架构的兼容原则

Research V1 不应通过大规模重构现有 Coding Project 实现。

优先原则：

```text
Common Core
+
Domain Extension
```

即：

```text
Noltri Core

Project
Event
Decision
Change
State
Relation
Context
Timeline

        ↓

Domain

Coding
Research
```

如果现有代码已经具备类似通用对象，应优先复用。

如果当前实现仍然偏 Coding 专用，则仅对必要部分进行抽象。

不得为了 Research V1 一次性重写整个底层架构。

---

# 29. 数据迁移原则

Research V1 不应要求旧项目立即迁移。

旧 Coding Project：

```text
保持原行为。
```

新建 Research Project：

```text
使用 Research Domain。
```

如果底层 Schema 需要增加字段，应：

```text
新增
兼容
可回滚
```

不能破坏旧项目数据读取能力。

---

# 30. FUNCTION_MAP.md

现有 `FUNCTION_MAP.md` 继续作为整个项目功能地图。

Research V1 开发过程中必须同步更新。

建议新增：

```text
## Research Project

### Implemented

### In Progress

### Planned
```

每完成一个真实可用功能后再移动至：

```text
Implemented
```

不能因为代码文件已经存在就标记为完成。

完成标准必须是：

```text
功能存在
+
核心链路可执行
+
基本测试通过
```

---

# 31. 建议代码模块

实际名称根据现有技术栈调整。

逻辑上建议形成：

```text
research/
├── charter
├── questions
├── evidence
├── claims
├── decisions
├── changes
├── relations
├── map
├── drift
├── timeline
└── agent
```

Domain Logic 与 UI Logic 尽量分离。

Drift Checker 不应直接耦合页面组件。

---

# 32. Research V1 开发阶段

## Phase 1：Project Type

完成：

```text
research project type
research project creation
research project loading
```

确保：

Coding Project 行为不受影响。

---

## Phase 2：Research Charter

完成：

```text
Research Charter
Research Boundary
Claim Boundary
Research Questions
```

---

## Phase 3：Evidence + Claim

实现：

```text
Evidence
Claim
Claim–Evidence Relation
Claim–RQ Relation
Claim–Section Relation
```

这是 Research V1 的第一个核心闭环。

---

## Phase 4：Decision + Change

实现：

```text
Research Decision
Research Change
Impact Relation
Timeline Event
```

---

## Phase 5：Research Map

实现：

```text
RQ
→ Evidence
→ Claim
→ Section
→ Contribution
```

优先保证可读性，不追求复杂动画。

---

## Phase 6：Drift Checker

首先完成：

```text
RQ Drift
Contribution Drift
Evidence Drift
Causality Drift
Method Drift
Journal Drift
```

---

## Phase 7：Agent Integration

Agent 应能够：

```text
读取 Research Context

判断新输入属于什么实体

提出 Relation 建议

发现潜在 Change

运行 Drift Check

生成 Research Context Pack
```

---

# 33. Research Context Pack

Research Project 应能够生成给 AI / Agent 使用的紧凑上下文。

例如：

```text
PROJECT

Current Research Question

Core Contribution

Research Boundary

Claim Boundary

Current Method

Confirmed Claims

Key Evidence

Important Decisions

Recent Changes

Open Issues

Current Drift Warnings
```

这样新的 Agent 不需要重新阅读整个科研项目历史。

---

# 34. V1 最小成功链路

必须优先确保以下过程完整跑通：

```text
创建 Research Project

↓

填写 Research Charter

↓

建立 RQ1

↓

导入 Evidence

↓

创建 Claim

↓

Evidence supports Claim

↓

Claim answers RQ1

↓

Claim 关联论文 Section

↓

Research Map 显示关系

↓

Drift Checker 检查

↓

生成 Research Context Pack
```

只要这条链路稳定，Research V1 即具备基本产品价值。

---

# 35. 测试策略

同时运行：

```text
Stable Noltri

Research V1
```

测试分为：

### Regression Test

确认 Research 开发没有破坏：

```text
Coding Project
Project Creation
Existing Data
Existing Agent Workflow
Existing Project Map
```

### Research Functional Test

测试：

```text
Charter
RQ
Evidence
Claim
Relation
Decision
Change
Timeline
Research Map
Drift
Context Pack
```

### Comparison Test

针对同一个普通项目行为分别在：

```text
Stable Version
Research V1
```

执行。

观察行为是否发生非预期变化。

---

# 36. Research 示例测试项目

建议创建一个专门的测试科研项目：

```text
Noltri Research Demo
```

至少设置：

```text
RQ1
RQ2

5 Evidence

5 Claims

2 Decisions

2 Changes

3 Drift Findings
```

专门用于自动化和手工测试。

不要直接使用重要真实论文作为早期测试数据。

---

# 37. Git Commit 原则

Research V1 开发中按功能形成小 Commit。

例如：

```text
feat(research): add research project type

feat(research): add research charter

feat(research): add evidence entity

feat(research): add claim evidence relations

feat(research): add research map

feat(research): add drift checker
```

不要将整个 Research V1 作为一个巨大 Commit。

---

# 38. 合并条件

Research V1 不自动合入主版本。

达到以下条件后再决定：

```text
核心链路完整

Coding Regression Test 通过

Research Demo 可完整运行

数据没有破坏

双版本测试完成

FUNCTION_MAP 已同步

核心 Drift Checker 工作正常
```

之后再决定：

```text
Merge

继续独立测试

或者重新设计部分功能
```

---

# 39. Worktree 后续处理

如果最终接受 Research V1：

先将：

```text
feature/research-v1
```

合并回正式开发分支。

确认无误后再删除 Worktree。

例如：

```bash
git worktree remove ../知序-Noltri-Research-V1
```

不得在尚未确认是否保留 Research V1 时提前删除。

---

# 40. V1 验收标准

Research V1 完成时，用户应该能够回答以下问题：

```text
我的研究到底在研究什么？

每个 RQ 当前是什么？

这条 Claim 来自什么 Evidence？

这个结论出现在哪一部分？

为什么当初这么设计？

后来为什么改了？

现在和最初相比改变了什么？

哪些 Claim 缺乏证据？

哪些表述超出了数据边界？

目前论文有没有偏离最初研究目标？

如果换一个新的 AI Agent，
它能不能在很短时间内理解整个研究项目？
```

如果系统能够可靠回答这些问题，则 Research V1 达到设计目标。

---

# 41. 后续版本候选功能

以下功能进入后续版本候选，而不是当前 V1：

```text
Literature Evidence Parser

PDF Structure Extraction

DOI / Zotero Integration

Citation Graph

Reviewer Comment Matrix

Response Letter

Submission Package

Journal Requirement Profile

Manuscript Version Diff

Figures / Tables Traceability

Research Conflict Detection

Multi-paper Research Program

Dataset Versioning

Statistical Result Import

Research Archive
```

---

# 42. 最终产品原则

Noltri Research 不应发展成：

> “输入题目，然后 AI 帮你生成一篇论文。”

它应该解决更长期的问题：

> **让一个持续数月甚至数年的研究项目始终保留自己的逻辑、边界、证据、决策、演化历史和当前状态。**

因此 Research V1 的核心不是 Writing。

而是：

```text
Continuity
Traceability
Evidence
Boundary
Decision
Evolution
```

最终目标是让研究者即使经过大量 AI 协作、多次修改、多轮投稿以及较长时间中断以后，仍然可以准确知道：

> **这篇文章为什么变成今天这个样子。**