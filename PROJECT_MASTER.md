# 个人知识编译系统：项目总控文档

> 文档角色：本文件是项目的最高级开发约束与全局设计基准。  
> 使用方式：任何编码 Agent 在开始开发前必须先阅读本文件，再阅读当前迭代开发文档；开发完成后必须按本文件要求回写 `FUNCTION_MAP.md`。  
> 本文件不用于记录逐条开发日志，不用于记录临时 Bug，不替代 `FUNCTION_MAP.md`。

---

## 1. 产品定义

本项目构建一个跨网页、跨桌面 Agent、跨模型的个人知识编译系统。

核心流程：

**Capture → Compile → Connect → Complete**

即：

1. Capture：从网页、Agent 客户端、对话工具等位置收集用户主动选中的内容；
2. Compile：保留原始材料，并将内容拆解、归纳、分类为原子知识；
3. Connect：将知识自动接入已有知识体系，形成树形主视图与底层知识关系网络；
4. Complete：识别缺口、冲突、薄弱知识，并允许围绕节点继续与模型交互和补充。

产品的第一视觉主体必须始终是：

**知识树（Knowledge Tree）**

其他所有能力均围绕知识树服务，不得把产品做成多个平级后台模块的集合。

---

## 2. 不可变的产品原则

### 2.1 知识树是产品主体

App 打开后，用户应立即确认“这个软件的主体就是我的知识树”。

来源、冲突、版本、Inbox、关系、缺口、AI 对话、掌握状态等能力，应尽量作为节点属性、节点详情、轻量提示或二级界面出现。

不得把以下能力全部做成一级菜单：

- 来源
- 冲突
- 版本
- 缺口
- 图谱
- AI 对话
- 掌握状态

### 2.2 原始材料永不被 AI 摘要覆盖

必须分离三层：

1. Raw Source：用户原始选中的内容和上下文；
2. Knowledge Item：AI 从原始材料中提取出的原子知识；
3. Knowledge Node：进入知识体系后的结构节点。

后续重新摘要、合并、拆分、移动和重组均不得删除原始材料。

### 2.3 Knowledge Core 是唯一知识逻辑源

浏览器插件、桌面选区捕获、Web App、MCP、Skill 均不得各自实现一套分类、去重、合并或知识树逻辑。

所有入口统一调用 Knowledge Core。

### 2.4 所有结构变化必须可逆

至少保证：

- Move
- Merge
- Split
- Rename
- Re-parent

可以留下历史记录，并支持恢复或审计。

### 2.5 Skill 不是系统硬依赖

系统在没有 Skill 的情况下必须完整工作。

Skill 只用于支持 Skill 的 Agent 中优化工具调用方式和工作流理解。

### 2.6 MCP 不是数据仓库

MCP 是 AI Client 与 Knowledge Core 之间的标准工具接口。

知识真正保存在 Knowledge Storage 中。

### 2.7 不绕过任何第三方平台授权

Setup Manager 只能：

- 检测
- 引导
- 打开官方授权入口
- 准备必要配置
- 显示连接状态

不得静默绕过用户确认或第三方安全机制。

---

## 3. 已确认的完整功能体系

以下功能已确定保留，不在后续迭代中重新讨论是否需要。

### 3.1 原始材料与原子知识分层保存

保留完整原始材料，并从中拆分出一个或多个原子知识点。

### 3.2 知识溯源

每个知识点应能够追溯：

- 来源平台
- 页面 / 会话标题
- URL（若存在）
- 原始摘录
- 上下文
- 收纳时间
- 来源类型
- 是否为 AI 提炼
- 派生关系

### 3.3 相似知识融合，但不得覆盖原始知识

系统发现相似内容后，应将新的证据、说明、例子或边界补充到已有知识结构，而不是简单覆盖或丢弃。

### 3.4 冲突检测

相似知识出现不一致时，应标记为冲突或待核实，而非静默合并。

### 3.5 知识有效期与版本

为时间敏感知识预留：

- captured_at
- valid_from
- valid_to
- last_verified_at
- version_scope

### 3.6 Knowledge Inbox

根据分类置信度决定：

- 高置信度：自动归档；
- 中置信度：自动归档并保留建议；
- 低置信度：进入 Inbox。

具体阈值不得硬编码在 UI 中，应配置化。

### 3.7 知识缺口发现

系统能够对一个节点、章节或整棵知识树分析：

- 已有
- 薄弱
- 缺失

用户可以选择是否让 AI 补充。

### 3.8 多类型知识关系

前端以树为主，底层使用 Node + Edge 关系模型。

至少支持预留：

