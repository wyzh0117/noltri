# Vault Core 运行与验证

Vault 的 Markdown 和附件文件是唯一可编辑真相。默认目录为 Core 数据目录下的 `vault/`；可用 `NOLTRI_NOTES_DIR=/absolute/path` 配置启动目录，也可通过 `POST /api/vault/open` 在运行时打开一个绝对目录。打开目录会把选择保存到 Core 数据目录的 `vault-settings.json`；同一文件为每个 Vault 根目录单独保存 `newLinkFormat`（默认 `shortest`），可经 `GET/PUT /api/vault/settings` 配置 `absolute`、`relative` 或 `shortest`。索引与缓存按规范化后的 Vault 根路径散列隔离。阅读器可用 `GET /api/vault/subpath?path=&subpath=` 读取 Core 解析出的标题/块位置，避免 UI 自行实现多级标题和大小写不敏感 block-ID 解析。

原知识库中的 `knowledge_notes` 会按稳定映射 `_legacy/<topicId>/<chapterId-or-topic>.md` 导出；冲突时使用稳定递增后缀，迁移不会覆盖已有文件，重复启动会复用映射。映射记录位于数据目录的 `vault-index/<root-hash>.json`，每个 Vault 根目录独立保存。迁移后 SQLite 内容只作为迁移备份，产品读写（包括旧 GraphNotebook 章节入口和 Core GraphNote service）都走映射到的 Markdown 文件。映射文件被删除后，映射会保留为 tombstone，重启不会从 SQLite 自动复活笔记；若确实要恢复旧备份，使用 `POST /api/vault/legacy-note/restore`，它只在目标 Markdown 不存在时写入，不会覆盖现有内容。切换到另一个 Vault 会使用独立映射并单独迁移。

元数据缓存是可丢弃的按根目录 hash 文件，位于数据目录的 `vault-cache/`；缓存损坏会扫描 Markdown 并重建，后台每 600 秒清理超过 600 秒未使用的 hash。历史版本位于 `vault-history/`，正常编辑 60 秒内节流，每个文件保留最近 50 份且最多 30 天；外部修改通过 watcher/refresh 在替换索引前节流快照旧内容，外部删除强制保存最后索引内容，启动扫描不会为新建缓存制造历史重复。改名、移动、删除、块 ID 联动、恢复旧版本等应用内破坏性操作先强制快照；相同 etag 与内容的重复事件会合并。二进制附件用原字节 Base64 封存，删除后可通过 history restore 恢复。`GET /api/vault/history?path=` 可查询已删除路径的版本，`POST /api/vault/history/restore` 可按路径恢复 Markdown 或附件。

文件夹 `GET /api/vault/delete-preview?path=` 返回 `kind: "folder"`、递归文件数、反链数、孤儿附件和覆盖完整目录树的 etag（路径、空目录、文件路径及内容 hash）。删除必须携带预览 etag；子孙文件或目录变化会返回 409。确认后所有子孙文件先进入历史快照，文件夹和可选孤儿附件通过同盘原子 rename 移至索引忽略的临时路径，再更新索引并清理临时内容。预览后的外部改动不执行删除。

Create-only 写入以同目录临时文件的 exclusive hard link 提交；并发同名创建只允许一个成功，另一个收到 409。文件改名先把源项原子移入唯一同目录临时名、按请求 etag 校验，再以 exclusive hard link 建立目标，最后只清理自己创建的临时名；源文件在改名中被外部 atomic-save 重新创建时返回 409，不会删除该新文件。目录改名以 exclusive `mkdir` 保留目标，再替换自己的空目录；失败清理只对 inode 仍匹配且为空的保留目录调用 `rmdir`。跨文件系统移动安全失败，不做可能覆盖目标的回退复制。

历史索引只接受 UUID v4 id 且 id 与 JSON 文件名一致、rootPath 精确匹配、Vault 相对路径规范、时间戳和 etag 格式有效、正文编码可验证的记录。无效或无法归属当前 Vault 的记录保留在磁盘但不会显示、恢复或参与过期清理，因此旧 rootless 记录不会跨 Vault 泄露，恶意 id 也不能扩展历史目录外的 prune 路径。

