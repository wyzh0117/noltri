# Core 独立安全复核

复核范围：`services/knowledge-core/src/notes/{path,markdown,parser,search,vault}.ts`、相关 HTTP 边界与测试。Core 由 architecture 实现；此处按静态调用链和已有真实文件系统/HTTP 检查复核，不把 API-client 层（由本复核者改过）算作独立验收。结论仅适用于本轮 macOS 本机目标；Windows 原生文件系统行为未测。

## 已确认的安全与一致性路径

| 范围 | 复核结果 | 证据与边界 |
|---|---|---|
| Vault 根和路径 | 已覆盖 traversal 与符号链接出界防护。Vault root 在初始化时 `realpath` 固定；路径先统一 `\`/NFC/NBSP、拒绝绝对路径、盘符与 `..`，再逐组件 `lstat` 拒绝符号链接。扫描器把归一化逻辑路径映射到磁盘上的实际 NFD/NBSP 拼写。 | `notes/path.ts`、`Vault.safePath()` / `scanDirectory()`；`vault-core.test.ts` 覆盖 `../`、symlink escape、大小写/NFC/NBSP 与物理拼写复用。Windows 原生大小写/Unicode 矩阵未测。 |
| 路径碰撞 | 本轮增加的 prefix 检查覆盖已有父目录大小写/Unicode 冲突，不只检查最终文件名；create-folder、write parent 与 rename target 均调用 `assertPathSpelling()`，失败发生在写磁盘之前。 | `vault-core.test.ts` 的 “rejects case-folded parent components before create or move…” 检查 NFD/NBSP 实际路径复用、大小写父目录拒绝和零磁盘变化。当前 macOS 临时 FS 已测。 |
| 普通文件保存 | 服务端以内容 SHA-256 作为 etag；create-only 已存在时仅对完全相同正文返回当前文件，否则冲突；更新必须携带匹配 etag，并在原子替换前再次读取磁盘内容。create-only commit 使用同目录 hard-link `link(temp,target)`，EEXIST 时不覆盖并返回冲突。 | `writeFileInternal()` / `atomicWrite()`；同步 barrier 并发 create 回归强制两请求都读到目标缺失，断言仅一方成功且磁盘正文完整。定向 Core test 通过。 |
| 目录操作 | 目录 etag 从排序的整棵树路径、类型与文件内容 hash 派生；rename/delete 均在计划后重新核对。删除前快照文本与二进制原字节，先把目录和孤儿附件移入隐藏 trash，再刷新索引；失败会尝试回滚，恢复副本留在 history。 | `directoryTree()`、`deletePreview()`、`deleteFile()`、`renamePath()`；`vault-core.test.ts` 覆盖树子项变化→409、trash/二进制还原、孤儿附件策略。HTTP/UI 组合仍由独立浏览器批次检查。 |
| 改名和链接 | rename 使用 metadata 中的精确 source range 更新 Markdown；解析分别保留 `wikilink` 与严格 Markdown URL resolver，不把 alias bait 当普通 Markdown 路径；frontmatter 链接走 YAML AST 的具体 scalar/key 更新，保留注释和结构。改名计划对要写入的 source 做 etag 复核，并写前置 history。文件目标使用 hard-link no-replace commit；目录先独占 mkdir reservation 再 rename，失败时只删除仍为同 inode 的 reservation。文件 source 先 stage 并核验 expected etag，外部 atomic-save 变更保留在原路径。 | `resolveNoteLink()`、`rewriteReferences()`、`rewriteYamlText()`、`renamePath()`、`movePathNoReplace()`；定向测试在 preflight 后注入外部文件/空目录目标，以及源文件 atomic-save 替换，确认数据不覆盖、etag 冲突和无残留 temp。5 项针对测试通过。100-ref rename benchmark 674ms 为单机合成样本。 |
| 历史与墓碑 | history 按精确 canonical `rootPath` 过滤；加载时核对 UUID v4 与实际 filename、root/path、ISO 时间、etag/content hash 和编码；非法记录留在磁盘且不会进入 prune index。restore 与 version preview 共用 UUID guard。同相对路径跨 Vault 不串记录，rootless 旧记录不能恢复；迁移 map 保留墓碑，二进制快照以 Base64 保存并恢复原始 Buffer。 | `parseHistoryVersion()`、`historyFor()`、`restoreHistory()`、`migrateLegacyNotes()`；sentinel 回归构造 traversal ID + 过期 JSON，断言只忽略该记录、JSON 与 historyDir 外 sentinel 都仍在原处。Core 全套测试包含此回归。 |
| watcher 切换 | 先前怀疑 `openVault` 切换后漏装 watcher，经调用链复核已撤回：`openVault → refresh(true) → refreshOnce → attachWatchers()`。回归验证切到 B 后 A 的外部事件不泄漏到 B，B 的事件能出现。 | `vault.ts` 初始化/open/refresh 路径；root-switch changes regression 已包含在 Core 全套 15 files/224 tests 中。 |
| 资产和链接 subpath | 附件只在允许的 raster/audio/video MIME 下作为媒体返回，SVG/其他扩展为 octet-stream，读取限 10 MiB。subpath resolver 支持多级标题、重复标题、大小写不敏感 block ID，并对编码 fragment 解码一次；无效目标返回 null。 | `getAsset()`、`resolveSubpath()`；`vault-core.test.ts` 与 HTTP focused tests 覆盖 `Parent#Child`、中文/空格/编码 `#`、raw `%`、坏编码与 block ID case。 |

