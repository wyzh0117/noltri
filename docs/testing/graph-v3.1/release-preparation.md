# v0.1.3 发布准备记录（2026-10-21）

状态：**v0.1.3 最终构建和验收已闭环。** 全仓自动门槛、独立 FE focused 复验、extension/macOS 构建、签名／DMG 校验、包内安全扫描和 evidence ZIP 均完成。最终五项资产只取 `.local/releases/0.1.3-final-20261021/` 中的文件；GitHub Release 资产与提交后远端状态将在发布后复核。

## 最终构建（2026-10-21）

| 命令／检查 | 结果 |
| --- | --- |
| PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm typecheck | 通过，Turbo 10/10 tasks。 |
| env PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm test | 通过，Turbo 10/10 tasks，共 **563 tests**：shared 61、API client 30、extension 139、storage 69、desktop 30、knowledge core 146、MCP server 19、AI service 15、AI provider 54；schema 无测试文件并由 passWithNoTests 通过。 |
| cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml | 通过，12/12。 |
| cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check | 通过。 |
| PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm build | 通过，Turbo 2/2 build tasks；desktop Vite 148 modules。 |
| PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm --filter @noltri/extension package | 通过，manifest 校验与 ZIP 生成通过。 |
| PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm --filter @noltri/desktop release:mac | 通过，Node 24.18.0 arm64 sidecar checksum、app/runtime ad-hoc 签名、DMG CRC、镜像内 app/runtime 签名及随包 Node/SQLite/JIT 自检通过。首次 sandbox 调用在 DMG 脚本处失败，按授权以 require_escalated 重跑同一命令后 exit 0。 |
| git diff --check | More 修复与最终文档更新后通过。 |

构建资源为 `apps/desktop/dist/assets/main-DT-f2E1U.js`（SHA-256 `972fef7e1ab0e03c21d04dbf94a85da40563f31369206509290123e687f1c5ea`）和 `main-BjTal5WU.css`（`c2d22f4b0a95abadfd0ef7b87979ba22b35e6e7cca4f27b31228688e23cce263`）。FE focused 页面实际加载的 JS/CSS 名称及 SHA-256 与此完全一致；独立 asset reviewer 从 app 可执行文件提取 Brotli 资源并确认解压后的 JS 与当前 dist 逐字相同。

最终资产暂存于 `.local/releases/0.1.3-final-20261021/`：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| noltri-0.1.3-macos-arm64.dmg | 46,151,243 | f39d312c4110bc5f751b1c4707bc33354cf9871d26a82915d9ba2bc6869e8df8 |
| noltri-0.1.3-macos-arm64.zip | 45,300,118 | 9cbd0ba945fa660c6d07aab357590430f8037ef18a0577b5743fef027344c77b |
| noltri-extension.zip | 622,650 | 89d7275b0adec455c926d65517ecdd28ba7dda8c4ebc18320379b2f6a42d6301 |

app ZIP（32 entries）及 extension ZIP（8 entries）`unzip -tq` 均通过；app 和 extension manifest 版本均为 0.1.3，app 架构 arm64。路径扫描未匹配 SQLite/DB、settings.json、.env*、profiles、Lighthouse 报告、PEM/KEY 文件名；ZIP 内容扫描未发现 OpenAI/GitHub token 或私钥。AWS AKIA 字符串扫描在 `noltri-runtime` 二进制内出现 5 个命中，均位于一个 3.72 MB strict-base64 编码流；解码 2.79 MB 后，AWS/OpenAI/GitHub/private-key 模式均无命中，确认为二进制扫描误报。DMG 由本轮 `release:mac` 挂载复核签名、Node/SQLite/JIT 并通过 `hdiutil verify`。未把两个根目录 Lighthouse 报告、用户资料库、生产数据库、设置或演示数据装入资产。签名为 ad-hoc，Gatekeeper 的 `spctl` 结果 rejected；不代表 Apple 公证。

独立验收记录：[验收矩阵](acceptance.md)、[前端复核](frontend-review.md)。`noltri-0.1.3-test-results.zip` 收录本轮测试说明、Graph v3.1 验收目录及相对链接资源、发布说明和原名原路径开发指南；70 个 archive entries 的 ZIP integrity 通过，14 份 Markdown 的本地链接均可解析，文本 evidence 未发现常见 token／私钥模式。SHA256SUMS 校验 DMG、app ZIP、extension ZIP 与 test-results ZIP 四项内容。SHA256SUMS 自身的 SHA-256 不放入自身清单，发布操作结果单独记录。

## 上一快照的检查

