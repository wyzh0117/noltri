# Graph implementation and smoke evidence

## Browser and synthetic baseline

Prior synthetic harness run on an Apple M2 with a WebGL2 renderer measured steady animation-frame cadence near 60 Hz. These numbers are the settled RAF interval while the graph was animating; they do not establish 60 FPS during cold initialization, active drag, or zoom.

| Nodes / edges | Sample | Settled frame rate | Frame interval p95 / max | Long-task max |
|---|---:|---:|---:|---:|
| 100 / 200 | 4 s | 241 frames, 60.25 Hz | 17.5 / 33.4 ms | 142 ms |
| 1,000 / 2,000 | 4 s | 241 frames, 60.25 Hz | 17.5 / 17.7 ms | 72 ms |
| 5,000 / 10,000 | 5 s | 301 frames, 60.2 Hz | 17.5 / 17.7 ms | 109 ms |

The long-task maxima occurred during initial data/layout work in those short runs. The steady RAF result must not be read as end-to-end interaction performance or a 5,000-node 60 FPS guarantee. Active pan/zoom timing, worker convergence time, and idle draw count are being measured separately after the renderer culling and redraw changes.

## 2026-10-23 WebGL draw instrumentation

Page 2 (`http://127.0.0.1:4176/graph-smoke.html`) rendered the actual `WorkbenchGraph` component with 5,000 synthetic notes and 10,000 directed edges. Chrome reported WebGL2 on `ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)`. Instrumentation wrapped WebGL2 `clear`/draw calls and observed `PerformanceObserver` long tasks. Browser-dispatched pointer and wheel events flowed through the graph's React handlers; these are automated input events, not physical mouse measurements.

| Action | Active sample | Actual clears / rate | Clear interval p95 / max | Long tasks |
|---|---:|---:|---:|---:|
| Pan: 120 pointer moves | 1,999 ms | 119 / 59.52 Hz | 18.6 / 34.2 ms | 0 |
| Zoom: 120 wheel events | 2,014 ms | 119 / 59.10 Hz | 20.8 / 31.6 ms | 0 |

After pan inertia settled, the renderer made 0 clears over another 1.2 s (more than 60 frames); a subsequent wheel event woke one draw. A separate 3 s settled idle sample also produced 0 clears. During the 5,000-node cold load, the browser observer recorded 10 long tasks, with a maximum of 130 ms. These measurements cover this Chrome/M2 synthetic harness and do not establish performance on other devices or vault-specific data.

## Current Graph behavior and limitations

- The simulation runs in a module Worker with Barnes–Hut repulsion, a 30 px minimum charge distance, deterministic jiggle for exact overlaps, and node pins cleared on pointer release. WebGL2 falls back to Canvas 2D.
- Full-vault graph data and typed query matches use the notes API. File paths, attachment paths, and tag-node predicates are separate sets; tag nodes are tested against their own AST match set, including `NOT` and hierarchy semantics.
- Reciprocal directed edges keep both direction arrows but share one visual stroke. Render input is culled to the viewport before WebGL uploads or label placement. GL vertex storage is reused rather than creating a new `Float32Array` per upload.
- Pan inertia is limited to a short decay after pointer release. Redraws are event-driven; the simulation Worker stops ticking when cooled and timeline playback is the only continuous draw loop. The page-2 draw-call instrumentation above observed zero idle clears for both the settled 1.2 s interval and the separate 3 s idle sample; this is a harness result, not a guarantee for other browsers.
- Labels are recalculated when a draw is requested and are limited to visible nodes, but this is not an incremental label cache. There is no renderer-side spatial tree yet; pointer hit testing still scans graph nodes. These costs need to be evaluated during real 5,000-node drag/zoom.

## Browser smoke status

