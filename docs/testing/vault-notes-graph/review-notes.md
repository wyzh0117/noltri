# Notes UI 独立复核

复核对象：`WorkbenchNotes`、`NotesEditor` 与 Notes model。独立复核覆盖草稿恢复/存储失败、Live Preview 局部重解析、CRLF offset/EOL、Vault mutation root ownership 与 Reader section/footnote 导航。真实浏览器保存/冲突 A/B、pagehide/reload 草稿恢复、CRLF 编辑、Reader10000 首次脚注往返和跨根 history-restore late ack 已通过；最终长测验证了连续输入和文件完整性，但 runner 收尾仍标 invalid，输入响应预算未达。跨根 block-rename、CRUD 组合、Reader 性能仍待复验。

## 结论

保存调用链已覆盖队列、并发编辑和 Vault / 文件切换：队列执行时只从相同 root/path 的当前 `NoteFile` 取 etag；切换前排空当前内容写入；写入响应只更新仍匹配的上下文。自写 `changed` 事件会延后到当前写队列结束，再读文件并按 etag 分类。外部变化发生在 PUT 之前时，旧 etag 得到 409，UI 保留本地草稿并阻止导航；Vault 切换等待提及写入并增加 load request id，late callback 不会更新新 root 的状态。

真实浏览器用例 A（延迟 PUT acknowledgement）：第一笔写入已落 Core 后延迟响应 15 秒；在 ack 释放前继续输入第二段并点击 Home。UI 显示“正在保存并切换…”，第二笔 PUT 使用第一笔响应 etag 并返回 200；直接 GET 包含两段内容（143 bytes），随后返回 Home。用例 B（外部并发写入）：延迟 UI PUT 发送 8 秒期间，以原 etag 写入外部版本并收到 200；UI stale PUT 返回 409，导航被拒，状态显示“外部冲突”，本地草稿仍在编辑器且磁盘 GET 保持外部版本。

文件树已有文件和目录的新建、移动/改名、删除操作。改名/删除前请求 Core 预览并携带 etag；删除确认显示反链、递归项目数和孤儿附件，可恢复路径按 root 存入 localStorage。选中附件只在对应文件树行操作；删除或移动选中子树时会清理/重映射附件预览、tab、split 和当前笔记路径。恢复入口显示原始删除或改名前路径，Core 二进制恢复按原字节写回。静态检查到的附件展示只使用图片/音频/视频元素或带 download 的链接；Core MIME 白名单不包含 HTML、SVG，其他扩展名返回 `application/octet-stream`，asset API 返回 JSON data URL，不提供同源 HTML 文档响应。

Reader 使用 Core `vaultSubpath` 返回的源位置，按 source offset 选择延迟加载的 Markdown section，再在该 section 内定位 source-line heading 或不区分大小写的 block ID。`position: null`、source position 无法映射到 lazy section、目标 section 尚不存在时都会回到文件顶部。带脚注的文档会先整体解析一次，再把完整顶层容器和共享脚注尾部分组为延迟 section；React `useId` 为多个 Reader 实例隔离脚注锚点。静态复核确认列表、blockquote、table 的顶层 token nesting 不会被拆开，frontmatter 前缀会从 Core 源偏移中扣除。真实 MarkdownIt+markdown-it-footnote 用例覆盖 CJK 脚注定义、跨段两次引用和双向 backref。Reader10000 首击脚注与 backref 已在最终 CSS-fix bundle page4/1436 实测通过：首 ref 后 definition 位于 viewport，backref 后原引用也可见；bundle/尺寸见下文。HTML 经过 DOMPurify 清理；Mermaid 与 HTML 信任默认关闭，外链要求确认，嵌入限制三层并检测循环。

孤儿附件选择 `always` 后，UI 只在 Core 删除成功后把 preview 中附件路径和被删条目路径一并存进当前 Vault 的恢复列表；`never` 不登记未删除附件。此前静态复核发现的树外附件漏登记已修；文件夹删除/改名与恢复浏览器 smoke 尚未结束。

## 验证