| 命令 | 结果 |
| --- | --- |
| PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm typecheck | 通过，Turbo 10/10 tasks。变量跳过 pnpm 11 的依赖目录自动重装自检；未安装或升级依赖。 |
| env PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm test | 通过，Turbo 10/10 tasks，共 562 tests：shared 61、API client 30、extension 139、storage 69、desktop 29、knowledge core 146、MCP server 19、AI service 15、AI provider 54；schema 无测试文件并由 passWithNoTests 通过。 |
| cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml | 通过，12/12。 |
| cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check | 通过。 |
| PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm build | 通过，Turbo 2/2 build tasks；desktop Vite 148 modules。有既有 __dirname 未来 Vite configLoader native 兼容性提示。 |
| PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm --filter @noltri/extension package | 通过，manifest 校验和 ZIP 生成通过。 |
| env PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm --filter @noltri/desktop release:mac | 上一快照完整重跑 exit 0；Node 24.18.0 sidecar checksum、app/runtime ad-hoc 签名、DMG CRC、DMG 内 app/runtime 签名及随包 Node/SQLite/JIT 自检通过。 |
| env PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm --filter @noltri/desktop verify:mac | 上一快照验证通过。spctl rejected；这是 ad-hoc 签名且未做 Apple notarization 的预期结果。 |
| git diff --check | 通过。 |

pnpm test 逐包合计是 562，不使用旧的 548/558 数字。最新桌面 Vite 资源文件名为 main-CNMyiAbG.js，SHA-256 为 fb7968591fcaf2be1415e2a8b190b1977f6dfabf95f76d8e202c28c9532f1fa8；与 A11 QA preview 记录一致。Tauri app 内未单独落盘该 JS 文件，前端资源由 Tauri 构建嵌入 app。

## 版本一致性和候选资产快照

本轮 11 个活跃 workspace package.json、Tauri 配置/Cargo、Cargo.lock 的 noltri-companion、extension manifest、Core/MCP runtime fallback 与 app Info.plist 均核对为 0.1.3；原生可执行架构是 arm64。README 和 docs/testing/README.md 要求 pnpm typecheck/test、Cargo test/fmt 与 macOS release build。未发现贡献文档要求额外运行 root pnpm gate，因此没有仅因脚本存在而增加该门槛。README 已链接原名原路径 Noltri_大模型开发指南_20261020.md、Graph v3.1 测试说明与独立验收记录。

上一候选保留于本机 .local/releases/0.1.3-final-candidate-20261021/，现已过期，禁止拿去发布：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| noltri-0.1.3-macos-arm64.dmg | 46,151,051 | 20d80011b02e3d14013817f16f3bb1ec5994ef200030389c98f6c44475f6a53f |
| noltri-0.1.3-macos-arm64.zip | 45,299,869 | 3a50f57fd90b409e37b40a1c38ef82c8764b7a7ca6e0bfcd80f60a6e6c07927f |
| noltri-extension.zip | 622,650 | fe5b7524fa4e5e0e0b5ade65846d12747821a25fd3dba5efb97b612384386791 |

上一快照的 app ZIP/extension ZIP 分别有 32/8 个条目，unzip -tq 通过；DMG 的 hdiutil verify 通过；release:mac 已挂载复核镜像内 app/runtime。文件名扫描未发现 SQLite/DB、settings.json、.env*、用户 profiles、Lighthouse 或私钥；常见 sk-proj-*、长 sk-*、ghp_* 和私钥 PEM header 内容扫描无匹配。此次根目录两个 Lighthouse 报告未打入资产。

未生成测试证据 ZIP 或 SHA256SUMS.txt；最终代码冻结与独立验收文档更新后再重建、复扫并生成，避免把上一快照证据当成最终包。

## 验收范围与发布限制

当前独立验收文档记录 Graph v3.1 A01–A14 通过；指南 A15/A16 属于原阶段缺项，整项未通过。More 面板入口的 FE focused 复验已通过，相关证据及当前测试 bundle hash 见 [前端复核](frontend-review.md) 和 [验收矩阵](acceptance.md)。

发布说明应如实保留这些边界：40,000 JavaScript 字符正文上限；260 节点绘制上限但搜索可覆盖全量范围；selected 长标题在画布边缘可能裁切；F05 覆盖／缺口诊断未实现，F06 桌面入口未实现；桌面修改历史读取不完整。A15/A16 的部分基线能力不写成完整通过。ad-hoc 签名和未公证事实及首次打开说明继续保留。

Graph v3.1 新增 notes 表及索引（storage schema v7）；v6 → v7 迁移 fixture 验证保留原来源、nodes、edges、knowledge items 和 links，没有改写这些旧记录。Graph API 通过稳定 ID 关联，没有 body/relations 迁移。

最终发布说明保留自动化和手工验收边界；A15/A16、40,000 字正文上限、260 节点绘制上限、selected 长标签边缘裁切、F05/F06 缺项、修改历史读取不完整及 ad-hoc 未公证情况均如实列明。