The synthetic harness is `apps/desktop/graph-smoke.html`; it can load 100, 1,000, or 5,000 generated nodes. The 5,000-node pan/zoom/idle checks above ran on the actual `WorkbenchGraph` renderer in page 2. A temporary Core fixture on port 18788 supplies real notes, attachments, tags and links; API typed-match responses were checked for hierarchical tags, `NOT` and attachment `file:` matches by the fixture owner. Browser session availability is coordinated separately; do not assume the earlier fixture page is still active.

## 2026-10-24 save handoff smoke

On page 5 (`http://127.0.0.1:1423/main.html`) using only the disposable Core 18788 vault, real keyboard input verified the WorkbenchNotes save drain and conflict path. A test-page-only `fetch` wrapper delayed a single `PUT /api/vault/file` acknowledgement after the Core had already committed it. While that acknowledgement was pending, a second `type_text` edit was made and Home was selected. The editor became read-only, the UI showed “正在保存并切换…”, and it stayed on `GraphSaveSmoke.md` until the acknowledgement arrived. The next PUT used the first response ETag, returned 200, and a direct GET found both input segments (final file size 143 bytes, ETag `678b82eb…17a38`); the UI then changed to Home.

A second test delayed the UI PUT before sending it, used the current ETag to write an external version through the original page fetch, and then released the stale UI request. The external PUT returned 200 with ETag `6fbcf89f…5b94a`; the UI PUT returned 409. The attempted switch to Home was cancelled, the editor retained `LOCAL-CONFLICT-DRAFT-2`, and the UI displayed “外部冲突” with the message that the current draft will not overwrite the external version. A direct GET contained `EXTERNAL-WINS-CONFLICT-2` and not the newer local draft. Both paths used only `GraphSaveSmoke.md` in the isolated temporary vault; no production or soak vault was touched.

To rerun, load the disposable `1423` app against Core `18788`, capture the current file ETag, and install a one-shot page-local fetch wrapper for `PUT /api/vault/file` targeting `GraphSaveSmoke.md`. For the drain case delay only the response after `originalFetch` resolves; type once, wait for the wrapper's pending-ack signal, type again, select another note, then verify the next PUT ETag and direct GET contents. For conflict, delay before `originalFetch`, make an external PUT with the captured ETag through the saved original fetch, select another note, then release and verify 409, retained draft and unchanged external content. Restore/reload the isolated test page afterward. This is a focused save-flow smoke, not a 30-minute typing soak.

An earlier editor soak on page 4 / port 1422 was invalidated by later Live Preview changes and is not counted. The final frozen-source soak on page 4 / port 1436 is recorded below.

## 2026-10-24 incremental Live Preview short sample

Page 11 (`http://127.0.0.1:1430/main.html?notesPerf=1`) served a fixed production bundle (`/tmp/noltri-notes-perf-r7-20261024`) against the disposable Core on port 18789. The source file `NotesEditor.tsx` was SHA-256 `649d389bccd1b24cd35ec3e32f130dc47129a4fe9f8b2c13cdffb45c330dbd29`; the test file was `ffb45a7608e2616b15e435f6aff674fb1ab6fda20effcfdbf2e26993f3a4ddd8`. The temporary route counter was gated by `?notesPerf=1` and the `Perf.md` source path, and is not acceptance instrumentation.

The 5,000-line `Perf.md` contained 128,994 bytes before the sample. Its ordinary third source line was immediately before a fenced code block and contained wiki-link/tag widgets; I added bold and inline math widgets, moved the caret outside the math token, then typed 276 single-character `type_text` inputs for 65.1 seconds. The page stayed visible and focused. All 276 `beforeinput` events used the incremental StateField route; none used a full-document fallback. Input intervals were p50 234.7 ms / p95 250.3 ms. `beforeinput` to next animation frame was p50 16.6 ms / p95 20.9 ms / max 82.7 ms; one long task lasted 84 ms. The rAF p95 is above the 16 ms input budget, so this short sample is not a pass; the single long task's cause was not isolated. A subsequent direct Core GET returned 200, ETag `9285fb40d1b4c7247640caba3bafd8979b9ab20d5f6f008f02a4193e1f7473e3`, 129,270 bytes and 5,000 lines, including all input, while the UI showed “已保存”. No `Soak.md` content was changed.

