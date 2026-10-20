// Core (model + commands) tests — headless, through the same core block the page runs.
// Run: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadDiagramHtml, writeHtml, replayHeadless, parseCommands } from "../daigram.mjs";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = path.join(ROOT_DIR, "diagram-template.html");
const fresh = () => loadDiagramHtml(fs.readFileSync(TEMPLATE, "utf8"));
const ok = r => { assert.equal(r.ok, true, r.error); return r; };
const plain = x => JSON.parse(JSON.stringify(x));   // the core runs in a vm sandbox: other-realm arrays
const bad = (r, re) => { assert.equal(r.ok, false); assert.match(r.error, re); return r; };

test("validation is strict: unknown op, unknown field, missing field, wrong type", () => {
  const { core, root } = fresh();
  bad(core.apply(root, { op: "nope" }), /unknown op "nope" — known: addBox/);
  bad(core.apply(root, { op: "moveBox", id: "a", col: 1, row: 1, x: 3 }), /unknown field "x"/);
  bad(core.apply(root, { op: "moveBox", id: "a", col: 1 }), /missing required field "row"/);
  bad(core.apply(root, { op: "addBox", col: -1, row: 0, cw: 1, ch: 1 }), /field "col" must be an integer >= 0/);
  bad(core.apply(root, { op: "setBox", id: "a", cls: "purple" }), /field "cls" must be space-separated box classes/);
  bad(core.apply(root, { op: "expand", id: "b" }), /view command/);
  bad(core.apply(root, "addBox"), /expected a JSON object/);
});

test("a failed command changes nothing", () => {
  const { core, root } = fresh(), h = core.hash(root);
  bad(core.apply(root, { op: "moveBox", id: "a", col: 7, row: 2 }), /overlap box "b"/);
  bad(core.apply(root, { op: "addWire", from: "a", to: "zzz" }), /no box "zzz"/);
  bad(core.apply(root, { op: "reparentBox", id: "b", parent: "b/h3", col: 0, row: 0 }), /into itself/);
  assert.equal(core.hash(root), h);
});

test("addBox: auto ids, overlap check, nested parent gets a sub-canvas, grid grows", () => {
  const { core, root } = fresh();
  assert.equal(ok(core.apply(root, { op: "addBox", col: 1, row: 12, cw: 2, ch: 1 })).fid, "n0");
  assert.equal(ok(core.apply(root, { op: "addBox", col: 4, row: 12, cw: 2, ch: 1 })).fid, "n1");
  bad(core.apply(root, { op: "addBox", id: "n0", col: 20, row: 20, cw: 1, ch: 1 }), /already exists/);
  assert.ok(root.GRID.rows >= 13);
  assert.equal(ok(core.apply(root, { op: "addBox", parent: "c", id: "x", col: 1, row: 1, cw: 2, ch: 1 })).fid, "c/x");
  assert.ok(root.BOX.c.sub && root.BOX.c.sub.BOX.x);
  bad(core.apply(root, { op: "addBox", parent: "c", col: 2, row: 1, cw: 1, ch: 1 }), /overlap box "x"/);
});

test("wires: address by from/to/nth, cross-level stored at the common ancestor", () => {
  const { core, root } = fresh();
  ok(core.apply(root, { op: "addWire", from: "a", to: "c", label: "one" }));
  assert.equal(ok(core.apply(root, { op: "addWire", from: "a", to: "c", label: "two" })).nth, 1);
  ok(core.apply(root, { op: "setWire", from: "a", to: "c", nth: 1, style: "f2" }));
  assert.equal(root.W.find(w => w.label === "two").style, "f2");
  ok(core.apply(root, { op: "deleteWire", from: "a", to: "c" }));          // nth 0 = "one"
  assert.deepEqual(plain(root.W.filter(w => w.to === "c" && w.from === "a").map(w => w.label)), ["two"]);
  const r = ok(core.apply(root, { op: "addWire", from: "b/h1", to: "b/h3/w1" }));
  assert.equal(r.level, "b");
  assert.ok(root.BOX.b.sub.W.some(w => w.from === "h1" && w.to === "h3/w1"));
  bad(core.apply(root, { op: "deleteWire", from: "a", to: "g" }), /no wire a -> g/);
});

