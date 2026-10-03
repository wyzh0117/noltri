# V1 开发文档：核心闭环

> 适用范围：第一次大迭代。  
> 开发 Agent 开始工作前必须先阅读 `PROJECT_MASTER.md`，再阅读本文件。  
> 本文件描述 V1 的具体实现目标、模块、数据流、接口和开发顺序。

---

## 1. V1 目标

V1 只验证一件最重要的事情：

**用户在网页或桌面 Agent 中选中一段有价值的内容，可以自然地一键“归纳知识点”，系统自动保留原文、提取知识、归入正确知识树，并允许用户回到 App 中围绕知识节点继续与 AI 工作。**

V1 不是完整产品。

但 V1 必须形成真实可用的闭环，而不是 Demo。

---

## 2. V1 用户闭环

### 2.1 网页

```text
用户选中文字
→ 选区附近出现“归纳知识点”
→ 点击
→ Browser Extension 收集文本 + 页面来源
→ POST /api/capture
→ Knowledge Core
→ 保存 RawSource
→ 提取 KnowledgeItem
→ 相似搜索
→ 分类到已有 Node 或创建新 Node
→ 返回归类结果
→ 页面显示轻量成功提示
```

### 2.2 桌面 Agent / 客户端

```text
用户在 Codex / Qoder / Hermes / DSH / IDE 等客户端选中文字
→ macOS Accessibility 捕获选区变化
→ 读取 Selected Text
→ 在选区 / 光标附近显示“归纳知识点”
→ 用户点击
→ Desktop Companion 调用 /api/capture
→ 后续流程与网页完全相同
```

这里不依赖用户对 Agent 说话，也不要求对应 Agent 已经配置 MCP。

### 2.3 Agent 主动访问

```text
用户对支持 MCP 的 Agent 说：
“查一下我关于 Python async 的知识”

→ Agent 调用 MCP
→ MCP Server 调用 Knowledge Core
→ 返回节点 / 搜索结果
```

### 2.4 App

```text
用户打开 Knowledge App
→ 首屏就是知识树
→ 点击节点
→ 查看节点摘要、知识数量、来源数量
→ 点击“与 AI 讨论”
→ 系统装载该节点的局部上下文
→ 开始节点级对话
```

---

## 3. V1 技术栈

### 3.1 Monorepo

- pnpm
- Turborepo
- TypeScript 为主

### 3.2 Web

- Next.js
- React
- TypeScript
- Vercel 部署

### 3.3 Database / Auth

- Supabase
- PostgreSQL
- pgvector
- Supabase Auth

### 3.4 Browser Extension

- Manifest V3
- TypeScript
- React
- Content Script
- Context Menu
- Extension Storage

### 3.5 Desktop Companion

- Tauri
- React / TypeScript
- Rust native layer

职责：

- Desktop Selection Capture；
- Floating Capture Button；
- Setup Manager；
- 系统权限管理；
- 后续 Local-first 容器基础。

### 3.6 MCP

- TypeScript MCP SDK
- Streamable HTTP
- Stateless-first 设计
- 远程 `/mcp` endpoint

### 3.7 Validation

- Zod

### 3.8 AI

Provider Adapter。

V1 至少实现一个正式 Provider，其他 Provider 只需保证接口可扩展。

---

## 4. V1 Cloud-first 免费开发组合

开发期默认组合：

### Vercel Hobby

用于：

- Next.js Web App
- API routes
- Knowledge Core HTTP service
- Remote MCP endpoint

### Supabase Free

用于：

- PostgreSQL
- pgvector
- Auth
- 必要的少量 Storage

### LLM

开发期优先使用以下任一方式：

1. BYOK：开发者提供自己的模型 API Key；
2. 允许使用具有免费额度的模型服务；
3. 后续支持本地模型。

注意：

**云端基础设施可以做到开发阶段基本零固定费用，但模型推理并不承诺永久免费。**

不得把某一家模型服务的“免费额度”当作产品架构前提。

---

## 5. Repository 结构