This sample validates the adjacent-block guard on a rich inline row, but it does not replace the required representative rich-corpus sample or the final 30-minute visible soak. The browser recorder measured next-rAF latency, not Event Timing `processingDuration`; parsing/transaction time and presentation wait remain unseparated here.

## 2026-10-24 dense editor input sample and owner-block probes

Page 12 (`http://127.0.0.1:1431/main.html`) served the fixed production bundle in `/tmp/noltri-notes-dense-precheck-20261024` against the isolated Core on port 18789. The `PerfRich.md` fixture was copied from `Soak.md`; the source soak file was not edited. It began with 5,040 physical lines and 331,256 UTF-8 bytes (the initial sample ETag was `6a38612a…db623`; a four-batch warmup was saved before measurement, so the measured sample base ETag was `a14eff64…b5c164`). `NotesEditor.tsx` at the fixed bundle source was SHA-256 `e1955dcde34457f81f641d67f47cf973452eb3c344420c9a26a72565ae495098`; `WorkbenchNotes.tsx` was `bd4e3109f19865e058aa9d12db92e0da98ef0c5293db83b14f9038df42dd0a00` at capture time. The source file was 321,254 UTF-16 code units. A rough source regex count found 311 token-like constructs; this is not the editor parser's exact token count.

The ordinary-text sample edited the final source line (`Line 05000 — continuous editor baseline text and content words.`) with the caret outside any structural token. Twenty real Chrome DevTools `type_text` batches inserted 14 characters each (280 `beforeinput` events). First-to-last input span was 78.465 s. The tab was visible and focused. A tooling gap of 24.856 s made the full observer lifetime 156.3 s, so this is a short sampled workload, not a continuous soak. Input intervals were p50 234.7 ms / p95 250.3 ms. Event Timing reported `input` processing p50 1.8 ms / p95 6.0 ms / max 17.8 ms; `beforeinput` processing p95 was 0.1 ms. `input` presentation wait p95 was 46.5 ms and event duration p95 was 48 ms. The browser's beforeinput-to-next-rAF p50 was 6.73 ms / p95 14.5 ms / max 45.88 ms. One 63 ms long task occurred about 12 s into the sample. After autosave, Core GET returned 200 with ETag `835ff65a…25a694`, 331,592 bytes and 5,040 lines; all inserted text was present and the UI showed “已保存”. These processing and presentation metrics are separate; the ordinary-content Event Timing processing p95 is below 16 ms, while the sample does not establish an overall presentation budget or long-run result.

Two additional real-input probes on a disposable `PerfRichBlocks.md` cloned from the rich fixture exercised edits inside an H2 body and a fenced code body. The document had 5,051 lines / 331,758 bytes before the probes. For the heading probe, `## Stable heading edit` kept its `##` prefix unchanged and received 11 characters. Input processing p95/max was 24 ms, event duration p95 was 64 ms, and one 54 ms long task was recorded. For the code probe, the code widget was revealed and ` //perf` (7 characters) was inserted in `const answer = 42`, away from either fence delimiter. Input processing p95/max was 21 ms; event presentation p95 was 43.1 ms; no long task was recorded. The final Core GET returned 200, ETag `e8b6f2f57cc168750f3e1962e5dc049c58b1970864abede562d9ae40821efbf2`, 331,776 bytes and 5,051 lines, with both edits present.

The probes show a measured gap between ordinary rows and stable heading/code-body edits. The current conservative `updateOneLine` path falls back to full-document parsing when a changed line overlaps a block token. A narrow owner-block update for unchanged heading prefixes and code-body rows is under review; fence delimiters and other structural changes must retain the full-parse fallback. No performance pass is claimed for heading/code edits; the final frozen-source soak and its measured performance are recorded below.

