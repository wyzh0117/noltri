# 0.1.4 候选与发布检查

日期：2026-10-22（Asia/Shanghai）；状态：候选构建、正式安装版升级和 Graph UI gate 均完成。证据包与 SHA256SUMS 随 GitHub Release 提供。

## 源码与自动检查

- 基线 HEAD：`28c800336317651b3d1c9176810b0109b0f4f91b`（main，与 origin/main 同步）。
- Source-only freeze SHA-256：`97a90223521c42a76cc8203663f2ec618884112a9bd10926068194bbf1c24fea`。此摘要由基线 HEAD、按路径排序的改动源码／测试／构建版本配置文件路径和文件内容计算；包含 Cargo.lock 与未跟踪的 `node-taxonomy.ts`，不含文档和 Lighthouse 报告。
- `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm typecheck`：通过，Turbo 10/10。
- `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm test`：通过，Turbo 10/10，共 565 项；knowledge-core 148、desktop 30、API client 30、extension 139、storage 69、MCP server 19、AI service 15、AI provider 54、shared 61。schema 使用 `passWithNoTests`。
- `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm build`：通过，Turbo 2/2；desktop Vite 148 modules。
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`：通过，12/12；Cargo.lock 正常更新至 noltri-companion 0.1.4。
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`：通过。
- `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm --filter @noltri/extension package`：通过；manifest 0.1.4，ZIP 8 entries。
- `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm --filter @noltri/desktop release:mac`：通过。Node 24.18.0 arm64 sidecar checksum、app/runtime ad-hoc 签名、Node/SQLite/JIT、DMG CRC 与只读挂载后镜像内 app/runtime 检查均通过。`spctl` rejected；构建采用 ad-hoc 签名，未做 Apple 公证。

有非阻断提示：Vite 将来把 `configLoader: 'native'` 设为默认时，当前配置中的 `__dirname` 需迁移；Node SQLite API 显示 experimental warning。

## 候选资产

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `noltri-0.1.4-macos-arm64.dmg` | 46,151,537 | `8e719d974fc4784592480e078d6440f3934ac0628c2f1875456f8c9eed1d2654` |
| `noltri-0.1.4-macos-arm64.zip` | 45,300,345 | `00542a9a1370dfd2fb3f8527e5b2b82d5ce38ecf4f5a873cb0b9ee7e2f79bc60` |
| `noltri-extension.zip` | 622,650 | `99c1ab76857bfba715252636693e8db2530489098e6547b1a16d742a564b5a9a` |

DMG 来自 `release:mac` 输出；app ZIP 由同一候选 `.app` bundle 创建。DMG `hdiutil verify` 通过；app ZIP（32 entries）和 extension ZIP（8 entries）`unzip -tq` 通过。Info.plist 与 extension manifest 均为 0.1.4；app 和 runtime Mach-O 均为 arm64。

候选 app 中 `main-DT-f2E1U.js` 的 SHA-256 为 `972fef7e1ab0e03c21d04dbf94a85da40563f31369206509290123e687f1c5ea`，`main-BjTal5WU.css` 为 `c2d22f4b0a95abadfd0ef7b87979ba22b35e6e7cca4f27b31228688e23cce263`。从 Tauri Brotli 资源解压后与当前 `apps/desktop/dist/assets/` 文件逐字一致；对应压缩资源字节也实际位于候选 app 可执行文件中。

## 隐私与密钥扫描

对候选 app ZIP、extension ZIP 和只读挂载的 DMG 检查条目路径与文件内容。未发现 SQLite／DB、`settings.json`、`.env*`、用户 profiles、Lighthouse 报告、PEM／KEY 文件路径；未发现 OpenAI／GitHub token 或私钥 PEM 模式。Node runtime 中有 5 个 AWS key 形状字符串，均位于同一严格 base64 流（3,720,180 字符）内；解码 2,790,134 字节后所有凭据／私钥模式均无命中，判定为已知二进制内容误报。扫描未输出任何候选密钥值。

两个根目录 Lighthouse 报告未纳入发布资产，保持未跟踪状态。所有被检查的候选文件均与本次正式安装使用的候选一致；升级安装 executable 与 app ZIP executable SHA-256 相同。
