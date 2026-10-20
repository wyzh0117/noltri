<div align="center">
  <h1>知序 Noltri</h1>
  <p>把网页、Agent 与论文摘录，收进一棵自己的知识树。</p>
</div>

[English](README.en.md)

## 项目介绍

知序是一款本机运行的个人知识库。你可以从网页、Agent 对话和论文中收集片段，再按学科整理、搜索和对比。资料默认保存在自己的电脑上。

## 快速开始

知序 0.1.3 面向 Apple Silicon（arm64），要求 macOS 13.5 或更新版本。下载 [macOS 安装包](https://github.com/wyzh0117/noltri/releases/latest)，打开磁盘映像后把“知序”拖到“Applications”文件夹。

0.1.3 增加知识主题与章节的直接阅读编辑、按学科范围浏览关系图，并保留正文自动保存与本机草稿恢复。0.1.2 的 Provider 管理继续支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages，可拉取或手动添加模型；Apply 保存配置，“使用此模型”选择自动处理内容时使用的模型。当前发布采用 ad-hoc 签名，**尚未通过 Apple Developer ID 签名和公证**，macOS 仍可能拦截首次打开。请先对照 Releases 中的 `SHA256SUMS.txt` 校验下载文件，再按 [Apple 官方指引](https://support.apple.com/en-us/102445)进入“系统设置”→“隐私与安全性”→“仍要打开”。

若系统仍显示“已损坏”，确认下载来源和校验值后，可仅为此应用解除下载隔离：

```bash
codesign --verify --deep --strict "/Applications/知序.app"
xattr -dr com.apple.quarantine "/Applications/知序.app"
open "/Applications/知序.app"
```

只有第一条验签成功后才执行后两条。正式免拦截分发仍需 Developer ID 证书和 Apple 公证，详见 [Tauri macOS 签名文档](https://v2.tauri.app/distribute/sign/macos/)。

### 从源码运行

从源码运行需要 Node.js 20.19+ 或 22.12+、pnpm 11、Rust 工具链和 Xcode Command Line Tools。

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

知序桌面窗口会自动打开。进入 Provider 管理后，可添加服务商配置，拉取候选模型或手动添加模型，再 Apply 保存。模型配置支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages；选择“使用此模型”可在处理资料前设定全局活动模型。API 密钥仅保存在本机设置中。模型管理可随时从知识库设置中打开。

安装版保存设置后会自动重启由应用管理的本机服务。使用外部服务或从源码开发时，页面会提示重启服务，需将相同设置写入 `.env.local`：

```dotenv
AI_PROVIDER=openai
AI_API_KEY=填入你自己的密钥
AI_BASE_URL=https://api.deepseek.com
AI_CHAT_MODEL=deepseek-flash
AI_EMBEDDINGS_ENABLED=false
```

Provider 配置保存在 macOS 的 `~/Library/Application Support/com.noltri.companion/settings.json`。自动知识体系分类需要选择活动模型；未配置或调用失败时保留原文，供稍后重试与人工整理。

### 安装浏览器扩展

从 [Releases](https://github.com/wyzh0117/noltri/releases/latest) 下载并解压 `noltri-extension.zip`。也可以从源码构建：

```bash
pnpm --filter @noltri/extension build
```

在 Chrome 打开 `chrome://extensions`，开启「开发者模式」，选择「加载已解压的扩展程序」，再选解压后的文件夹（从源码构建时选择 `apps/extension/.output`）。浏览网页时右键选择“收集选中内容到知序”“收集此网页到知序”或“收集此图片到知序”，即可连同来源一并保存。

### 连接 Codex 或其他 Agent

打开知序桌面应用或运行 `pnpm dev` 后，在 Codex 的 MCP 设置中添加本地 Streamable HTTP 服务；也可以写入 `~/.codex/config.toml`：

```toml
[mcp_servers.zhixu]
url = "http://127.0.0.1:8790/mcp"
```

保存后重启 Codex。其他 Agent 也可以使用知序设置页提供的入口地址。若客户端只支持 stdio，可从仓库根目录启动：

```toml
[mcp_servers.zhixu]
command = "pnpm"
args = ["--filter", "@noltri/mcp-server", "exec", "tsx", "src/stdio.ts"]
cwd = "/你的知序仓库绝对路径"
env = { KNOWLEDGE_API_URL = "http://127.0.0.1:8787" }
```

可参考 [Codex MCP 设置说明](https://developers.openai.com/codex/mcp)。

## 工作方式

每条资料都会保留原文和来源。配置模型后，AI 根据片段内容判断知识体系和分层学科路径，并生成摘要。你可以在资料详情中修改内容、标题、分类和研究点；手动指定的分类优先保留。调用失败时保留原文，不把摘录标题冒充 AI 分类。你还可以搜索资料，并把相关内容并排对读。

## 可以做什么

- 从网页选中文字，连同标题和链接一起收进资料库；
- 收集时可输入“社会科学 / 经济学 / 因果推断”这样的路径，直接创建学科树并完成归类；
- 让 Codex 等 Agent 通过 MCP 保存回答或研究线索；
- 收集论文段落，记录引用和研究方向；
- 按知识树浏览、搜索、整理和比较资料。

## 示例

读论文时收集两篇文章关于同一研究问题的段落。知序会保留各自的来源，放进相应学科下；之后打开并排比较，就能快速查看两种方法和结论的异同。

## 验证与构建

0.1.1 的真实 DeepSeek 分类验收覆盖 Python、TypeScript、Rust、Go、SQL 及物理、计量经济学、分子生物学、心理学论文短摘录；片段附原始出处。见[测试说明](docs/testing/README.md)及[结果](docs/testing/0.1.1-deepseek-results.json)。0.1.2 的自动检查、隔离协议与重启测试、构建后 UI mock bridge 流程记录在同一测试说明中。0.1.3 的 Graph v3.1 依据[开发指南](Noltri_大模型开发指南_20261020.md)实现；本轮 563 项自动测试与 Rust 12/12 通过，A01–A14 及 More 入口真实 UI 验收通过，A15/A16 原阶段能力仍未完成。检查及范围见[测试说明](docs/testing/README.md)、[验收记录](docs/testing/graph-v3.1/acceptance.md)和[发布说明](docs/releases/0.1.3.md)。本地测试资料不随安装包分发。

```bash
pnpm typecheck
pnpm test
pnpm --filter @noltri/desktop release:mac
```

构建脚本校验固定版本 Node 24 运行时的 SHA256，生成应用后检查资源封印、DMG 完整性、随包 SQLite 与 JIT。具备签名和公证凭据的正式分发还需通过 `pnpm --filter @noltri/desktop verify:mac --require-notarization`。

## License

仓库当前没有提供 LICENSE 文件，使用、修改和再发布的授权方式尚未声明。