## Graph acceptance status

- The final production/runtime checks verified the bundled Worker can spawn; the browser smoke ran on WebGL2 (`ANGLE Metal Renderer: Apple M2`). Canvas fallback was not exercised in that GPU-enabled browser.
- Synthetic 5,000-node pan/zoom and idle-wake instrumentation is recorded above. The later real Core-backed 5,000-node drag sample was a short pointer-injection sample: settle took 4.165 s and measured frame p95 was 21.1 ms over 12 sampled frames. This is not a native-pointer or all-frame 60 FPS result, and it does not meet the 2 s settle target.
- Core-backed positive/OR query and group coloring have direct UI evidence below; NOT/hierarchical matching was separately checked through the typed matcher/UI evidence in the final acceptance record. The page-13 sample below itself covers the positive/OR case, not the full AST matrix.

## 2026-10-24 Core-backed Graph filter and group UI smoke

Page 13 (`http://127.0.0.1:1432/main.html`) used the disposable Core 18789 vault and the merged desktop build below. With `tag:science OR tag:math`, the actual Graph showed 7 nodes and 4 connections. The browser requested `/api/vault/match?q=tag%3Ascience+OR+tag%3Amath` and received 200 with matching paths `ReviewBatch/DraftRecovery.md`, `ReviewBatch/SearchOnly.md`, and `ReviewBatch/Target.md`, plus tag matches `#math`, `#science`, and `#science/math`.

With tag nodes enabled, I added overlapping groups in order: `tag:science` (default red `#d65c5c`) and `tag:science OR tag:math` (default orange `#d6ad5c`). The graph remained populated at 7 nodes / 4 connections while both group colors appeared in the WebGL readback (388 red pixels and 195 orange pixels at their exact RGBA values). Removing the groups left the same node/connection counts, confirming groups color the existing graph rather than filter it. This is direct UI/renderer evidence for this positive/OR case; NOT and hierarchy response semantics were also checked at the Core API earlier, but their final rendered-state matrix remains pending.

Changing group-query inputs no longer blanks the Graph or throws. The fix captures each DOM value synchronously before the settings updater; the regression was exercised against this real UI. A custom color was applied by setting the native color input value to `#00ff00` and dispatching bubbling `input`/`change` events through the React handler; Graph settings persisted that color and WebGL readback contained 489 exact opaque green pixels. This verifies the app handler and renderer, not interaction with the native OS picker.

This smoke used `main-rKwDA214.js` (SHA-256 `2a59e232ad6868bd54859b24fb73673fe473571341e17b3ac1e928bab423735a`) and `workbench-graph.worker-CHHi0L5b.js` (SHA-256 `74cdb42a9d04e8faffc0d7ac8db609586687c0ac827a6428cccfb8cf222f09d5`). It is functional UI evidence, not final Graph performance evidence; the later simulation/Worker source freeze requires a fresh build before performance acceptance.

## 2026-10-24 Local controls and PNG export

On the same isolated Core-backed page, the focused `ReviewBatch/CRLFProbe.md` local graph showed 2 nodes / 1 edge. Turning off incoming links reduced it to 1 / 0; turning outgoing links off left 1 / 0; restoring both returned it to 2 / 1. Switching back to Global preserved the configured `tag:science OR tag:math` query and showed 7 / 4. The settings panel exposed Depth 1, direction, tag/attachment, orphan/existing-only, label-density, node-size, line-width and force controls. Attachment inclusion could not be observed in this Core sample because `/api/vault/graph` currently has no attachment nodes.