## 两项安全发现的闭环

1. **create-only 与 rename 的并发目标覆盖：已修复并验证。** 同目录 hard-link 确保普通文件 create/rename 目标仅在不存在时提交；directory destination 由 exclusive mkdir reservation 抢占。同步 barrier 强制两个 create 请求均读到缺失，另两种 rename race 在预检后插入外部文件/空目录；source atomic-save 回归验证 stage 后 etag 不匹配时把外部 bytes 放回原路径且不产生目标/temp。5 项定向 Core 回归通过。
2. **history JSON 中的 `id` 被当作文件名：已修复并验证。** Loader 只接受 filename 匹配的 v4 UUID、canonical path/root、规范 ISO 时间与匹配 etag/content hash 的记录；restore/version preview 也拒绝非法 UUID。过期 traversal-ID 记录回归验证 malformed JSON 和 historyDir 外 sentinel 均保留；全套 Core tests 通过。

## 自动化与本机运行证据

- 本轮 Core 使用真实临时文件系统与本机 HTTP 测试：`pnpm --filter @noltri/knowledge-core exec vitest run test/vault-core.test.ts -t 'simultaneous create-only|destination created after|external atomic-save source replacement|malformed history records'` 通过，1 文件/5 项；`pnpm --filter @noltri/knowledge-core typecheck` 通过；最终 `pnpm --filter @noltri/knowledge-core test` 15 文件/224 项通过。Core 的 CRLF YAML link rewrite 定向回归通过（1 passed / 71 skipped），Properties UI writer另有 desktop CRLF/CJK测试。
- `pnpm --filter @noltri/desktop run build:runtime` 通过并验证 Node 24.18.0 arm64 sidecar。隔离 HTTP smoke 先后验证 create-only 冲突、folder stale etag、root-scoped setting、cache persistence、worker diagnostics 与 SIGINT exit 0；最新 CRLF packaged smoke 又用同一 sidecar把含 CRLF YAML wikilink 的 target 改名，确认 Markdown worker 读到 1 条 link、整份源文件无裸 LF、diagnostics restart/timeout=0、自然退出码 0。资源 hash、端口与临时目录细节见 [core.md](./core.md)。这些是 owner 的真实 packaged 运行记录，不是本复核者重新启动。
- 当前结论：macOS 本机 Core 路径、并发 no-replace、history loader/restore/prune、链接写回、watcher root 切换、CRLF YAML 和 packaged Node runtime 均有自动化或 smoke 证据；两项安全阻塞已关闭。browser UI 组合另列于 acceptance。Windows 原生文件系统矩阵仍为平台限制，未列为本轮 Mac 交付阻塞。
