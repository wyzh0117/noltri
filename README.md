<div align="center">
  <h1>知序 Noltri</h1>
  <p>把网页、Agent 与论文摘录，收进一棵自己的知识树。</p>
</div>

[English](README.en.md)

## 项目介绍

知序是一款本机运行的个人知识库。你可以从网页、Agent 对话和论文中收集片段，再按学科整理、搜索和对比。资料默认保存在自己的电脑上。

## 快速开始

知序 0.1.0 目前提供 Apple Silicon（arm64）版本，要求 macOS 13.5 或更新版本。下载 [macOS 安装包](https://github.com/wyzh0117/noltri/releases/latest)，打开磁盘映像后把“知序”拖到“Applications”文件夹。

此版本尚未通过 Apple 公证。若 macOS 提示无法验证开发者，请先确认文件来自本项目的 Releases；尝试打开后进入“系统设置”→“隐私与安全性”→“仍要打开”，再确认“打开”。更多说明见 [Apple 官方指引](https://support.apple.com/en-us/102445)。

### 从源码运行

从源码运行需要 Node.js 20.19+ 或 22.12+、pnpm 11、Rust 工具链和 Xcode Command Line Tools。

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

知序桌面窗口会自动打开。首次运行使用本机 SQLite 保存资料，并采用离线模式；不填 AI 密钥也能收集和整理内容。

如需使用 DeepSeek 自动整理内容，可在 `.env.local` 中填写自己的设置：

```dotenv
AI_PROVIDER=openai
AI_API_KEY=填入你自己的密钥
AI_BASE_URL=https://api.deepseek.com
AI_CHAT_MODEL=deepseek-flash
AI_EMBEDDINGS_ENABLED=false
```

安装版如需启用 AI，请把这些设置写入 `~/.noltri/.env.local`；从源码运行则写入仓库根目录的 `.env.local`。修改后重启知序。

### 安装浏览器扩展

从 [0.1.0 Releases](https://github.com/wyzh0117/noltri/releases/latest) 下载并解压 `noltri-extension.zip`。也可以从源码构建：

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

每条资料都会保留原文和来源。知序把收集到的内容整理成便于浏览的摘要和研究点，再按学科归类到知识树中；你可以调整分类、搜索资料，并把相关内容并排对读。

## 可以做什么

- 从网页选中文字，连同标题和链接一起收进资料库；
- 收集时可输入“社会科学 / 经济学 / 因果推断”这样的路径，直接创建学科树并完成归类；
- 让 Codex 等 Agent 通过 MCP 保存回答或研究线索；
- 收集论文段落，记录引用和研究方向；
- 按知识树浏览、搜索、整理和比较资料。

## 示例

读论文时收集两篇文章关于同一研究问题的段落。知序会保留各自的来源，放进相应学科下；之后打开并排比较，就能快速查看两种方法和结论的异同。

## License

仓库当前没有提供 LICENSE 文件，使用、修改和再发布的授权方式尚未声明。
