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