- part_of
- prerequisite_of
- similar_to
- contrast_with
- causes
- implements
- example_of
- supports
- contradicts
- derived_from

### 3.9 节点级 AI 对话作用域

用户点击节点后，可以围绕：

- 当前节点
- 当前章节
- 当前知识树
- 整个知识库

进行 AI 对话。

默认上下文应尽量局部化，不得无条件加载整个知识库。

### 3.10 “知识 ≠ 学会”的掌握状态

第三次迭代加入学习状态，例如：

- 已收藏
- 已整理
- 已理解
- 能够解释
- 能够应用
- 已掌握

具体名称可以在实现前微调，但必须保留“知识存在”和“用户掌握程度”两个不同维度。

---

## 4. 用户入口设计

系统存在三种主要知识采集入口。

### 4.1 网页入口：Browser Extension

适用于：

- ChatGPT Web
- Claude Web
- Gemini Web
- Perplexity Web
- 普通网站
- 文档网页
- GitHub
- 论坛
- 博客等

交互：

用户选中文字  
→ 选区附近出现“归纳知识点”按钮  
→ 点击  
→ 内容与来源信息发送到 Knowledge Core  
→ 返回轻量结果提示

同时提供右键菜单作为备用入口。

网页端不做 ChatGPTAdapter / ClaudeAdapter 等站点级原生按钮适配。

原则：

**网页统一通过浏览器插件完成。**

### 4.2 桌面客户端入口：Desktop Selection Capture

适用于客户端性质的 Agent 或应用，例如：

- Codex
- Qoder
- Hermes
- DSH
- IDE / Terminal 中的 Agent
- 其他能够暴露系统可访问文本选区的桌面软件

目标交互：

用户直接选中文字  
→ 本机检测到选区变化  
→ 在选区或光标附近弹出“归纳知识点”  
→ 点击  
→ Desktop Companion 将内容送入 Knowledge Core

用户不需要每次都对 Agent 说“把这段收纳”。

V1 优先采用操作系统 Accessibility 能力实现通用捕获，不为每个 Agent 分别开发专用插件。

若某个客户端不暴露可读取的选区，则使用降级方案：

1. 全局快捷键；
2. 手动粘贴；
3. 后续必要时再增加特定客户端适配。

### 4.3 Agent 主动调用入口：MCP

当用户希望直接在 Agent 中使用自然语言操作知识库，例如：

- “查一下我以前收集的 Python 装饰器知识”
- “把上面的内容收纳”
- “看看这个章节还缺什么”

由 Agent 通过 MCP 调用 Knowledge Core。

桌面选区捕获与 MCP 相互独立：

**即使某个 Agent 没有配置 MCP，用户仍应能够通过桌面选区捕获将内容收入知识库。**

---

## 5. Setup Manager

Setup Manager 加入 V1。

Setup Manager 是统一接入入口，不是绕过授权的自动化工具。

### 5.1 职责

- 检查浏览器插件状态；
- 检查 Desktop Capture 所需系统权限；
- 引导用户授予 macOS Accessibility 等系统权限；
- 检测可识别的本机 Agent / 客户端；
- 展示 MCP 连接状态；
- 根据不同 Agent 打开正确的官方连接 / 授权路径；
- 对允许自动生成配置的客户端准备配置内容；
- 展示连接成功 / 失败 / 需要操作的状态；
- 提供连接测试。

### 5.2 用户界面原则

用户不应被迫理解：

- MCP transport
- endpoint schema
- OAuth scope 细节
- JSON 配置文件结构

UI 应以“连接 ChatGPT / Claude / Codex / Cursor ……”等用户目标表达。

### 5.3 授权窗口

每个授权流程至少解释：

- 连接后可以做什么；
- 将访问哪些知识；
- 将允许哪些写操作；
- 用户可以在哪里断开连接。

授权必须由用户明确完成。

---

## 6. 总体架构

```text
                           ┌──────────────────────┐
                           │    Knowledge App     │
                           │  Knowledge Tree UI   │
                           └──────────┬───────────┘
                                      │
                                      │ HTTPS API
                                      ▼
┌─────────────────┐          ┌──────────────────────────┐
│ Browser         │          │                          │
│ Extension       │─────────►│      Knowledge Core      │
└─────────────────┘          │                          │
                             │ Capture                  │
┌─────────────────┐          │ Source                   │
│ Desktop         │─────────►│ Extraction               │
│ Companion       │          │ Classification           │
│ - Capture       │          │ Similarity               │
│ - Setup Manager │          │ Tree                     │
└─────────────────┘          │ Search                   │
                             │ Context                  │
┌─────────────────┐          │ Version / Graph / Gap... │
│ Agent Clients   │── MCP ──►│                          │
└─────────────────┘          └────────────┬─────────────┘
                                          │
                         ┌────────────────┼─────────────────┐
                         ▼                ▼                 ▼
                     PostgreSQL       Vector Index      LLM Adapter
                         │
                         ▼
                  Knowledge Storage
```

