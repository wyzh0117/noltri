# A11 final independent layout recheck

Date: 2026-10-21. Status: **passed; the previous A11 clamp-layout blocker is closed.**

I used a fresh Chrome 155.0.8059.84 CDP context at 1360×900 / DPR 1, the isolated production preview `127.0.0.1:1434/main.html`, and the real API at `127.0.0.1:1431`. The browser loaded `/assets/main-CNMyiAbG.js`, SHA-256 `fb7968591fcaf2be1415e2a8b190b1977f6dfabf95f76d8e202c28c9532f1fa8`; browser cache was disabled. The only injected bridge supplied `get_settings` so the desktop preview called the real API. The scope cache was empty before expanding Graph.

The isolated SQLite fixture remained the A12 acceptance discipline (`a12v31-20261020-discipline`, user `graph-v31-acceptance-user`): its actual GraphSelection returned 1,200 nodes and 800 edges. Expanding Graph rendered 260 nodes and 173 visible edges in about 395 ms. Sixteen auto-mode labels appeared on first paint, with computed 13 px font size. The screenshot shows a cloud-shaped layout instead of the previous perimeter pile-up. No point landed on the old clamp coordinates x=20/980 or y=20/680; the observed bounds were x=209.20–790.80 and y=40–660. Median rendered relationship length was 97.97 world units versus 305.05 for unconnected node pairs (ratio 0.321).

I searched for the real 108-character topic `a12v31-20261020-topic-0399`, which was outside the initial 260-node window. A stable result appeared in 263 ms; opening it showed the full notebook title and both real adjacent chapters in about 374 ms. The target entered the rendered window and its point remained inside the SVG viewport. The UI kept the same discipline and issued no second GraphSelection request; all 260 pre-existing saved node positions remained exactly unchanged (maximum delta 0), the camera stayed at x=0, y=0, scale=1, and the search input cleared. The long selected label is clipped at the viewport edge, as previously recorded for this fixture; the target remains identifiable from the search result and full notebook heading.

Evidence:

- [`a11-final-independent.json`](a11-final-independent.json) — asset identity, API counts, DOM/layout metrics, timings, scope and position checks.
- [`a11-final-independent-1360x900.png`](a11-final-independent-1360x900.png) — initial fresh layout.
- [`a11-final-independent-selected-1360x900.png`](a11-final-independent-selected-1360x900.png) — out-of-window search result opened in the same scope.

This recheck closes the A11 dense-layout visual blocker. It does not replace the independent agent's remaining A10/A13 gesture and narrow-window checks.