- `pnpm --filter @noltri/desktop typecheck && pnpm --filter @noltri/desktop test`：最终集成检查通过，15 个文件 / 107 项测试；含 bounded draft queue、跨 Vault 同名路径隔离、fence click、局部解析、CRLF 与 root-owner / Reader retry 回归。之后仅移除一条 Reader CSS smooth 声明；此 CSS-only 改动未另跑测试，但已构建 page4/1436 immutable bundle 并通过首击脚注/backref smoke。
- `pnpm --filter @noltri/knowledge-core typecheck`：通过。最终 `pnpm --filter @noltri/knowledge-core test`：15 个文件 / 224 项通过。定向 no-replace/history/source-race 组：`pnpm --filter @noltri/knowledge-core exec vitest run test/vault-core.test.ts -t 'simultaneous create-only|destination created after|external atomic-save source replacement|malformed history records'`，5 项通过；P1 同 etag 并发更新与切根期间旧请求保护分别通过 `serializes concurrent updates using the same etag and keeps history plus metadata on the winning version`、`rejects an old-root mutation after a root switch, even when the roots contain matching paths` 和 HTTP delayed-body Unicode-root 用例（含尾斜线路径）；CRLF YAML 精准回归 `pnpm --filter @noltri/knowledge-core exec vitest run test/vault-core.test.ts -t 'preserves CRLF frontmatter'`，1 项通过 / 71 项跳过。
- `pnpm --filter @noltri/schema typecheck`、`pnpm --filter @noltri/api-client typecheck && pnpm --filter @noltri/api-client test`、`pnpm --filter @noltri/mcp-server typecheck && pnpm --filter @noltri/mcp-server test`：通过；API client 6 个文件 / 33 项，MCP 3 个文件 / 19 项；`git diff --check` 通过。
- `pnpm --filter @noltri/desktop run build:runtime` 通过。打包 Node 24.18.0 arm64 Core 的 HTTP smoke 用临时 Vault/data 验证了 CRLF frontmatter wikilink rename：frontmatter/body 换行保持 CRLF、正文不变、parser-worker 解析到链接，diagnostics 无 worker restart/timeout/failed file，Core 收到 SIGINT 后自然退出码 0。这个 smoke 使用 64106 临时端口，临时目录已清理；不涉及共享 18788/18789 fixtures。
- Core HTTP 测试覆盖多级 `Parent#Child`、大小写不同的 `^anchor`、无效 subpath 返回 null。18788 最新实例也已单独验证 `/api/vault/subpath` 响应；最终 CSS-fix bundle 的 Reader10000 脚注首击与 backref 有浏览器通过证据，Reader 10k 帧预算和多 Reader 同时打开仍未测。

## 草稿延迟写独立复核

当前 `createVaultDraftWriteQueue` 对相同 root/path 保留最新内容并在 750 ms 内落地；切换 root/path 时先冲刷捕获的旧身份，timer 仅在仍持有同一个 pending 项时写入，`clear` 会取消旧 timer。保存队列执行时从相同 root/path 的最新 `NoteFile` 读取 etag；切换前由 `drainNoteFlush` 等待在途写并保存最新编辑。409 与保存错误返回前同步写入当前 identity 的 `contentRef`；成功响应仅在内容仍相同的上下文清草稿，自写 changes 在写队列结束后按最终 etag reconcile。`pagehide` 和 unmount 会冲刷当前/待写草稿。

静态独立复核未发现旧 timer 复活、同路径跨 Vault 串写或新内容用旧 etag 覆盖的路径；模型 fake-timer case 覆盖同路径跨 Vault、transition flush 和 accepted-save clear。真实浏览器 A/B 已验证延迟 ack 后继续输入再切换会 drain 两次写入，以及外部改动仍触发 409、保留草稿并阻止导航。另在隔离 `ReviewBatch/PagehideDraft.md` 上通过 pagehide/reload 用例：页面拦截该路径 PUT 使请求永不抵达 Core，实际输入后 100 ms reload；Core GET 仍保持原 etag/内容，本机 envelope 已保存新正文及原 `baseEtag`；重新打开、恢复后正文显示“未保存”，自动保存完成，Core GET 包含新正文且草稿 key 清除。真实 reload 还验证了干净且 etag 相同的草稿按该 base etag 保存；真实 409 冲突草稿 reload 后点击恢复，Core 外部版本不变且无后续 PUT。OS 强制结束进程与组件卸载仍未单独验证。

