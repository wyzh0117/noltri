<div align="center">
  <h1>知序 Noltri · Notes 0.1</h1>
  <p>用本地 Markdown 写作和阅读，把收集的原件留在自己手中。</p>
</div>

[English](README.en.md)

## 当前版本

当前源码版本为 **0.1.0**，以 Markdown Notes 为主线。首发采用手动安装；本地构建候选尚未发布，正式工件与校验值以对应的 [Release](https://github.com/wyzh0117/noltri/releases) 为准。0.1.0 不提供签名 updater 工件或 `latest.json` 更新清单。历史版本仍保留为历史记录。

旧课程产品线不再维护，也不提供课程工作区迁移或兼容承诺。历史版本、已验证工件和原有数据均保留，不会因本轮版本调整而删除。

## 从源码开始

需要 Node.js 24（本轮验证 24.18.0）、pnpm 11、Rust 和 Xcode Command Line Tools。桌面目标为 Apple Silicon macOS 13.5 或更新版本。

```bash
pnpm install
cp -n .env.example .env.local
```

先在 `.env.local` 中将 `NOLTRI_DEV_TOKEN` 与 `NOLTRI_ACCESS_TOKEN` 填为同一非空本机令牌，并在启动桌面的终端显式导出同值的 `NOLTRI_ACCESS_TOKEN`。Rust 不解析 dotenv；Core/MCP 只读取明确选择的环境文件，且不覆盖已有进程环境。然后运行：

```bash
NOLTRI_ENV_FILE="$PWD/.env.local" pnpm dev
```

Notes 以本地 Markdown Vault 为正文来源，提供编辑、阅读、标题思维导图、搜索、属性和历史。关系页查看图谱与链接；解读页只有明确点击翻译、解释或提问时才发送当前正文快照，结果临时显示，不覆盖原文。

快速收集支持文字、图片和桌面截图入口。待确认资料保留原件，将处理状态与人工审核分开；编辑整理文本不会修改原文。 已确认资料单独显示确认时保存的人工稿和归档方向；缺失人工确认记录时明确提示，原文仍可查看。图片识别需要明确配置支持图像的模型，离线保存不等于完成识别或分类。规则与处理记录在独立窗口中管理，保存规则草稿不会自动生效。详见[模块说明](docs/modules.md)。


Core 默认端口为 **18887**，MCP 为 **18890**。未指定 `NOLTRI_ENV_FILE` 时，仅探测 `~/.noltri-notes/.env.local`、`.env` 及显式 `NOLTRI_DATA_DIR` 中的同名文件；不向上查找项目配置。指定文件即为独占选择，缺失也不回退。桌面默认不复用已运行的外部服务；仅明确设置 `NOLTRI_USE_EXTERNAL_RUNTIME=1`、提供一致令牌并通过服务验证后才可连接。

## Notes profile

桌面 bundle identifier 为 `com.noltri.notes`。0.1.0 使用 macOS Notes profile 的既有默认位置；手动替换已有安装前，请备份数据并确认 profile 归属。旧课程产品线不自动迁移或导入：

| 运行方式 | 默认位置 |
| --- | --- |
| macOS 安装版 | `~/Library/Application Support/com.noltri.notes/`，包括 `settings.json` 和本机数据 |
| 从源码运行 Core | `~/.noltri-notes/data/`，数据库为 `noltri.sqlite`，默认 Vault 为 `vault/` |

新默认位置与旧产品线分离，不自动导入旧库。`NOLTRI_DATA_DIR`、`NOLTRI_SQLITE_FILE`、`NOLTRI_NOTES_DIR` 和桌面的 `NOLTRI_SETTINGS_DIR` 显式设置继续有效；指定路径前请确认数据归属，不兼容数据库仍会被拒绝而不自动改写。连接外部 Core 时应先核对服务与 profile，独立的桌面目录不能替代对外部连接的确认。

## 模型与收集入口

Provider 管理支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。添加服务商与模型后明确保存，再选择“使用此模型”。密钥仅保存在本机设置中；未配置或请求失败时保留原件，供稍后重试或人工整理。

安装版会重启由应用管理的服务以应用模型配置；外部／开发服务需要维护对应环境配置并自行重启。`.env.example` 只提供空白模板，真实密钥不要提交到仓库。

桌面设置可配置截图与收集窗的全局快捷键，冲突或保存失败时保留旧配置。同一配置目录只允许一个宿主启动服务；显式隔离的配置目录可独立运行。规则调试窗可刷新本应用及自有 Core/MCP 的进程诊断。详见[模块说明](docs/modules.md)。

浏览器扩展可从当前源码构建：

```bash
pnpm --filter @noltri/extension build
```

在 Chrome 的 `chrome://extensions` 中开启开发者模式，加载 `apps/extension/.output`。通过右键菜单收集选中文字、网页或图片。Agent 可以连接应用设置页提供的本机 MCP 入口；默认开发地址为 `http://127.0.0.1:18890/mcp`，授权范围仍由本机服务控制。

## 安装与更新

0.1.0 通过手动 DMG 安装，不含签名更新归档、签名文件或 `latest.json`。本版没有可用的应用内更新源；检查更新遇到缺失清单时会安全失败，不能把该错误视为“已是最新版本”。未来签名更新流程仍要求明确检查、下载验证、安装和重启，详见[应用内更新](docs/application-updates.md)。

3.0.0 的隔离采集与更新验收仅适用于对应历史构建，不代表 0.1.0 已通过同等产品验收。0.1.0 候选完成了本机应用／DMG 完整性检查；未完成完整产品验收、真实模型或 OCR 测试。当前构建为 ad-hoc 签名，没有 Apple Developer ID 签名或公证；构建主机的 Gatekeeper assessment 已关闭，因此无法在该主机上判断 Gatekeeper 接受结果。详见 [0.1.0 版本说明](docs/releases/0.1.0.md)。

将来下载发行工件时，请先核对发布来源、校验值及签名说明。macOS 首次打开受阻时，请遵循 [Apple 官方安全打开应用指引](https://support.apple.com/en-us/102445)。更新包验签与 Apple Developer ID 签名、公证及系统授权是不同机制。

## 开发验证

安装 Rust 的 `wasm32-unknown-unknown` 目标；前端浏览器测试还需要本机 Chrome/Chromium，可通过 `CHROME_BIN` 指定可执行文件。先构建忽略的 WASM 产物，再做检查。

```bash
rustup target add wasm32-unknown-unknown
pnpm --filter @noltri/desktop build:graph-wasm
pnpm typecheck
pnpm test
```

构建、历史项目更新签名及限定平台验收已有记录。当前候选验证范围与剩余限制记录在 [0.1.0 版本说明](docs/releases/0.1.0.md)；[3.0.0 说明](docs/releases/3.0.0.md) 是历史记录。随包 Node 运行时保持固定版本和校验，不分发内部计划、测试资料或用户配置。

## License

仓库当前没有提供 LICENSE 文件，使用、修改和再发布的授权方式尚未声明。依赖信息见[第三方声明](THIRD_PARTY_NOTICES.md)。
