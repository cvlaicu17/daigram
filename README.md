# daigram

A tiny, **self-contained interactive HTML diagram engine** — one `.html` file, no
build step, no dependencies, opens in any browser (desktop and touch/iPad).

Boxes and arrows snap to a **cell grid**; arrows **auto-route** with a collision
rule (no two share a cell in the same orientation, so perpendicular crossings
render as a clean `+`). It doubles as a config-driven engine *and* a touch-friendly
visual editor.

## Features
- **Grid-snapped boxes** (integer cell blocks) and **auto-routed orthogonal arrows**
  (A\* router, deterministic). Arrows **never cross boxes**: when a channel is
  over-crowded the router reroutes *around* the boxes sharing a lane (drawn dashed);
  the dashed-red direct fallback appears only if a target has no box-avoiding path at all.
- **Hover/highlight** — hovering a box lights it + its connections and dims the rest; click to pin.
- **Visual edit mode** (toggle **✎ Edit**), fully **touch-first** (native touch + pointer/mouse):
  - **+ Box** drag over empty cells (or tap for a default box)
  - **Select** drag to move, orange corner **levers** to resize
  - **+ Arrow** drag box → box across cells
  - **Delete**, **double-tap a box to edit its title inline**
  - **Pan / infinite canvas** — drag empty grid; the grid grows as you pan toward any edge
  - **Undo / Redo** (buttons or ⌘/Ctrl+Z, ⌘/Ctrl+⇧Z)
  - **Copy config** — emits the `GRID`/`BOX`/`W` literals back out
- **Nested / inline-expandable boxes** — a box can carry its own canvas (`sub`). Click the **⤢** button
  to **expand it in place**: the box enlarges to show its contents at full size and pushes the other
  boxes aside ("insert space"). Multiple boxes open at once, recursively — **⤢ Expand all** shows the
  whole hierarchy on one canvas; **⤡** collapses. Expansion is a view overlay (the base tree stays
  editable in Edit mode); the flattened display reuses the same router/zoom/pan.
  - **Only what's in the way moves:** a grown container pushes a box only if it would overlap it or
    come closer than a 1-cell routing channel (boxes that were touching stay touching), right or down —
    whichever is the shorter push. A **zone moves as one rigid group** and grows around its own members.
    Check any expansion with `{"q":"layout","all":true}` → `overlaps` (always empty).
- **Code listings** — a box with `code:"…"` (and `cls:"code"`) shows it as a monospace listing under its title.
  - **Cross-subtree wires** — a wire in any level's `W` may reference a *descendant* by slash-path
    (`{from:"p1/childA", to:"p2/childB"}`, declared at the common ancestor). It renders **only when
    both endpoints are visible** — i.e. when both parents are expanded — so you can draw child↔child
    links between two different containers that appear once you drill into both.
- **Zoom** (+/−, Fit), a **details pane**, named **Flow** highlight buttons, **zones** (grouping rectangles).
- **Persistence** — autosaves to `localStorage`, plus Export/Import JSON. A build stamp
  means a newer copy of the file ignores stale saved layouts.

## Quick start
```bash
cp diagram-template.html my-diagram.html
# edit the CONFIG block at the top of the <script>, then open my-diagram.html
```

Everything is driven by a few literals in the `CONFIG (edit this)` block:

```js
let GRID = { cols:18, rows:11, cell:64, gap:5 };          // canvas = cols*cell × rows*cell
let BOX = {
  a: { n:"Title", s:"subtitle", cls:"blue", col:1, row:2, cw:3, ch:2 },   // cell block (min 1×1)
  // cls: "" green · blue · red · db · multi (decked); combine like "blue multi"
  b: { n:"Parent", col:7, row:2, cw:3, ch:2,                              // a box can nest its own canvas:
       sub:{ GRID:{cols:14,rows:9,cell:64,gap:5}, BOX:{ /* …recursive… */ }, W:[], ZONES:[], DESC:{}, FLOWS:[] } },
};
let W = [
  { from:"a", to:"b" },                             // sides + route fully auto
  { from:"a", to:"b", label:"sends", style:"f1" },  // style: ""|blue|f1|f2|f3
  { from:"a", to:"b", path:[[7,4],[7,5],[9,5]] },   // explicit cell path (what +Arrow writes)
];
let ZONES = [ { col:0,row:1,cw:5,ch:9,label:"Group", kind:"eks" } ];  // kind: ""|eks(dashed)|edge(blue)
let DESC  = { a:{ cat:"…", d:"…", pts:["…"], eg:"…", code:"…" } };     // details-pane content
let FLOWS = [ { label:"Main path", nodes:["a","b"] } ];                // Flow buttons
```