The screenshot button produced an `image/png` payload of 59,658 bytes at 838×1400. Decoding it in-page found 1,164,053 fully transparent pixels and 9,147 non-transparent pixels. The label canvas had 5,905 non-transparent label pixels, and all 5,905 differed from the composition without the label layer, confirming text labels enter the export. For fallback, a page-local clipboard rejection (`NotAllowedError`) exercised the real button handler and intercepted an anchor with `download="noltri-graph.png"` and a `data:image/png` URL. A native clipboard write was attempted after restoring the browser implementation, but reading back the OS clipboard hung the DevTools target; native clipboard readback therefore remains unverified. The successful clipboard-path test used a page-level sink to inspect the handler's PNG payload rather than claiming the OS clipboard contents.



## 2026-10-24 final Live Preview soak

Page 4 (`http://127.0.0.1:1436/main.html`) ran the frozen production preview in Live Preview mode against packaged Core PID 37134 on port 18789. The disposable vault was `/private/tmp/noltri-core-soak-18789-20261024/vault`. The editor source checkpoint was `NotesEditor.tsx` SHA-256 `9787458e95788e302182394c7539a0a5718f6270673def4039143a6723088dc4`, `WorkbenchNotes.tsx` `c0063d373a773229ab644b57ed50a5687317411b27934fb4da60445b7faf2884`, and `notes-workbench.css` `ba9fcd68db4cb7772a954ce162e18290414d0b7be873cff7b113015764a99b78`.

The run used a create-only `SoakRun4.md` copy of the unchanged `Soak.md` fixture (5,040 lines, 331,256 bytes, initial SHA-256/ETag `6a38612aef0b6842a0e05884cda948379c03d9a938840e016d183a34929db623`). Real `type_text` input added 660 ordered batches × 13 characters. First-to-last `beforeinput` span was 1,801,232.5 ms, from `2026-10-24T02:13:02.009Z` to `2026-10-24T02:43:03.259Z`; maximum event gap was 3,336.5 ms. The page, window, and editor stayed visible/focused, with no visibility/focus guard events or application/save errors. This supports the continuous-input and saved-content checks; it does not erase the runner's raw `valid=false` result described below.

The runner's same-snapshot UI record had 8,580 input events/characters, 548 save requests, 547 successful saves, 0 save errors, and status `正在索引 · 队列 0`. The final Core GET returned 200 with a changed ETag/SHA-256 `cddd79d9926b74af98f69c9c2125d06f5cb30ae70d02bc6ad24aa203a2643d4a`, 339,836 bytes and 5,040 lines. It contained all 660 markers exactly once and in order; removing that marker block restored the initial SHA-256 exactly. The original `Soak.md` remained 331,256 bytes with its initial SHA-256 unchanged. The runner guard required the UI status to equal `已保存`, so it recorded the exact reason literal `final save state/etag mismatch`; the changed Core ETag and `saveOk=547` met their conditions, leaving only the UI status condition false at that instant. A later read-only UI sample showed `已保存`, 548/548 successful saves and 0 errors. The UI's private ETag was not sampled, so no UI/Core ETag equality is claimed. The original invalid result is retained rather than rewritten as a passing runner result.

Input latency did not meet the 16 ms budget: `beforeinput` to next animation frame was p50 17 ms / p95 39.8 ms / max 320.8 ms. The observer recorded 231 long tasks, max 458 ms; coarse heap samples ranged from 17.1 to 100.6 MB and do not establish a leak. The input/content-integrity portion passed, the raw runner status remained invalid because of the indexing-status check, and the performance budget failed.

Evidence archive: [SoakRun4 raw evidence README](</Users/youngi/.codex/visualizations/2026/10/23/01a16992-5fe5-7d43-b1ec-fcdee3c6448b/soak-run4-raw-evidence/README.md>). It contains the exact cell 510 wrapper input, the captured pre-replacement source, persisted cycle outputs, same-snapshot UI/Core records, and the post-drain UI record. The standalone terminal return from cell 510 was not separately persisted in the accessible session log; the archive states this boundary explicitly. The source literal and raw snapshot fields above are preserved without reconstructing a terminal result.
