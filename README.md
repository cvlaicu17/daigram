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
const GRID = { cols:18, rows:11, cell:64, gap:5 };          // canvas = cols*cell × rows*cell
const BOX = {
  a: { n:"Title", s:"subtitle", cls:"blue", col:1, row:2, cw:3, ch:2 },   // cell block (min 1×1)
  // cls: "" green · blue · red · db · multi (decked); combine like "blue multi"
};
const W = [
  { from:"a", to:"b" },                             // sides + route fully auto
  { from:"a", to:"b", label:"sends", style:"f1" },  // style: ""|blue|f1|f2|f3
  { from:"a", to:"b", path:[[7,4],[7,5],[9,5]] },   // explicit cell path (what +Arrow writes)
];
const ZONES = [ { col:0,row:1,cw:5,ch:9,label:"Group", kind:"eks" } ];  // kind: ""|eks(dashed)|edge(blue)
const DESC  = { a:{ cat:"…", d:"…", pts:["…"], eg:"…", code:"…" } };     // details-pane content
const FLOWS = [ { label:"Main path", nodes:["a","b"] } ];                // Flow buttons
```

**Tip:** leave empty rows/cols between boxes as routing channels — boxes packed
edge-to-edge force arrows to detour. If an arrow draws **dashed red**, open a
channel or enlarge the grid.

## What's here
| file | what |
|------|------|
| `diagram-template.html` | the engine — **copy this to start a new diagram** |
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