## 顶层导航与重开恢复

`WorkbenchApp` 始终挂载 `WorkbenchNotes`，切到 Library/Graph 时只将根节点设为 `.vault-notes-hidden`（`display:none`）；Notes 的 autosave effect 不依赖 `active`，所以顶层隐藏不会卸载编辑器或丢 debounce。真正卸载时 queue cleanup 会 `flushPending()`，`pagehide` 也会冲刷当前草稿。首次重新打开文件先读取 Core 的当前 `NoteFile`，再显示本地草稿的“恢复/丢弃”入口，不会在读取时自动把草稿写回服务端。真实 pagehide/reload 与恢复后 autosave 已通过前述 `PagehideDraft.md` 用例；用例没有模拟操作系统 force-kill。

复核发现旧草稿只存正文会绕过 409：重开时若用新磁盘 etag 恢复旧草稿，自动保存可能覆盖外部版本。已改为同一个 localStorage 值内保存版本化 `{content,baseEtag,conflict}` envelope，避免两个 key 半写状态；旧纯文本/格式损坏按未知 base 处理。磁盘内容与草稿相同则丢弃；干净且 etag 一致的草稿允许恢复并续存；缺失/不匹配的 etag、历史冲突标记或旧纯文本恢复为可复制编辑草稿，但保持冲突状态且不发送 PUT。冲突后继续输入仍存本地草稿并跳过自动 PUT。

当前证据：`pnpm --filter @noltri/desktop exec vitest run src/workbench/notes-model.test.ts` 通过，1 文件/30 项；覆盖 envelope 原子编码、旧/坏记录 fail-closed、etag 分类、delayed queue 元数据及 storage 写入失败。`pnpm --filter @noltri/desktop typecheck` 通过。storage 异常时 `setItem` 单次写入失败保留原 envelope；队列只在当前 root/path 仍挂载时显示明确的本机草稿保存失败提示，冲突文案说明不会自动覆盖 Vault；清除旧草稿失败时保留恢复入口。真实浏览器也已覆盖冲突 reload fail-closed 与 etag 一致恢复；模型测试不证明 OS 强制结束进程或组件卸载期间的行为。

## Mutation root ownership 与晚到响应

已加载 note 绑定读取时的 Vault root、path 和 owner generation；save 与 mutation 使用该捕获 root，异步响应只有在 note/root/epoch 仍属于原操作时才能更新编辑器、选择状态、snapshot revision 或后续导航。`restoreVersion`、`renameBlock`、树操作和提及转链均受同一 owner guard 保护，防止 A Vault 的迟到响应在 B Vault 的同名路径下回填内容。baseline 独立静态复核未发现漏 guard。page4/1436 final bundle 实测跨 Vault history-restore late ack：A 中 restore 已 200，页面 hold 响应并切到 B 同路径文件；释放 A ack 后 B 编辑器未回填 A 内容，真实输入保存后 B 磁盘为 B 原文+新内容，A 磁盘仍是 A 的恢复版本。两 Core 通过各自绝对路径检查；header 只校验捕获 root、不切换 root。跨根 block-rename late ack 仍待实测。

## Live Preview 局部重解析复核

`updateOneLine` 对单行编辑增加两个保守路径：标题前缀完全不变且标题行无其它结构语法时，只解析该标题行；fenced-code 的单个 body 行修改时，只解析所属 code-block，并确认新的 code token 仍覆盖整个原 block、语言相同。heading prefix、开/闭 fence、frontmatter、多行编辑、数学/表格/callout/HTML/embed 等其他 block 继续全量解析。未编辑 token 使用 ChangeDesc 映射，局部范围替换 Decoration；只有变化的 code block widget 重新创建。