`newLinkFormat` 设定保存在 `vault-settings.json` 的 Vault-root hash 映射中，切换 Vault 后各自恢复自己的 `absolute`、`relative` 或 `shortest` 设置；旧版单值仅作为尚无 root 设置时的迁移初值。开发时 worker 从 `src/notes/parser-worker.ts` 通过 `tsx` 启动；桌面运行时在 `apps/desktop/scripts/build-runtime.mjs` 将它构建成 `parser-worker.mjs`，并由 Tauri resources 携带在 Core bundle 旁。运行时 worker 会在 10 秒无响应后终止并重启；当前文件记为失败，队列继续处理其他文件，`GET /api/vault/diagnostics` 可查看失败、缓存和 worker 计数。

`POST /api/vault/resolve-link` 接受 `{ linkpath, sourcePath, kind? }`，`kind` 可为 `wikilink` 或 `markdown`，缺省保留旧 wikilink 行为。Markdown URL 按源文件目录解析，前导 `/` 从 Vault 根解析，保留 query 和 fragment 作为导航后缀；不应用 Wikilink 的 alias/短名匹配。Core 的 metadata link index、backlinks、Graph edges 与该接口使用相同的 link-kind 语义。

在仓库根目录运行 Core 类型检查与测试：

```sh
pnpm --filter @noltri/knowledge-core typecheck
pnpm --filter @noltri/knowledge-core test
```

合成性能脚本只在系统临时目录建库并在结束时删除：

```sh
pnpm --filter @noltri/knowledge-core exec tsx scripts/vault-benchmark.mts
```

它分别测量冷/暖 1000 篇索引、10000 篇搜索及 100 条反链改名。脚本输出仅作为该机器的观测值，性能验收记录应附设备和实际数字。

2026-10-24 本轮结果：Core `pnpm --filter @noltri/knowledge-core typecheck` 通过，完整测试 15 个文件 / 224 项通过；Schema、API client 和 MCP typecheck 通过，MCP 测试 3 个文件 / 19 项通过。桌面最新 `pnpm --filter @noltri/desktop typecheck && pnpm --filter @noltri/desktop test` 报告为 15 个文件 / 106 项通过；API client typecheck 与测试报告为 6 个文件 / 33 项通过。新 Vault file schema 不限 Markdown 正文字符数；HTTP server 对原始 body 上限为 16,000,000 字节，足以覆盖 5000 行编辑 fixture。

最终 runtime 检查：`pnpm --filter @noltri/desktop run build:runtime` 成功构建 Core、MCP 和 `parser-worker.mjs`，并验证 Node 24.18.0 arm64 sidecar。CRLF修复后的资源 SHA-256：Core `f93dd09b…b466cf`，parser worker `6db61aa…f3ce34a1`，MCP `9c1e88ff…76dcaace`。随后用 sidecar Node 24.18.0 启动隔离 HTTP smoke（端口 64106；Vault/data 在系统临时目录，测试后清理）：创建含 CRLF YAML wikilink 的源笔记与目标，重命名目标后，源文件链接更新为 `[[Renamed|Renamed]]`，整个文件没有裸 LF、正文 CRLF 未变，打包 parser worker 返回一条链接；diagnostics worker restarts/timeouts 均为 0，Core 收到 SIGINT 后自然退出码 0。定向回归 `pnpm --filter @noltri/knowledge-core exec vitest run test/vault-core.test.ts -t 'preserves CRLF frontmatter'` 通过（1 passed / 71 skipped）。最终 smoke 后 18788/18789 按最新 packaged Core 重启，HTTP health 均为 200、diagnostics indexing=false/queued=0/failedFiles=[]/worker restarts/timeouts=0；当前观测 revision 分别为 7 和 10。重启前后逐文件计算的 7 个和 9 个 Vault 文件 SHA-256 均一致（包括 Soak.md 与 ReviewBatch/CRLFProbe.md），两个隔离 Vault/data 均保留。

同日合成基准最近一次运行、自然退出码 0：1000 篇冷索引 443 ms、暖索引 230 ms；10000 篇首次索引 2493 ms、匹配全部 10000 篇的搜索 37 ms；100 条反链改名 674 ms；单篇写入后反链索引可读 15 ms；外部新建文件被 watcher 索引 59 ms。结果仅表示该机器和这组小型 Markdown fixture 的观测值。