```text
knowledge-system/
│
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── components/
│   │   └── api/
│   │
│   ├── extension/
│   │   ├── src/capture/
│   │   ├── src/overlay/
│   │   ├── src/context-menu/
│   │   ├── src/source/
│   │   └── src/api/
│   │
│   └── desktop/
│       ├── src/ui/
│       ├── src/setup-manager/
│       ├── src/capture/
│       └── src-tauri/
│
├── services/
│   ├── knowledge-core/
│   ├── mcp-server/
│   └── ai/
│
├── packages/
│   ├── schema/
│   ├── api-client/
│   ├── storage/
│   ├── ai-provider/
│   └── shared/
│
├── supabase/
│   └── migrations/
│
├── skills/
│   └── knowledge-skill/
│
├── PROJECT_MASTER.md
├── V1_DEVELOPMENT.md
├── FUNCTION_MAP.md
├── README.md
├── package.json
└── turbo.json
```

V1 不要求 Skill 完成复杂能力，但保留目录。

---

## 6. V1 核心 Schema

### 6.1 CaptureRequest

```ts
type CaptureRequest = {
  text: string;
  surroundingContext?: string;

  source: {
    type: "web" | "desktop_app" | "agent" | "manual";
    platform?: string;
    appName?: string;
    title?: string;
    url?: string;
  };

  capture: {
    capturedAt: string;
    deviceId?: string;
    client: "extension" | "desktop" | "mcp" | "web_app";
  };
};
```

所有采集入口最终都转换成这个结构。

### 6.2 CaptureResult

```ts
type CaptureResult = {
  rawSourceId: string;

  items: Array<{
    knowledgeItemId: string;
    text: string;
    nodeId: string;
    nodePath: string[];
    action: "created" | "attached" | "merged";
    confidence: number;
  }>;
};
```

### 6.3 KnowledgeNode

```ts
type KnowledgeNode = {
  id: string;
  userId: string;
  title: string;
  summary?: string;
  nodeType: string;
  parentId?: string;
  status: "active" | "archived";
  confidence?: number;
  createdAt: string;
  updatedAt: string;
};
```

### 6.4 KnowledgeEdge

```ts
type KnowledgeEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: string;
  confidence?: number;
  createdAt: string;
};
```

---

## 7. V1 数据库表

至少建立：

- users
- raw_sources
- knowledge_items
- knowledge_nodes
- knowledge_edges
- item_node_links
- version_records
- conversations
- conversation_messages

如果 Supabase Auth 已提供 user 表，则业务层引用 auth user id，不重复维护密码等认证数据。

向量字段可以位于：

- knowledge_items.embedding
- knowledge_nodes.embedding

V1 优先保证 KnowledgeItem 向量搜索。

---

## 8. Knowledge Core API

### POST /api/capture

职责：

1. 校验请求；
2. 保存 RawSource；
3. 调用 Extraction；
4. 为每个 KnowledgeItem 生成 embedding；
5. 查找相似 Item / Node；
6. 判断关联已有节点还是创建节点；
7. 写入 ItemNodeLink；
8. 返回 CaptureResult。

### GET /api/tree

参数：

- rootId
- depth

返回树形主视图需要的数据。

### GET /api/nodes/:id

返回节点详情。

### PATCH /api/nodes/:id

修改：

- title
- summary
- status

### POST /api/nodes/:id/move

移动节点，并写入 VersionRecord。

### POST /api/search

语义搜索 + 关键词搜索。

### POST /api/node-context

输入 nodeId 和 scope。

返回节点 AI 对话需要的上下文包。

---

## 9. Knowledge Core Pipeline

```text
CaptureRequest
      │
      ▼
Validate
      │
      ▼
Save RawSource
      │
      ▼
Atomic Knowledge Extraction
      │
      ▼
Normalize
      │
      ▼
Embedding
      │
      ▼
Similarity Search
      │
      ▼
Classification
      │
      ├── Attach to existing Node
      │
      └── Create Node
      │
      ▼
Persist
      │
      ▼
CaptureResult
```

重要规则：

**先保存 RawSource，再做任何 AI 处理。**

即使 AI 调用失败，原始内容仍然必须已经安全保存。

AI 处理失败时记录：

- processing_status = failed
- error_reason

后续可以重试。

---

## 10. Browser Extension

V1 网页端不做站点专用适配。

### 10.1 Selection Capture

监听网页 selection。

满足以下条件时才显示浮动按钮：

- selection 非空；
- 长度超过最低阈值；
- 用户没有正在拖拽；
- 不在 Extension 自身 UI；
- 当前域名未被用户禁用。

### 10.2 Floating Button

显示：

**归纳知识点**

原则：

- 轻量；
- 不遮挡主要内容；
- 点击外部消失；
- ESC 消失；
- 不抢页面键盘焦点。

### 10.3 Context Menu

选中文字后右键：

**归纳到知识树**