**Tip:** leave empty rows/cols between boxes as routing channels — boxes packed
edge-to-edge force arrows to detour. If an arrow draws **dashed red**, open a
channel or enlarge the grid.

## Commands — the only way to change a diagram
Every change goes through **one function, `dispatch(command)`**: toolbar buttons, mouse/touch gestures,
agents, and replays all build a small JSON command, e.g.

```json
{"op":"addBox", "parent":"b", "id":"svc", "n":"Service", "cls":"blue", "col":1, "row":1, "cw":3, "ch":2}
{"op":"addWire", "from":"a", "to":"b/svc", "label":"calls", "style":"f1"}
{"op":"addWire", "from":"a", "to":"c", "path":[[4,3],[5,3],[5,4],[5,5],[6,5]]}
{"op":"moveBox", "id":"b/svc", "col":5, "row":1}
```

- Boxes are addressed by **slash paths** (`"b/h3"` = box `h3` inside `b`'s sub-canvas); coordinates are
  **cells local to the box's own level**.
- Commands are **strict**: an unknown op/field, a wrong type, an overlap, a bad arrow path → a clear
  error and *no change*. An explicit arrow `path` must be orthogonal free cells from next-to-`from` to next-to-`to`.
- **Model** commands change the diagram (and undo history); **view** commands (`expand`, `select`, `zoom`,
  `setMode`, `undo`…) only change what is shown and need a live page.
- The full catalog with every field: `node daigram.mjs commands` (or `daigram.commands()` in the page).

The model logic lives in `<script id="daigram-core">` — DOM-free, so the Node CLI runs the very same code.
In the page: `window.daigram.dispatch(cmd)`, `.batch([cmds])`, `.query({q:"level",parent:"b"})`, `.replay(log)`.

## Recording & replay (always on)
Every dispatched command is recorded with its result and a hash of the model after it, plus a
session header holding the starting state, so **every session can be replayed exactly**.

```bash
node daigram.mjs serve            # serves this folder on http://127.0.0.1:4173/
# open http://127.0.0.1:4173/diagram-template.html — the Rec button shows "⏺ Rec → file"
# every session lands in recordings/<page>/<session>.jsonl
```

- Opened as a plain `file://`, recording stays in the browser (last 500 lines) — `Log ⤓` downloads it.
- **Replay** in the page with `Replay ⤒` (pick a `.jsonl`), or `…/page.html?replay=/recordings/…jsonl&speed=1`
  to watch it at recorded speed. Headless: `node daigram.mjs replay recordings/…jsonl` — both report the
  first step whose result or model hash differs from the recording.
- Lines: `{"k":"session"}` header · `{"k":"cmd"}` command (replayable) · `{"k":"trace"}` pointer/engine
  observations (debugging only).

## Agents: drive a diagram without touching HTML
```bash
node daigram.mjs new my-diagram.html --title "My system"          # empty diagram from the template
node daigram.mjs apply my-diagram.html cmds.jsonl                  # headless; all-or-nothing, recorded
node daigram.mjs query my-diagram.html '{"q":"level","parent":""}'
node daigram.mjs send '{"op":"addBox","n":"X","col":1,"row":1,"cw":3,"ch":2}'   # live: the page open via `serve`
node daigram.mjs send '{"q":"view"}'                               # live: what is shown, red (unroutable) arrows
```
`apply` reads JSONL (or a JSON array), prints one result per command, and writes the file only if every
command succeeded (`--keep-going` to write anyway).

## Tests
```bash
npm test     # core unit tests + real-browser tests (headless Chrome via CDP; skipped if no Chrome)
```

## What's here
| file | what |
|------|------|
| `diagram-template.html` | the engine — **copy this to start a new diagram** |
| `daigram.mjs` | local server (recording to disk, live agent link) + agent CLI (`apply`, `query`, `send`, `replay`, `new`, `commands`) |
| `test/` | `core.test.mjs` (model/commands), `page.test.mjs` (headless Chrome), `cdp.mjs` (tiny DevTools driver) |
| `examples/example-webapp.html` | a filled-in worked example (a generic web-service architecture) |
| `legacy-pixel-template.html` | the previous free-pixel engine (arbitrary x/y/w/h boxes); kept for old diagrams, **not** grid-compatible |

## Verify a diagram renders (optional)
```bash
google-chrome --headless --disable-gpu --no-sandbox --virtual-time-budget=3000 \
  --dump-dom "file://$PWD/my-diagram.html" | grep -c 'class="box'   # expect your box count
```

## Hosting
A single self-contained `.html` hosts anywhere — open it locally, upload to S3
with `--content-type text/html` (so the browser renders it instead of
downloading), or drop it into a GitHub gist and view via
`https://gistpreview.github.io/?<gist-id>`.