test("wire paths are validated: orthogonal, free cells, start/end next to the boxes", () => {
  const { core, root } = fresh();
  // a: col1 row2 3x2 (cols 1-3, rows 2-3); c: col7 row5 3x2 (cols 7-9, rows 5-6)
  const good = [[4, 3], [5, 3], [5, 4], [5, 5], [6, 5]];
  ok(core.apply(root, { op: "addWire", from: "a", to: "c", path: good }));
  bad(core.apply(root, { op: "addWire", from: "a", to: "c", path: [[4, 3], [5, 4], [6, 5]] }), /not orthogonal neighbours/);
  bad(core.apply(root, { op: "addWire", from: "a", to: "c", path: [[5, 3], [6, 3], [6, 4], [6, 5]] }), /must start on a cell next to "a"/);
  bad(core.apply(root, { op: "addWire", from: "a", to: "c", path: [[4, 3], [4, 2], [3, 2]] }), /inside box "a"/);
  bad(core.apply(root, { op: "addWire", from: "a", to: "b/h1", path: [[4, 3]] }), /same level/);
  ok(core.apply(root, { op: "setWire", from: "a", to: "c", path: null }));
  assert.equal(root.W.find(w => w.from === "a" && w.to === "c").path, undefined);
});

test("deleteBox prunes every wire that touches the subtree, at any level, and flows", () => {
  const { core, root } = fresh();
  ok(core.apply(root, { op: "addWire", from: "a", to: "b/h2" }));            // stored at root, points into b
  ok(core.apply(root, { op: "deleteBox", id: "b" }));
  assert.equal(root.BOX.b, undefined);
  assert.ok(!root.W.some(w => w.from.startsWith("b") || w.to.startsWith("b")));
  assert.ok(!root.FLOWS.some(f => f.nodes.includes("b")));
  assert.equal(root.DESC.b, undefined);
});

test("reparentBox moves a subtree, keeps its inner wires, drops crossing ones, remaps flows", () => {
  const { core, root } = fresh();
  ok(core.apply(root, { op: "addSub", id: "c" }));
  ok(core.apply(root, { op: "addFlow", label: "deep", nodes: ["b/h3/w1"] }));
  const r = ok(core.apply(root, { op: "reparentBox", id: "b/h3", parent: "c", col: 1, row: 1 }));
  assert.equal(r.fid, "c/h3");
  assert.equal(root.BOX.b.sub.BOX.h3, undefined);
  assert.ok(root.BOX.c.sub.BOX.h3.sub.W.some(w => w.from === "w1" && w.to === "w2"));   // inner wire survives
  assert.ok(!root.BOX.b.sub.W.some(w => w.to === "h3"));                                  // h2 -> h3 crossed levels: dropped
  assert.deepEqual(plain(root.FLOWS.find(f => f.label === "deep").nodes), ["c/h3/w1"]);
  assert.equal(root.BOX.b.sub.DESC.h3, undefined);
  assert.ok(root.BOX.c.sub.DESC.h3);
});

test("queries: level listing, free check, catalog", () => {
  const { core, root } = fresh();
  const lv = ok(core.query(root, { q: "level", parent: "b" }));
  assert.deepEqual(plain(lv.boxes.map(b => b.fid).sort()), ["b/h1", "b/h2", "b/h3"]);
  assert.equal(lv.wires[0].from, "b/h1");
  assert.equal(ok(core.query(root, { q: "free", col: 1, row: 2, cw: 1, ch: 1 })).overlaps, "a");
  assert.equal(ok(core.query(root, { q: "free", col: 1, row: 2, cw: 1, ch: 1, except: "a" })).free, true);
  const cat = ok(core.query(root, { q: "commands" }));
  for (const k of ["addBox", "addWire", "reparentBox", "expand", "undo", "export"]) assert.ok(cat.commands[k], k);
  bad(core.query(root, { q: "view" }), /live page/);
});