---

## 7. Cloud-first → Local-first 的长期架构

### 7.1 V1：Cloud-first

第一阶段优先使用云端 Knowledge Core 与云端数据库。

目的：

- 浏览器插件直接可访问；
- 桌面客户端直接可访问；
- Remote MCP 容易连接；
- 不要求用户保持某台电脑一直在线；
- 跨设备天然可用；
- 先验证核心产品价值。

### 7.2 从第一天就必须解耦存储

Knowledge Core 不得直接把业务逻辑写死到某一云数据库 SDK。

必须建立：

```text
StorageRepository
```

或同类接口。

例如：

```text
KnowledgeRepository
SourceRepository
EdgeRepository
VersionRepository
```

V1 实现：

```text
SupabaseRepository
```

未来增加：

```text
LocalPostgresRepository
或
SQLiteRepository
```

### 7.3 后续 Local-first

当产品核心稳定后，可以加入：

- Desktop Local Knowledge Core；
- 本地数据库；
- Sync Engine；
- Remote MCP Gateway。

届时可以形成：

```text
本地数据库 ←→ Sync Engine ←→ 云端同步副本 / Gateway
```

本地成为用户数据的主要工作副本，云端主要负责：

- 跨设备同步；
- Web Agent 可达；
- Remote MCP Gateway；
- 可选备份。

### 7.4 不做一次性“云转本地重写”

因为 Core、Repository、API Contract 在 V1 就已经解耦，所以迁移方式是：

1. 新增 Local Repository；
2. 新增同步协议；
3. Desktop Core 复用原有业务逻辑；
4. Remote Gateway 继续暴露 MCP；
5. 用户选择 Cloud-only / Local-first 等模式。

---

## 8. V1 推荐技术栈

### Monorepo

- pnpm
- Turborepo

### Web App

- Next.js
- React
- TypeScript

### Browser Extension

- TypeScript
- React
- Chrome Manifest V3
- 后续再扩展 Firefox / Edge

### Desktop Companion

- Tauri
- React / TypeScript UI
- Rust 负责 macOS Accessibility、系统权限与浮层等原生能力

### Knowledge Core

- TypeScript
- Zod
- 独立 domain / service 层
- 可作为 API 服务调用，也可未来嵌入 Desktop Local Core

### Cloud Runtime

V1 默认：

- Web / API / Remote MCP：Vercel
- Database / Auth / Storage：Supabase

### Database

- PostgreSQL
- pgvector
- 不在 V1 引入 Neo4j

### AI Layer

Provider Adapter 模式：

- OpenAI
- Anthropic
- Gemini
- 兼容 API
- 后续本地模型

业务代码只能调用统一能力，例如：

- extractKnowledge()
- classifyKnowledge()
- findSimilar()
- summarizeNode()
- findGaps()

不得把 provider-specific SDK 散落在 Knowledge Core 业务代码中。

### MCP

- TypeScript MCP SDK
- Streamable HTTP
- 单一 MCP Server
- 多 Agent 共用

### Skill

- 可选增强层
- 不作为 Knowledge Core 的依赖

---

## 9. 核心数据模型

### RawSource

保存用户实际选中的原始材料。

核心字段建议：

- id
- user_id
- raw_text
- surrounding_context
- source_type
- source_platform
- source_title
- source_url
- source_app
- captured_at
- metadata_json

### KnowledgeItem

AI 从 RawSource 中提取出的原子知识。

- id
- user_id
- raw_source_id
- normalized_text
- summary
- confidence
- status
- created_at
- updated_at

### KnowledgeNode

知识体系结构节点。

- id
- user_id
- title
- summary
- node_type
- status
- confidence
- parent_id（仅作为树形主视图主父节点）
- created_at
- updated_at

### KnowledgeEdge

底层关系网络。

- id
- user_id
- from_node_id
- to_node_id
- relation_type
- confidence
- source
- created_at

### ItemNodeLink

KnowledgeItem 与 KnowledgeNode 的映射。

- item_id
- node_id
- relation_type
- confidence

### VersionRecord

记录可逆变化。

- id
- entity_type
- entity_id
- operation
- before_json
- after_json
- actor
- created_at

后续迭代继续扩展：

- ConflictRecord
- GapRecord
- MasteryState
- VerificationRecord

---

