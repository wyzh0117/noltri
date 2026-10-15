# 0.1.1 分类验收

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
