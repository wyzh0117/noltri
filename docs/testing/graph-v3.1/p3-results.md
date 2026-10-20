# Graph v3.1 P3 renderer

## Interface and behavior

`apps/desktop/src/workbench/WorkbenchGraph.tsx` exports `WorkbenchGraph` and `WorkbenchGraphProps`:

```ts
interface WorkbenchGraphProps {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  scopeIdentity: string;
  selectedNodeId: string | null;
  mode: 'mini' | 'expanded';
  onNodeOpen: (node: GraphNode) => void;
  onModeChange: (mode: 'mini' | 'expanded') => void;
  onNodeMore?: (node: GraphNode) => void;
}
```

`GraphNode` and `GraphEdge` come from `@noltri/schema`; the renderer uses their original IDs and titles. The graph is an SVG scene with small neutral circles sized modestly by degree, thin straight unarrowed relationship lines, and React text labels. Hover, focus, and selection emphasize the active node and its real adjacent nodes/edges. Pointer movement of 4 CSS px or more is treated as a node drag and suppresses the resulting click; a semantic click opens the node, including keyboard and accessibility activation. Node pointer capture keeps physical click targeting on the button group. The canvas pans on drag, zooms continuously around the pointer wheel position, and exposes fit, zoom, pan, open, and More keyboard operations while focused. Right-click, Shift+F10, or ContextMenu invokes `onNodeMore`.

Label settings are in a small `details` menu: automatic density, show all labels, or hide labels. Automatic mode measures title widths and label rectangles in rendered CSS pixels, then suppresses collisions; it has no fixed count-by-zoom thresholds. Selected, hovered, and focused labels remain visible even in forced-hide mode. Labels fade in/out through CSS opacity transitions. SVG node/label groups compensate for the viewBox, viewport and camera scales, keeping labels at 13 CSS px, circles at 3.8–5.8 CSS px radius, and transparent hit circles at 12 CSS px radius (24 px diameter) in the 420 px reference-width pane. The graph uses the application color tokens and has a `prefers-reduced-motion` override. The renderer does not use HTML injection or category-specific node colors.

Layout and camera are stored per `scopeIdentity` in localStorage under `noltri:graph-v3-view:*`. Saved node positions remain fixed when loading or adding nodes, which prevents selection or search updates from rearranging the existing view. State writes are debounced per render, but a scope-switch cleanup synchronously flushes that effect's captured old scope and snapshot before the new scope's state is persisted. This prevents a quick A→B→A switch from losing A's camera. The renderer also persists pending state on unmount, so P2 can safely unmount it while the graph panel is collapsed.

`selectGraphWindow` is a renderer-only draw cap; P2 passes it the full scope-query `nodes` and `edges` arrays, and it does not change scope or issue a narrower request. It starts from the selected search/content node when present, then adds connected components in deterministic order. Components that fit are kept whole; if a component straddles the cap, breadth-first expansion keeps its real links together as far as the limit allows. A late search target is kept in the drawing window with its real adjacent nodes and edges. The cap is 260 SVG nodes, with the remaining count exposed only inside the settings menu. If an unusually large connected component fills the cap, a selected node and as many of its direct neighbors as fit are still first.

## Verification