## 10. Knowledge Core 模块

### V1

- Capture Engine
- Source Engine
- Knowledge Extraction
- Classification Engine
- Similarity Engine
- Tree Engine
- Search Engine
- Conversation Context Engine

### V2

增加：

- Provenance Engine
- Merge Engine
- Conflict Engine
- Version Engine
- Gap Engine
- Graph Engine
- Inbox Engine

### V3

增加：

- Mastery Engine
- Review / Practice capability（是否独立呈现以后再定）

---

## 11. 三次大迭代

# Iteration 1：核心闭环

目标：让“选中内容 → 进入知识树 → 可以继续围绕节点工作”真正跑通。

必须完成：

1. Browser Capture；
2. Desktop Selection Capture；
3. Setup Manager；
4. Raw Source + Source 保存；
5. 原子知识提取；
6. 自动分类；
7. 基础相似判断 / 去重；
8. Knowledge Tree 创建、移动、基础合并；
9. Web App 知识树主体界面；
10. Remote MCP 基础工具；
11. Node AI Conversation；
12. Storage / Provider Adapter 基础抽象。

阶段结束只做 Architecture Gate，不进行大规模人工 UX 验收。

# Iteration 2：知识质量与自我维护

完成：

1. 完整溯源；
2. 相似知识融合；
3. 冲突检测；
4. 知识有效期 / 版本；
5. Knowledge Inbox；
6. 知识缺口分析；
7. 多类型关系图谱；
8. 完整可逆结构操作；
9. 关系 / 来源 / 历史等节点详情能力；
10. 高级 MCP tools。

阶段结束进行 Data Integrity Gate。

# Iteration 3：知识掌握层

完成：

1. “知识 ≠ 学会”的状态模型；
2. 知识掌握状态展示；
3. 节点 / 章节掌握度汇总；
4. AI 解释、出题、应用或复习能力的必要基础；
5. 最终 UX 整合。

三次大迭代全部完成后，再集中进行：

- 真实上手使用核验
- 系统性 Bug 修复
- UX Audit
- 性能优化
- 边界场景
- 回归测试
- 视觉细化

开发过程中 Agent 可以自主修复会阻断开发或明显影响正确性的 Bug。

---

## 12. FUNCTION_MAP.md 规则

项目必须存在：

`FUNCTION_MAP.md`

该文件只有两个部分：

```markdown
# FUNCTION_MAP

## 已实现

## 后续实现
```

它只记录功能事实。

禁止加入：

- 架构说明
- Bug 列表
- 开发日志
- 会议记录
- 设计讨论
- 长篇说明

### 每次开发任务完成后的强制动作

开发 Agent 在本轮工作完成后必须：

1. 根据“实际已完成代码”判断功能状态；
2. 更新 `FUNCTION_MAP.md`；
3. 将真正完成的功能从“后续实现”移动到“已实现”；
4. 本轮发现的新需求若已确定进入产品，则加入“后续实现”；
5. 不得把仅有骨架、Mock、TODO 或未完成联调的功能标为已实现；
6. 完成回写后再结束本轮开发。

---

## 13. 开发 Agent 的工作协议

每次正式开发前：

1. 阅读本总控文档；
2. 阅读当前迭代开发文档，例如 `V1_DEVELOPMENT.md`；
3. 严格遵守已经冻结的产品与架构决策；
4. 不自行把产品改造成另一种信息架构。

开发中：

- 可自主修复明显 Bug；
- 可做不改变产品方向的内部重构；
- 遇到技术障碍优先保持功能目标，允许更换内部实现；
- 不因某一 Agent 的特殊能力破坏跨 Agent 的通用架构。

开发结束：

1. 自检本轮修改；
2. 更新 `FUNCTION_MAP.md`；
3. 简要说明实际完成、未完成与需要下一轮继续的内容。

---

## 14. V1 非目标

第一阶段不做：

- 完整离线 Local-first；
- 多设备双向冲突同步；
- Neo4j；
- 为每个网页 Agent 注入专用原生按钮；
- 为每个桌面 Agent 独立开发插件；
- 复杂学习系统；
- 大规模多人协作；
- 企业权限体系；
- 为了“看起来智能”而牺牲原始材料和可逆性。

---

## 15. 最终架构一句话

**Knowledge Tree 是产品主体；Knowledge Core 是唯一知识逻辑源；Browser Extension 负责网页选区采集；Desktop Companion 负责本机客户端选区采集与 Setup Manager；MCP 负责 Agent 主动访问；Skill 只是体验增强；V1 先 Cloud-first 验证产品，架构从第一天为未来 Local-first 留好切换接口。**