作为稳定备用入口。

### 10.4 Source Extractor

采集：

- selected text
- page URL
- page title
- domain / platform
- 适量 surrounding context

不得默认采集整页内容。

### 10.5 成功提示

例如：

```text
✓ 已收纳

Python
└── 数据结构
    └── Tuple
```

几秒后自动消失。

---

## 11. Desktop Selection Capture

这是 V1 的正式功能，不是后续增强项。

### 11.1 macOS 优先

使用 macOS Accessibility API。

主要思路：

1. 获取当前焦点 UI element；
2. 监听 Selected Text 变化；
3. 读取 selected text；
4. 获取或估算选区 / 光标位置；
5. 显示 Tauri 浮动窗口；
6. 用户点击后发送 CaptureRequest。

### 11.2 权限

首次启用时必须由用户授权 Accessibility。

Setup Manager 提供：

- 当前权限状态；
- “打开系统设置”按钮；
- 权限获取后的重新检测；
- 测试选区捕获。

### 11.3 通用优先

不得首先为 Codex、Qoder、Hermes、DSH 分别注入插件。

只要客户端正确暴露系统 Accessibility text selection，就使用同一套实现。

### 11.4 降级

若某应用无法读取 selected text：

一级降级：

- 用户选中文字后按全局快捷键；
- 尝试再次从 Accessibility 获取。

二级降级：

- 快捷键打开迷你 Capture Window；
- 用户粘贴文本。

三级策略：

- 记录该 App 为“不完全兼容”；
- V2/V3 决定是否值得做专用适配。

---

## 12. Setup Manager

Setup Manager 位于 Desktop Companion。

主界面建议分两部分。

### 12.1 Capture

```text
Browser Extension       已安装 / 未安装
macOS Accessibility     已授权 / 未授权
Desktop Capture         正常 / 需要处理
```

### 12.2 AI Connections

```text
ChatGPT / Codex    已连接 / 连接
Claude             已连接 / 连接
Cursor             已连接 / 连接
其他 MCP Client    查看设置
```

点击“连接”：

1. 显示能力说明；
2. 解释权限；
3. 准备必要 endpoint / 配置；
4. 打开平台官方设置 / 授权位置；
5. 用户完成授权；
6. 回到 Setup Manager；
7. 执行连接测试；
8. 更新状态。

Setup Manager 不保存第三方账户密码。

---

## 13. MCP V1

只提供少量高价值工具。

### capture_knowledge

输入文本和来源，调用 Knowledge Core Capture Pipeline。

### search_knowledge

搜索用户知识。

### get_knowledge_tree

读取一个知识树或子树。

### get_knowledge_node

读取节点。

### update_knowledge_node

修改节点基础内容。

### move_knowledge_node

移动节点。

### get_node_context

为 AI 对话返回指定 scope 的上下文。

MCP 工具不得直接暴露数据库 CRUD。

---

## 14. Node AI Conversation

### 14.1 UI

点击 Knowledge Node 后：

**与 AI 讨论**

### 14.2 Scope

V1 至少支持：

- current_node
- section
- tree

whole_library 可以保留接口，但不作为首屏默认。

### 14.3 Context Builder

默认包括：

- 当前 Node；
- 当前 Node 的 KnowledgeItems；
- Parent；
- 直接 Children；
- 高相关 Related Nodes；
- 必要 Source 摘要。

设置明确 token budget。

不得把整个数据库直接塞入模型上下文。

---

## 15. AI Provider Adapter

定义统一接口。

```ts
interface AIProvider {
  extractKnowledge(input: ExtractInput): Promise<ExtractResult>;
  classifyKnowledge(input: ClassifyInput): Promise<ClassifyResult>;
  embed(texts: string[]): Promise<number[][]>;
  chat(input: ChatInput): Promise<ChatResult>;
}
```

Knowledge Core 不允许直接 import 某一家 provider SDK。

V1 只需要完成一个生产可用 Provider。

---

## 16. Storage Repository

定义：

```ts
interface KnowledgeRepository {
  createRawSource(...): Promise<...>;
  createKnowledgeItem(...): Promise<...>;
  createNode(...): Promise<...>;
  findNode(...): Promise<...>;
  searchSimilar(...): Promise<...>;
  moveNode(...): Promise<...>;
}
```

V1 实现 SupabaseRepository。

未来 Local-first 新增本地实现，不修改上层业务行为。

---

## 17. Web App UI

### 17.1 主布局