同 etag 并发更新由 Vault 实例级串行队列统一提交，创建、写入、删除、改名、恢复、旧 GraphNotebook Markdown 保存、设置更新和 Vault 切换共用该边界；队列失败后可继续接受后续操作。跨进程或外部编辑器写入仍由 etag 检查冲突，不承诺跨进程互斥。桌面 mutation 用 `x-noltri-vault-root: encodeURIComponent(snapshot.rootPath)` 标识发起时的 Vault；Core 只校验此 token，不以它切换根。旧 caller 未传 token 时，HTTP server 在读取请求 body 前捕获当前根；非法 percent 编码返回 400，Vault 已切换后提交的旧 token 返回 409。自定义 header 已加入 CORS allow-headers。

P1 定向回归：`pnpm --filter @noltri/knowledge-core exec vitest run test/vault-core.test.ts -t 'serializes concurrent updates using the same etag|rejects an old-root mutation'` 中两个用例通过；`pnpm --filter @noltri/knowledge-core exec vitest run test/http-server-graph.test.ts -t 'delayed Vault writes'` 两条参数用例通过、另两项跳过，覆盖 `/api/vault/file` 与 `/api/vault/file/`。完整 Core suite 15 个文件 / 224 项通过，Core typecheck 通过。`pnpm --filter @noltri/desktop run build:runtime` 成功；最新 Core bundle SHA-256 为 `8b958fbe31ff3fad7d205d0fcfcdd682ddf762e5f1a73874c9292c6269a0f1b8`，parser worker 为 `6db61aaeb5be0b31f3ce1418b2b867c2ef3fa7ea2db9b800a88a6574f3ce34a1`，MCP bundle 为 `9c1e88ff5ce43b6244b3b8cdc78c30262c1466e65a116def2b7b96c766dcaace`。

打包 HTTP 尾斜线 smoke 使用独立临时 Vault 和只读 runtime snapshot，验证 `/api/vault/file/` create 返回 200、CORS 预检 204；body 分片期间切换 Vault 后旧请求返回 409，新根不存在对应文件，sidecar 收到 SIGINT 后自然退出码 0。其他隔离 package smoke 验证 Unicode root、同 etag 双 PUT 返回一个 200/一个 409、旧 root header 返回 409、畸形 root token 返回 400。所有 smoke 临时数据均已清理。

当前稳定服务从不可变 runtime snapshot `/tmp/noltri-final-runtime-p1-20261024` 启动，snapshot 的 Node sidecar 与 Core/worker 文件不可写，后续 repo runtime build 不会替换运行中的二进制。交接记录和 PID 文件位于 `/tmp/noltri-core-services-final-20261024/handoff.json`；启动器为 `/tmp/noltri-core-services-start-final.mjs`。18788 PID 37133、root `/private/tmp/noltri-core-18788-vault`、data `/private/tmp/noltri-core-18788-data`，revision 8；`Reader10000.md` SHA-256 为 `8e948a8057e08b83e12c9dd98d406458d74331313648cdf809586c4a719ce260`。18789 PID 37134、root `/private/tmp/noltri-core-soak-18789-20261024/vault`、data `/private/tmp/noltri-core-soak-18789-20261024/data`，revision 11；`Soak.md` SHA-256 为 `6a38612aef0b6842a0e05884cda948379c03d9a938840e016d183a34929db623`。两者 health=200、indexing=false、queued=0、failedFiles=[]、worker restarts/timeouts=0；旧 root token mutation 均返回 409 且没有创建目标文件。此前旧 PID 已消失且找不到其启动日志，因此无法确认旧实例退出原因；当前 detached 服务 PID 的 PPID 为 1，日志位于同一交接目录的 `core-18788.log` 和 `core-18789.log`。

## 核心边界到检查的映射