test("saving keeps the CONFIG markers (generators still find them) and round-trips the model", () => {
  const d = fresh();
  ok(d.core.apply(d.root, { op: "addBox", n: "Saved", col: 1, row: 12, cw: 2, ch: 1 }));
  const html = writeHtml(d.core, d.html, d.root);
  assert.match(html, /\/\* =+ CONFIG \(edit this\) =+ \*\/\nlet GRID=[\s\S]*?\n\/\* =+ \*\//);   // the gen-*.py regex
  assert.match(html, /let BUILD="cli-/);
  const again = loadDiagramHtml(html);
  assert.equal(again.core.hash(again.root), d.core.hash(d.root));
  const twice = loadDiagramHtml(writeHtml(again.core, again.html, again.root));
  assert.equal(twice.core.hash(twice.root), d.core.hash(d.root));
});

test("headless replay mirrors the page's undo history", () => {
  const { core, root } = fresh(), s = "S";
  const header = { k: "session", session: s, seq: 0, state: { v: 4, root: core.serializeDiagram(root), expanded: [] } };
  const lines = [header], cmds = [
    { op: "addBox", col: 1, row: 12, cw: 2, ch: 1 }, { op: "setBox", id: "n0", n: "x" }, { op: "undo" }, { op: "redo" }, { op: "undo" }, { op: "undo" }];
  const live = core.buildDiagram(core.stateRoot(header.state)), hist = [core.hash(live)];
  let hi = 0;
  cmds.forEach((c, i) => {   // what the page would record
    let r;
    if (c.op === "undo") { if (hi > 0) hi--; r = { ok: true }; }
    else if (c.op === "redo") { if (hi < hist.length - 1) hi++; r = { ok: true }; }
    else { r = core.apply(live, c); hist.splice(hi + 1); hist.push(core.hash(live)); hi = hist.length - 1; }
    lines.push({ k: "cmd", session: s, seq: i + 1, src: "ui", cmd: c, ok: r.ok, h: hist[hi] });
  });
  const out = replayHeadless(core, lines);
  assert.equal(out.ok, true, JSON.stringify(out.diverged));
  assert.equal(out.hash, core.hash(root));          // two undos → back at the start
});

test("CLI apply: atomic on failure, writes on success, records the session", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dg-cli-")), f = path.join(dir, "d.html");
  fs.copyFileSync(TEMPLATE, f);
  const before = fs.readFileSync(f, "utf8"), cli = path.join(ROOT_DIR, "daigram.mjs");
  const fail = spawnSync("node", [cli, "apply", f, '[{"op":"addBox","col":1,"row":12,"cw":2,"ch":1},{"op":"moveBox","id":"a","col":7,"row":2}]'], { cwd: dir, encoding: "utf8" });
  assert.equal(fail.status, 1);
  assert.equal(fs.readFileSync(f, "utf8"), before);
  const out = execFileSync("node", [cli, "apply", f, '{"op":"addBox","n":"Hi","col":1,"row":12,"cw":2,"ch":1}'], { cwd: dir, encoding: "utf8" });
  const last = JSON.parse(out.trim().split("\n").pop());
  assert.equal(last.ok, true);
  assert.equal(loadDiagramHtml(fs.readFileSync(f, "utf8")).root.BOX.n0.n, "Hi");
  const recs = fs.readdirSync(path.join(dir, "recordings", "d"));
  assert.equal(recs.length, 2);
  const log = fs.readFileSync(path.join(dir, "recordings", "d", recs.sort()[1]), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(log[0].k, "session");
  assert.equal(log[1].cmd.op, "addBox");
});

test("parseCommands accepts JSONL with comments, a JSON array, or one object", () => {
  assert.equal(parseCommands('// c\n{"op":"a"}\n\n# x\n{"op":"b"}').length, 2);
  assert.equal(parseCommands('[{"op":"a"},{"op":"b"}]').length, 2);
  assert.throws(() => parseCommands('{"op":"a"}\n{oops}'), /line 2/);
});

test("a page's own .box.<cls> styles become valid classes", () => {
  const tpl = fs.readFileSync(TEMPLATE, "utf8");
  const plainTpl = loadDiagramHtml(tpl);
  bad(plainTpl.core.apply(plainTpl.root, { op: "setBox", id: "a", cls: "aws" }), /box classes from/);
  const d = loadDiagramHtml(tpl.replace("</style>", ".box.aws{background:#1c1533}.box.aws .n{color:#fff}\n</style>"));
  ok(d.core.apply(d.root, { op: "setBox", id: "a", cls: "aws multi" }));
  bad(d.core.apply(d.root, { op: "setBox", id: "a", cls: "container" }), /box classes from/);   // engine state classes stay out
});

test("upgrade swaps the engine but keeps CONFIG, title, header, BUILD and the page's own CSS", async () => {
  const { upgradeHtml } = await import("../daigram.mjs");
  const tpl = fs.readFileSync(TEMPLATE, "utf8");
  const d = fresh(); ok(d.core.apply(d.root, { op: "addBox", n: "Old one", col: 1, row: 12, cw: 2, ch: 1 }));
  const old = d.core.spliceConfig(tpl, d.root)
    .replace(/<title>[^<]*<\/title>/, "<title>My C2 view</title>")
    .replace(/<h1>[^<]*<\/h1>/, "<h1>My header</h1>")
    .replace(/let BUILD="[^"]*"/, 'let BUILD="b42"')
    .replace("</style>", "  .box.wip{border-style:dashed}\n</style>")
    .replace("function pathFits(", "function OLD_ENGINE_MARK(){}\nfunction pathFits(");   // stand-in for an older engine
  const { html, kept } = upgradeHtml(old, tpl);
  assert.ok(!html.includes("OLD_ENGINE_MARK"));
  assert.match(html, /<title>My C2 view<\/title>/); assert.match(html, /<h1>My header<\/h1>/); assert.match(html, /let BUILD="b42"/);
  assert.deepEqual(kept.css, [".box.wip{border-style:dashed}"]);
  const a = loadDiagramHtml(old), b = loadDiagramHtml(html);
  assert.equal(b.core.hash(b.root), a.core.hash(a.root));
  assert.equal(upgradeHtml(html, tpl).html, html);   // idempotent
});

/* ---- expand reflow (task 2.1) ---- */
const lay = (core, root, expanded) => { const r = core.query(root, { q: "layout", expanded }); assert.equal(r.ok, true, r.error);
  return Object.assign(r, { at: Object.fromEntries(r.boxes.map(b => [b.fid, [b.col, b.row, b.cw, b.ch]])) }); };
// a level built from compact specs: {id:[col,row,cw,ch, sub?]} — sub = a list of [cols,rows] content size
function level(core, spec, zones = []) {
  const root = core.normDiag({ GRID: { cols: 40, rows: 30, cell: 64, gap: 5 } });
  for (const [id, [col, row, cw, ch, inner]] of Object.entries(spec)) {
    root.BOX[id] = { n: id, s: "", cls: "", col, row, cw, ch };
    if (inner) root.BOX[id].sub = core.normDiag({ BOX: { x: { n: "x", s: "", cls: "", col: 0, row: 0, cw: inner[0], ch: inner[1] } } });
  }
  root.ZONES = zones.map(([col, row, cw, ch]) => ({ col, row, cw, ch, label: "", kind: "" }));
  return root;
}

test("reflow: nothing expanded → nothing moves; the sample with everything expanded has no overlaps", () => {
  const { core, root } = fresh();
  const base = lay(core, root, []), all = core.query(root, { q: "layout", all: true });
  for (const id of Object.keys(root.BOX)) assert.deepEqual(plain(base.at[id].slice(2)), [root.BOX[id].cw, root.BOX[id].ch]);
  assert.deepEqual(plain(all.overlaps), []);
});

test("reflow: a box diagonal to a container that grows both ways is pushed (the old Output-G bug), by the shorter push", () => {
  const { core } = fresh();
  const root = level(core, { p: [0, 0, 2, 2, [10, 3]], y: [4, 3, 2, 2] });   // p grows to 12x6; y sits diagonally
  const r = lay(core, root, ["p"]);
  assert.deepEqual(plain(r.overlaps), []);
  assert.deepEqual(plain(r.at.p), [0, 0, 12, 6]);
  assert.deepEqual(plain(r.at.y), [4, 7, 2, 2]);   // down by 4 (to row 6 + 1-cell channel) beats right by 9
});

test("reflow: only what the container runs into moves; touching boxes stay touching, gaps shrink to 1 at most", () => {
  const { core } = fresh();
  const root = level(core, { p: [0, 0, 2, 2, [6, 1]], q: [10, 0, 3, 2], r: [13, 0, 3, 2], far: [0, 10, 2, 2] });
  let L = lay(core, root, ["p"]);                      // p grows to 8 wide: still short of q (col 10)
  assert.deepEqual(plain([L.at.q, L.at.r, L.at.far]), [[10, 0, 3, 2], [13, 0, 3, 2], [0, 10, 2, 2]]);
  root.BOX.p.sub.BOX.x.cw = 12;                        // now p (14 wide) runs into q
  L = lay(core, root, ["p"]);
  assert.deepEqual(plain(L.at.q), [15, 0, 3, 2]);      // pushed to p's right edge + 1-cell channel
  assert.deepEqual(plain(L.at.r), [18, 0, 3, 2]);      // r was touching q: still touching
  assert.deepEqual(plain(L.at.far), [0, 10, 2, 2]);    // below p but out of its way: untouched
});

test("reflow: a zone moves as one rigid group and grows around its own expanding member", () => {
  const { core } = fresh();
  const root = level(core, { p: [1, 1, 2, 2, [10, 3]], m1: [6, 1, 2, 2], m2: [6, 4, 2, 2] }, [[0, 0, 4, 4], [5, 0, 4, 7]]);
  const L = lay(core, root, ["p"]);
  assert.deepEqual(plain(L.overlaps), []);
  const dz = L.at.m1[0] - 6;                            // the right zone's members moved by the same delta
  assert.ok(dz > 0); assert.equal(L.at.m2[0] - 6, dz); assert.equal(L.at.m1[1], 1); assert.equal(L.at.m2[1], 4);
  const [zl, zr] = L.zones;                             // left zone wraps grown p with its margins; right zone shifted, same size
  assert.deepEqual(plain([zl.col, zl.row, zl.cw, zl.ch]), [0, 0, 14, 8]);
  assert.deepEqual(plain([zr.col - dz, zr.row, zr.cw, zr.ch]), [5, 0, 4, 7]);
  assert.ok(zr.col >= zl.col + zl.cw);                  // zones don't overlap either
});

test("every expansion of every bundled diagram is overlap-free", () => {
  for (const f of [TEMPLATE, path.join(ROOT_DIR, "examples", "example-webapp.html")]) {
    const d = loadDiagramHtml(fs.readFileSync(f, "utf8")), subs = d.core.allSubFids(d.root, "", []);
    for (const ex of [subs, ...subs.map(s => s.split("/").map((_, i, a) => a.slice(0, i + 1).join("/")))])
      assert.deepEqual(plain(d.core.query(d.root, { q: "layout", expanded: ex }).overlaps), [], f + " " + ex);
  }
});

test("code listings are a box field; upgrade refuses to drop fields this engine doesn't know", async () => {
  const { upgradeHtml } = await import("../daigram.mjs");
  const d = fresh();
  ok(d.core.apply(d.root, { op: "addBox", n: "Main.java", cls: "code", code: "class Main {}", col: 1, row: 12, cw: 4, ch: 3 }));
  ok(d.core.apply(d.root, { op: "setBox", id: "n0", code: "class Main { }" }));
  assert.equal(ok(d.core.query(d.root, { q: "box", id: "n0" })).code, "class Main { }");
  ok(d.core.apply(d.root, { op: "setBox", id: "n0", code: null })); assert.equal(d.root.BOX.n0.code, undefined);
  d.root.BOX.a.shape = "cloud";   // a field only some patched engine understood
  assert.deepEqual(plain(d.core.unknownFields(d.root)), { box: ["shape"], wire: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dg-up-")), f = path.join(dir, "x.html");
  fs.writeFileSync(f, d.core.spliceConfig(fs.readFileSync(TEMPLATE, "utf8"), d.root));
  const r = spawnSync("node", [path.join(ROOT_DIR, "daigram.mjs"), "upgrade", f], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stdout, /unknownFields/);
  assert.ok(upgradeHtml(fs.readFileSync(f, "utf8"), fs.readFileSync(TEMPLATE, "utf8")).html);   // the library call itself still works (--force path)
});