三栏为默认参考：

```text
┌────────────┬──────────────────────────┬───────────────┐
│ 知识领域   │       Knowledge Tree     │   Node Detail │
│            │                          │               │
│ AI         │   Python                 │ Summary       │
│ 编程       │   ├─ 基础                │ Sources       │
│ 管理       │   ├─ 数据结构            │ Related       │
│ ...        │   └─ Async               │ AI Chat       │
└────────────┴──────────────────────────┴───────────────┘
```

中心区域必须是视觉重心。

### 17.2 V1 节点详情

只需要：

- title
- summary
- knowledge item count
- source count
- related nodes
- “与 AI 讨论”

V2 再加入：

- conflicts
- gaps
- history
- provenance detail
- inbox indicators

---

## 18. V1 免费云资源边界

V1 的目标是“无固定云成本即可开始开发”，不是承诺任何规模永久免费。

开发阶段：

- Vercel Hobby 可以承担 Web 和低流量 API；
- Supabase Free 可以承担早期 Postgres / Auth / Storage；
- 如果未来请求量、数据库、向量数量或执行时间超过免费额度，再升级。

模型调用费用独立于云托管费用。

因此代码必须支持：

- BYOK；
- provider 更换；
- 后续 local model。

---

## 19. 开发顺序

### Phase 0：项目初始化

1. Monorepo；
2. `PROJECT_MASTER.md`；
3. `V1_DEVELOPMENT.md`；
4. `FUNCTION_MAP.md`；
5. shared schema；
6. env management。

### Phase 1：数据层

1. Supabase project；
2. migrations；
3. pgvector；
4. Repository；
5. RawSource / Node / Item / Edge。

### Phase 2：Knowledge Core

1. Capture API；
2. AI Provider Adapter；
3. Extraction；
4. Embedding；
5. Similarity；
6. Classification；
7. Tree。

### Phase 3：Web App

1. 登录；
2. Tree；
3. Node Detail；
4. Search；
5. Node Chat。

### Phase 4：Browser Extension

1. selection；
2. floating button；
3. context menu；
4. source metadata；
5. capture result toast。

### Phase 5：Desktop Companion

1. Tauri shell；
2. Accessibility permission；
3. selected text observer；
4. floating overlay；
5. capture request；
6. fallback shortcut。

### Phase 6：Setup Manager

1. capture status；
2. permission guidance；
3. MCP client status；
4. authorization links / config assistance；
5. connection test。

### Phase 7：MCP

1. endpoint；
2. seven V1 tools；
3. auth；
4. client verification。

### Phase 8：Architecture Gate

只验证结构性正确性：

- RawSource 是否先保存；
- Extension / Desktop / MCP 是否都进入同一 Capture Pipeline；
- Knowledge Tree 是否可以稳定创建和移动；
- Repository 是否与 Supabase 实现解耦；
- AI Provider 是否解耦；
- MCP 是否通过 Knowledge Core 而非直接写库；
- Desktop Capture 是否不依赖单个 Agent；
- V2 数据模型是否无需推翻 V1。

---

## 20. V1 Done Definition

满足以下条件才可把 V1 功能写入 `FUNCTION_MAP.md` 的“已实现”：

### Browser

- 能选中文字；
- 能显示按钮；
- 能成功写入 Knowledge Core；
- 能获得归类结果。

### Desktop

- 获得系统授权后能在至少一类标准桌面文本客户端中捕获选区；
- 能弹出 Capture Button；
- 能成功写入 Knowledge Core；
- 存在快捷键降级。

### Core

- RawSource 永久保留；
- AI 失败不会丢原始数据；
- 能提取原子知识；
- 能分类；
- 能进行基础相似判断；
- 能生成知识树。

### App

- 首屏知识树；
- 节点详情；
- 节点 AI 对话。

### MCP

- MCP endpoint 可连接；
- V1 tools 可调用；
- Tool 不直接绕过 Knowledge Core。

### Setup Manager

- 可以检测 Capture 权限；
- 可以引导系统权限；
- 可以展示至少主要连接对象的状态；
- 授权流程不绕过平台确认。

---

## 21. V1 结束时的 FUNCTION_MAP 回写

本轮开发完成后必须：

1. 打开 `FUNCTION_MAP.md`；
2. 只按照真实实现状态更新；
3. 未联调成功的功能保持在“后续实现”；
4. V2 / V3 功能不得提前标为完成；
5. 保存后再结束开发任务。