- `./node_modules/.bin/vitest run src/workbench/workbench-graph-layout.test.ts`: 1 file, 4 tests passed.
- P3 renderer tests: `./node_modules/.bin/vitest run src/workbench/workbench-graph-state.test.ts src/workbench/workbench-graph-view.test.ts src/workbench/workbench-graph-layout.test.ts` from `apps/desktop`: 3 files, 9 tests passed. Coverage includes captured old-scope flush, CSS-pixel scale compensation, sparse-label density, pinned labels and 260-node layout bounds.
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit` from `apps/desktop`: passed.
- `./node_modules/.bin/vite build` from `apps/desktop`: passed (148 modules transformed).
- Actual-browser checks for physical pointer click/drag, the 420 CSS px graph pane, and rapid scope switching are being run by the independent UI verifier; unit/build checks do not substitute for that check.
- Target-machine microbenchmark (Node v22.23.2, local development Mac; 10 fresh layouts using the actual A12 GraphSelection and its 260-node/173-edge draw window): median 10.74 ms, max 29.18 ms after the final spring tuning. The 260-node cap still uses a synchronous O(n²) pairwise pass, so revisit it before raising the cap materially; this local measurement is not a low-end-device guarantee. Full-scope selection and the 1,200-node/800-edge real range are measured in [`a12-runtime-results.md`](a12-runtime-results.md).
- No dependency was added. The only test fixture is inside the renderer unit test.

## Obsidian reference

The [official Obsidian Graph view help](https://obsidian.md/help/Plugins/Graph%2Bview) states that circles are notes/nodes and lines are internal links; higher reference counts enlarge nodes; hovering highlights connections; clicking opens a note; right-click opens actions; wheel and +/- zoom; dragging and arrow keys pan. It also documents label fading, node/link size, and force settings. The page embeds `obsidian-graph-view.png`; its [official source image](https://github.com/obsidianmd/obsidian-help/blob/master/en/Attachments/obsidian-graph-view.png) was opened directly at 1989 × 1331.

Visual observations from that published screenshot: a broad, very light canvas with a restrained sidebar; small outline circles and fine, low-contrast links; gray labels placed close to nodes; one purple active hub with its neighboring links emphasized while much of the surrounding graph and text fades back. The visible sample is a hub-and-spoke cluster with a few secondary links. This is a visual and interaction reference from Obsidian's own documentation. The published image alone does not establish exact current product defaults or theme values.

The [dark Graph capture](./obsidian-default-dark-graph-reference.png) is a local desktop reference from the already-installed Obsidian 1.14.4 application, not an official-site image. It was captured at 2048 × 1600 pixels from a clean isolated user-data directory and a temporary four-note vault; the vault's `appearance.json` was `{}`, no community theme/plugin was installed, and the system dark appearance produced the built-in Obsidian dark UI. It shows a charcoal canvas, subdued gray links and labels, small muted node circles, and the default Graph settings panel on the right. The local graph shape and labels are temporary reference notes, not product data. This is an actual app reference, not a pixel-for-pixel comparison with Noltri, and does not claim that every Obsidian version uses identical colors or default settings.

## A11/D04 force layout saturation follow-up (2026-10-20)

The previous first-paint 260-node graph hit the old hard integration clamps: 138 x-coordinates reached 20/980, 183 y-coordinates reached 20/680, and 61 nodes occupied a corner. Repeated per-axis coordinate clamping caused the rectangular perimeter.

The final fresh-layout pass keeps the deterministic radial start and radial-to-center force, removes axis boundary forces and coordinate clamps, and limits each integration delta by its L2 length (8 world units) with linear cooling over up to 72 iterations. Pair repulsion is `250 / (distance² + 360)` and real-edge spring pull is `0.20 × (distance − 118)`. This strengthens real links relative to global repulsion and preserves a round cloud. Only a fresh graph receives a uniform fit into the 920 × 620 world area; persisted positions remain byte-for-byte coordinate values and are never fitted or clamped. No tree or fixed cluster layout was added.

The 260-node regression uses 87 topics, 173 chapters, and all 173 real chapter→topic `part_of` edges. It checks broad two-axis spread, fewer than 10% of points near the former clamp lines, and that the median connected distance is below 65% of the median unconnected-pair distance. Saved positions remain covered by the exact equality test. Against the actual A12 draw window, all 173 connected edges had a 97.97-unit median and 136.54-unit p90; all 33,497 unconnected pairs had a 305.05-unit median (ratio 0.321). No point hit a former clamp line. Ten fresh 260-node layouts took 10.74 ms median and 29.18 ms maximum on Node v22.23.2. Pairwise repulsion remains O(n²), capped at 260 rendered nodes.

The final screenshot was captured from a separate Vite preview at `http://127.0.0.1:1434/main.html`, after a fresh build, using Chrome 155.0.8059.85 at 1360 × 900 CSS px / DPR 1. It used the real isolated HTTP A12 GraphSelection (1,200 nodes/800 edges), drew 260 nodes and 173 original edges, and had no saved `noltri:graph-v3-view:*` key before graph expansion. The SVG pane measured 419 × 900 CSS px and auto-label mode showed 16 labels. The loaded bundle was `/assets/main-CNMyiAbG.js`, SHA-256 `fb7968591fcaf2be1415e2a8b190b1977f6dfabf95f76d8e202c28c9532f1fa8`. All 260 SVG world-coordinate transforms matched a fresh Node `selectGraphWindow + layoutGraph` calculation for the same real input; maximum coordinate deviation was 7.4e-13 world units. This rules out stale 1433 preview assets and saved-camera/node state as the screenshot source.

Evidence: [final fresh-layout screenshot](a11-large-graph-clustered-1360x900.png) and [bundle, DOM-coordinate and performance measurements](a11-layout-clustered-results.json). The independent frontend reviewer will take its own fresh-context follow-up capture; this local screenshot and unit regression are not a substitute for that independent review.