| 验收边界 | 可追溯检查 |
| --- | --- |
| 同名短链、同目录优先、目标缺失后接链、NFC/大小写/路径穿越与 symlink | `vault-core.test.ts`：`resolves path precedence, links created targets, rejects traversal/symlink escape and detects stale buffers`；`normalizes`、`rejects unsafe path`、`folds equivalent path keys` 表驱动用例 |
| 同 etag 并发更新仅一个成功；根切换期间旧请求不能写入同路径的新 Vault | `vault-core.test.ts`：`serializes concurrent updates using the same etag and keeps history plus metadata on the winning version`、`rejects an old-root mutation after a root switch, even when the roots contain matching paths`；HTTP：`keeps delayed Vault writes bound to the encoded Unicode root captured before the body arrives` |
| 并发 create-only 不覆盖赢家；目录前缀冲突零写入；NBSP/NFC 物理路径访问 | `vault-core.test.ts`：`commits simultaneous create-only writes with an exclusive filesystem operation`、`rejects case-folded parent components before create or move and reuses NFC-equivalent filesystem spelling` |
| 文件/目录 rename 目标在预检后出现时保留两边内容；源文件 external atomic-save 与 stale etag 冲突 | `vault-core.test.ts`：`does not replace a destination created after the %s rename preflight`、`rejects an external atomic-save source replacement after the rename etag check` |
| 历史恶意 ID 不越出目录 prune，损坏记录留盘并且不进入版本列表 | `vault-core.test.ts`：`ignores malformed history records and never prunes a traversal sentinel`；`keeps shared history isolated by exact Vault root and refuses rootless legacy snapshots` |
| alias 命中和同名无歧义；absolute/relative/shortest 生成、display 保留 | `vault-core.test.ts`：`rewrites links using the persisted %s format without losing aliases or display text`；`keeps new-link format scoped to each Vault across switches and restarts` |
| 移动源笔记时重算相对出链；重命名保留 Markdown URL 编码、query、多级 fragment、显示文本与 title | `vault-core.test.ts`：`rebases moved source outlinks and preserves self-link aliases and subpaths`；真实打包 HTTP smoke：端口 60267 的 `%20`、`?mode=1#A#B "Tip"` 结果及自然退出码 0 见上 |
| YAML 链接只更新目标 key、不破坏注释/嵌套结构/body | `vault-core.test.ts`：`rewrites only YAML values by their nested key path and preserves comments and body text`；`rewrites links using the persisted %s format without losing aliases or display text` |
| 多级 heading、大小写不敏感 block、无效 subpath 返回 null；Reader HTTP contract | `vault-core.test.ts`：`indexes YAML links, aliases, headings, list items, blocks, footnotes and reference links`；`http-server-graph.test.ts` 的 Vault HTTP 场景断言 `Parent#Child`、`^anchor` 和 missing position |
| block ID 更新源块及所有精确引用，保留未匹配普通文本 | `vault-core.test.ts`：`persists root-scoped metadata hashes and renames only exact block references` |
| CJK 与英文混合提及，排除 frontmatter、已有链接、引用和代码 | `vault-core.test.ts`：`finds mixed CJK/English mentions while excluding frontmatter, fenced code and existing references` |
| parser 10 秒超时重启，失败文件隔离并继续队列；关闭自然结束 | `vault-core.test.ts`：`restarts a timed-out parser and continues with queued files`、`drains an active refresh before closing its filesystem watchers`；benchmark 自然退出码记录见上 |
| Query case、NOT、exclusive、regex TTL/LRU、fuzzy camelCase/CJK 评分与精确区间 | `vault-core.test.ts`：`applies case modifiers, NOT, and exclusive operator validation`、`caches regex compilers by TTL/LRU and keeps fuzzy scores aligned with the documented formula for camelCase and CJK`、`expires cached regexes after 60 seconds and evicts the least-recently-used entry at capacity`、`returns exact title and excerpt ranges from the query evaluation` |
| 只返回完整 AST 命中的 tag、附件 filename 匹配，不传播文件命中的其它 tag | `vault-core.test.ts`：`returns exact tag predicate matches and attachment filename paths for graph filters`；HTTP graph smoke 曾检查 `matchingTags:["#packaged"]` |
| 修改/外部替换/删除之前创建历史快照，启动不重复；文本与原始二进制恢复 | `vault-core.test.ts`：`snapshots external edits and deletions before replacing the indexed bytes, without startup duplicates`、`force-snapshots the current note before restoring an older text version`、`previews orphan assets, requires an explicit choice, and restores deleted binary bytes` |
| orphan never/always/ask、文件夹递归删除 etag、文件夹改名树 etag、碰撞拒绝和嵌套附件恢复 | `vault-core.test.ts`：`previews orphan assets, requires an explicit choice, and restores deleted binary bytes`、`previews folder contents and external backlinks, rejects stale tree etags, and restores nested binary bytes`、`requires the complete current folder etag before rename and refuses file/directory target collisions` |
| 旧 SQLite 映射不覆盖/重迁复活；旧 GraphNotebook / Core API 读取写入 Markdown | `vault-core.test.ts`：`keeps migrated deletions as root-scoped tombstones across restarts and offers explicit restore`；`http-server-graph.test.ts`：`reuses legacy domains through HTTP capture, exposes discipline scopes and preserves exact grants` |