回归测试逐次对比局部 token 与全量 parser 输出，检查无关前后 widget identity、code block 自身 identity 更新、下游位置映射以及 fence delimiter 编辑仍走 full parse。当前 tests 覆盖 heading 与 code body owner-block 路径。最终 PerfShort 对 `Soak.md` clone 加 7 行 fixture 实测：code widget 点击显源码，把 `const soakCode=1` 改为 `2` 后离开行 widget 恢复；heading 与 code 修改均由 Core GET 确认落盘（331,342 bytes / 5,047 lines，ETag `4c2607…74354`），tab 可见。7 次 heading `beforeinput→rAF` 分别为 77.9、11.5、12.5、15.1、21.8、4.8、12.2 ms；code 字符的 Event Timing processing 为 22.1 ms，next-rAF 为 39.9 ms。功能路径通过但该短样本有尖峰、未达 <16ms 预算；这些测量与 page12/1431 的旧 full-parse fallback 24/21ms processing 样本分开记录。

最终可见输入长测从 `02:13:02.009Z` 到 `02:43:03.259Z`，first-to-last `beforeinput` span 为 1,801,232.5ms；660 批、8,580 字符，tab 全程 visible/focused，guard/app/save errors 为 0，driver gap 2,501–3,972ms，input max gap 3,336.5ms。Core 上 548/548 PUT 返回成功。raw final 快照为 path `pathSoakRun4`、模式 LP、status `正在索引 · 队列 0`，`saveOk=547/548`、`saveTotal=548`、`saveErrors=0`；唯一不满足条件的是 status 尚未显示“已保存”。随后同页只读 status 显示“已保存”且 548/548。最终 Core GET 为 HTTP 200、339,836 bytes / 5,040 行，变化后的 ETag 为 `cddd79d9926b74af98f69c9c2125d06f5cb30ae70d02bc6ad24aa203a2643d4a`，包含 660 个有序唯一 marker；移除唯一 marker block 后恢复 clone SHA `6a38612a…db623`，原 Soak SHA 未变。输入与文件完整性窄项通过，但保留 raw runner invalid 结论，不改成 `valid:true`；UI 私有 etag 未采，post-read 不能证明 UI/Core etag 精确一致。长测 `next-rAF` n=8,580，p50/p95/max 为 17/39.8/320.8ms；231 long tasks、max 458ms，故 <16ms 输入响应预算未达。周期性 heap 采样约 33–100MB 且采样稀疏，不能据此证明无泄漏。

## 尚待验收

- fresh bundle：同路径跨 Vault block-rename late acknowledgement；history-restore 的窄路径已经在 page4/1436 通过。
- UI 组合：文件/文件夹/附件 row CRUD、stale folder 409、历史/二进制恢复、block rename、hover preview 与外链/危险协议操作。已通过的搜索、CRLF、LP 安全和 Graph 局部 smoke 不必重复。
- 性能与 runner 收尾：Reader10000 每帧仍未测。最终可见输入 run 已超过 30 分钟且文件完整性窄项通过，见上文；raw 快照唯一未满足项是 UI status 尚非“已保存”，同页随后只读已显示“已保存”且 548/548。保留 runner invalid 结论；UI 私有 etag 未采，现有 post-read 不证明 UI/Core etag 精确一致。当前 `next-rAF` p95/max 与 long-task 观测均未达到 <16ms 预算。此前 01:24 预跑因 77s 输入 gap 无效、01:52:42 run 因 20.004s driver gap 无效；70 批/910 字符、177.503s 的短检只用于验证 runner 改动，不替代最终长测。

代码复核结论：目前没有新的静态数据丢失或跨 Vault 串写阻塞项；root-owner 补丁已由 baseline 独立静态复核，history-restore late ack 双根磁盘回归也通过。真实浏览器剩余项见本节和 [acceptance.md](./acceptance.md)；脚注首击/backref 使用不可变 CSS-fix bundle 通过，不以 page-local CSS override 代替。Core 独立安全复核见 [review-core.md](./review-core.md)。
