# A12 real HTTP + SQLite browser acceptance

Date: 2026-10-20. Status: **A12 passed** in the isolated acceptance environment.

The test used the production desktop preview at `127.0.0.1:1433/main.html`, Chrome 155.0.8059.84 at 1360×900 / DPR 1, and the real Knowledge Core API at `127.0.0.1:1431`. A separate CDP browser context installed the `get_settings` Tauri bridge at document start; no product bundle or source was changed. Data was added only to `/private/tmp/noltri-graph-v31-acceptance/acceptance.sqlite`, under the dedicated user `graph-v31-acceptance-user`; the existing CS/Python/C++ fixtures were not edited.

The A12 discipline `a12v31-20261020-discipline` contains 400 topics, 800 chapters and 800 explicit `part_of` edges (1,200 GraphSelection nodes). Two topics intentionally share the title “A12 同名主题” but retain IDs `a12v31-20261020-topic-0100` and `...-0101`; a 108-character topic title is the late search target. A separate discipline contains an `A12-CROSS-SCOPE-ONLY` sentinel.

`POST /api/graph/select` returned HTTP 200 with all 1,200 nodes and 800 edges. A direct local HTTP request transferred 410,944 bytes in 79 ms. In the browser, the real scope selection response contained 1,200 nodes, 400 topics, 800 chapters and 800 edges; observed fetch duration was 16–25 ms and the fetch-wrapper duration was 23–32 ms across two runs. The discipline page rendered 400 topic cards. Expanding Graph produced 260 SVG node groups (87 topics and 173 chapters), and the settings menu accurately reported 940 folded nodes. Initial canvas DOM appeared in 273–274 ms after the expansion click.

The late target was absent from the initial 260-node drawing window. Searching its stable ID returned the target plus its two related chapters because their summaries also contain that ID; the target result remained distinguishable by its title and summary. Stable results appeared in 266–288 ms, including the existing debounce and real search request. Selecting the target opened its topic body, issued `/api/notes/a12v31-20261020-topic-0399`, cleared the search, kept the same discipline scope and did not issue another GraphSelection request. The updated 260-node window included the selected target, both real adjacent chapters and their relationship lines. The selected node circle was inside the SVG viewport; the full topic heading and search result wrapped within their columns with no page-level horizontal overflow.

Searching each duplicate topic ID separately returned its own uniquely summarized topic result, and selecting it fetched the corresponding ID-specific `/api/notes/:topicId` route. Searching for the foreign-discipline sentinel while still in the A12 scope returned no result and left the selected heading and discipline selection unchanged.

The long selected label itself extends past the graph panel’s right edge in the captured viewport; the selected point, its adjacency, the search result and the full notebook title remain visible. This did not prevent A12’s required location/open/scope behavior, but the screenshot records the edge-label clipping for visual context.

Evidence:

- [`a12-runtime-results.json`](a12-runtime-results.json) — API selection counts, UI timings, DOM counts, duplicate-ID routes and scope-isolation result.
- [`a12-large-graph-first-paint.png`](a12-large-graph-first-paint.png) — 260-node canvas and the visible 940-node folded count.
- [`a12-out-of-window-search-hit.png`](a12-out-of-window-search-hit.png) — search results for the target absent from the initial draw window.
- [`a12-out-of-window-selected.png`](a12-out-of-window-selected.png) — opened late target, preserved scope, selected node and real adjacent chapters.

This is a local acceptance measurement on the stated machine/browser, not a low-end-device performance guarantee.
