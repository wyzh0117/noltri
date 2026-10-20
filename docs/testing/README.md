# 0.1.3 Graph v3.1 发布验收

Graph 的独立验收矩阵见 [A01–A16 记录](graph-v3.1/acceptance.md)。A01–A14 的真实界面／HTTP／SQLite 路径和三个 More 入口的 FE focused 独立复验均通过；A15/A16 是指南 §6 原阶段能力，整项未通过，不计为本轮通过。冻结构建与资产扫描、证据 ZIP 和 SHA256SUMS 已完成，具体清单见 [发布准备记录](graph-v3.1/release-preparation.md)。

最终 v0.1.3 全仓结果：PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm typecheck 通过（Turbo 10/10）；env PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm test 通过（Turbo 10/10，**563 tests**：shared 61、API client 30、extension 139、storage 69、desktop 30、knowledge core 146、MCP server 19、AI service 15、AI provider 54；schema 无测试文件并 passWithNoTests）；cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml 为 12/12，cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check 通过；pnpm build 为 2/2 tasks、desktop Vite 148 modules；extension package 与 macOS release:mac 签名完整性、DMG CRC、Node/SQLite/JIT 检查通过。版本资源、资产清单和 SHA-256 见 [发布准备记录](graph-v3.1/release-preparation.md)。

正文持久化采用 schema v7 新增的 knowledge_notes 表和索引；v6→v7 fixture 验证旧来源、nodes、edges、knowledge items 和 links 保留。正文上限 40,000 JavaScript 字符。Graph 最多绘制 260 个节点，但全范围仍参与搜索；极长 selected label 在画布边缘会裁切。A15/A16 的原阶段缺项、F05/F06 桌面未实现部分和修改历史读取限制详见 [发布说明](../releases/0.1.3.md)。最终构建采用 ad-hoc 签名，未做 Apple Developer ID 签名或公证。

# 0.1.2 模型服务验收

状态：自动化检查、隔离 managed-runtime 协议/重启验证、built-UI headless 流程和 CSS 修正后的最终 macOS bundle/DMG 复核通过。原生 GUI 自动化未执行：System Events 对候选进程返回 macOS 错误 `-10827`，CUA 通道此前超时；没有操作已安装应用或其配置。

- Provider 流程：从 Provider 管理添加配置，检查 provider id/name、Base URL、只写 API Key 和三种协议（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages）。Fetch Available Models 应将候选留在草稿；选中后 Add selected 加入草稿；手动 Add Model 可设置 ID、显示名、上下文长度、最大输出及 text/image 输入能力；Apply 才保存草稿。
- 当前模型：Apply 普通配置不得改变活动模型。“使用此模型”应保存全局活动模型；刷新与重启后仍选中该模型，之后的真实 AI 请求应使用其协议、Base URL、凭据和模型 ID。删除活动 provider/model 后应明确清空活动模型，不自动回退到默认模型。
- 边界：验证空候选、Fetch 失败、重复模型 ID、删除 provider 的名称确认、确认弹窗取消及丢弃未保存草稿；按钮应显示加载状态并在请求结束后恢复。
- 隔离：使用临时 `NOLTRI_SETTINGS_DIR`、`NOLTRI_DATA_DIR` 和本地兼容 API mock，避免访问用户配置、资料库或真实模型账单。GUI 验收应运行 packaged managed Core；`pnpm dev` 的开发 Core 由外部终端管理，不能证明自动应用模型配置。
- 隔离 runtime 结果：[0.1.2-runtime-results.json](0.1.2-runtime-results.json)。三个协议的真实 HTTP 路由、模型 ID、128 输出 token 上限和假凭据匹配均通过；Anthropic 同时验证 `anthropic-version`。完整退出并重启后，活动 `qa-anthropic/mock-anthropic` 仍保留，且继续发出 `/v1/messages` 请求。测试使用临时 settings/data 目录和本地 mock，不接触外部 provider；请求体与凭据值均未记入证据。
- 界面：[0.1.2-ui-results.json](0.1.2-ui-results.json) 记录 headless Chrome 对构建后桌面 UI 与 mock Tauri bridge 的 12 项断言：模式草稿、Fetch/搜索/选择/添加、重复模型 ID 拦截、Apply 不自动 Use、显式 Use、取消确认、删除确认与清除 active、loading 禁用与恢复、空/失败 Fetch 和重试、API key 保留/清除语义均通过。卡片操作区和 active badge 的矩形不重叠，编辑/删除按钮中心点均命中按钮。三张截图保留于本次临时目录 `/private/tmp/noltri-ui-mock-qa/`，未提交仓库。
- 限制：headless bridge 不是原生 Tauri GUI。原生 System Events/CUA 点击未完成，因此不能宣称原生 GUI 已验收。

自动检查结果：`PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm typecheck` 10/10 workspace packages 通过；同一环境下 `pnpm test` 10/10 packages 通过（531 tests；schema package 无测试文件）。`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` 12/12 通过，`cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` 与 `git diff --check` 通过。pnpm 环境变量仅跳过 pnpm 11 的依赖目录自动重装自检，未安装或升级依赖。历史真实付费 API 脚本未运行。

macOS 最终 CSS 修复版构建及 bundle/DMG 验证通过。`pnpm --filter @noltri/desktop release:mac` 与 `verify-macos` 均 exit 0；app 版本为 0.1.2，app/Node 签名检查通过，extension 为 0.1.2 且包含 8 个文件，staging 未发现 secrets、数据库或 settings。CSS 修复前后随包 Core/MCP resource hash 一致，因此上方隔离 runtime 证据适用于最终包。该验证不代表 Apple 公证。

# 0.1.1 分类验收（历史记录）

使用真实 DeepSeek API 与应用随包 Core，经过 HTTP 收集、SQLite 持久化、读取与人工编辑完整流程。测试输入和结果不含 API 密钥；本地模型配置不提交 Git，也不打入安装包。

- 输入：[classification-cases.json](classification-cases.json)，5 种语言（Python、TypeScript、Rust、Go、SQL）和 4 个科研领域（物理、计量经济学、分子生物学、心理学）。每条保留官方文档或原论文链接，论文只取短摘录。
- 分类模型：`deepseek-flash`（2026-10-15 通过真实 `/models` 查询验证可用）。
- 结果：[0.1.1-deepseek-results.json](0.1.1-deepseek-results.json)，保留实际分类路径、原文、摘要、来源、接口结果与耗时。
- 人工编辑：修改分类路径、研究点、原文和标题，再读取验证；随后恢复示例原值。
- 本地保留：验收前备份原有资料库，测试卡片加入已安装应用的资料库，重启后仍可浏览；发布安装包不含本机资料库。

先在桌面设置配置模型并保存启用，再运行：

```bash
node apps/desktop/scripts/test-classification.mjs
```

脚本要求服务版本为 0.1.1、provider 为 `openai-compatible`，交替经过 `/api/items` 和 `/api/capture`，覆盖分类省略与空数组两种输入。成功标准是已完成分类、路径至少两层，并匹配预期领域关键词；这是一组小样本回归验收，不能视为跨领域准确率基准。重跑会复用原卡片；如需强制重新调用模型，请使用新的测试 profile/资料库。

模型首屏、表单与下拉已实现，并经过 TypeScript/Rust 校验；本轮本机模型配置使用 profile 文件和安装版应用重启验收，桌面自动化连接超时，未执行 GUI 点击验收。切换第二模型和重启保留的证据见 [0.1.1-runtime-results.json](0.1.1-runtime-results.json)。

自动检查运行 `pnpm typecheck`、`pnpm test` 和 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。macOS 构建用 `pnpm --filter @noltri/desktop release:mac`，其中会校验 DMG、应用与随包运行时签名，并运行 Node SQLite/JIT 检查。未公证版本的 Gatekeeper 拒绝会如实显示；`verify:mac --require-notarization` 才要求 Apple 接受。
