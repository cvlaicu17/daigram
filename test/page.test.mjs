// Page tests in real headless Chrome: every UI action goes through dispatch, is recorded to disk by the
// server, can be driven live by an agent, and the recording replays to the identical model.
// Run: node --test test/        (skipped when no Chrome/Chromium is found; set CHROME=/path to override)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, loadCore, parseLog, replayHeadless } from "../daigram.mjs";
import { haveChrome, launchChrome, openPage } from "./cdp.mjs";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const opts = { skip: !haveChrome && "no Chrome found", concurrency: false };
let dir, srv, chrome, page;
const lastCmd = () => page.eval(`(()=>{const l=daigram.log().filter(e=>e.k==="cmd");return l[l.length-1]})()`);
const cmdOps = () => page.eval(`daigram.log().filter(e=>e.k==="cmd").map(e=>e.cmd.op)`);
const box = fid => page.eval(`daigram.query({q:"box",id:${JSON.stringify(fid)}})`);
const click = id => page.eval(`document.getElementById(${JSON.stringify(id)}).click()`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  if (!haveChrome) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dg-page-"));
  fs.copyFileSync(path.join(ROOT_DIR, "diagram-template.html"), path.join(dir, "t.html"));
  fs.copyFileSync(path.join(ROOT_DIR, "examples", "uml-showcase.html"), path.join(dir, "uml.html"));
  srv = await startServer({ dir, port: 0, quiet: true });
  chrome = await launchChrome();
  page = await openPage(chrome, `http://127.0.0.1:${srv.port}/t.html`);
  await page.waitFor(`window.daigram && daigram.query({q:"view"}).recording.sink==="server"`);
});
after(async () => { if (page) await page.close(); if (chrome) await chrome.close(); if (srv) await srv.close(); });

test("boots recording to the server, with a session header carrying the start state", opts, async () => {
  const v = await page.eval(`daigram.query({q:"view"})`);
  assert.equal(v.recording.on, true);
  assert.match(v.recording.file, /recordings\/t\/.*\.jsonl$/);
  assert.equal(await page.eval(`daigram.log().find(e=>e.k==="session").state.v`), 4);
  assert.match(await page.eval(`document.getElementById("recStatus").textContent`), /→ file/);
  assert.equal(await page.eval(`!!document.getElementById("btnRec")`), false);   // no pause button: everything is recorded
});

test("toolbar buttons go through dispatch", opts, async () => {
  const expect = [["btnEdit", "setMode"], ["btnZoomIn", "zoom"], ["btnZoomOut", "zoom"], ["btnFit", "fit"], ["btnFit", "fit"],
    ["btnInfo", "info"], ["btnInfo", "info"], ["btnSave", "save"], ["btnEdit", "setMode"]];
  for (const [id, op] of expect) { await click(id); assert.equal((await lastCmd()).cmd.op, op, id); }
  await page.eval(`document.querySelector(".d-close").click()`); assert.equal((await lastCmd()).cmd.op, "details");
  await page.eval(`document.querySelector(".d-reopen").click()`); assert.equal((await lastCmd()).cmd.open, true);
  await page.eval(`document.querySelector(".flowbtn").click()`); assert.equal((await lastCmd()).cmd.op, "showFlow");
  await page.eval(`[...document.querySelectorAll(".toolbar button")].find(b=>b.textContent.includes("Expand all")).click()`);
  assert.equal((await lastCmd()).cmd.op, "expandAll");
  await page.eval(`[...document.querySelectorAll(".toolbar button")].find(b=>b.textContent.includes("Collapse all")).click()`);
  assert.equal((await lastCmd()).cmd.op, "collapseAll");
  await page.eval(`document.getElementById("box-b").querySelector(".boxexp").click()`); assert.deepEqual((await lastCmd()).cmd, { op: "expand", id: "b" });
  await page.eval(`document.getElementById("box-b").querySelector(".boxexp").click()`); assert.deepEqual((await lastCmd()).cmd, { op: "collapse", id: "b" });
});

test("edit gestures (real pointer drags) become model commands", opts, async () => {
  await click("btnEdit");                                     // edit mode, select tool
  const cell = await page.eval(`GRID.cell*zoom`);
  const before = await box("a");
  const [x, y] = await page.center("a");
  await page.drag(x, y, x + cell, y + cell);                  // move a by +1,+1
  const mv = await lastCmd();
  assert.deepEqual(mv.cmd, { op: "moveBox", id: "a", col: before.col + 1, row: before.row + 1 });
  assert.equal(mv.ok, true);
  assert.equal((await box("a")).col, before.col + 1);

  await page.eval(`document.querySelector('.tool[data-tool="arrow"]').click()`);
  const [ax, ay] = await page.center("a"), [ex, ey] = await page.center("e");
  await page.drag(ax, ay, ex, ey);                            // draw an arrow a → e
  assert.deepEqual((await lastCmd()).cmd, { op: "addWire", from: "a", to: "e" });

  await page.eval(`document.querySelector('.tool[data-tool="box"]').click()`);
  const sx = await page.eval(`(()=>{const r=stage.getBoundingClientRect();return [r.left+(14.5*GRID.cell)*zoom, r.top+(9.5*GRID.cell)*zoom]})()`);
  await page.drag(sx[0], sx[1], sx[0] + cell, sx[1]);          // + Box: 2x1 at col 14 row 9
  const add = await lastCmd();
  assert.equal(add.cmd.op === "select" ? (await page.eval(`daigram.log().filter(e=>e.k==="cmd").slice(-2)[0].cmd.op`)) : add.cmd.op, "addBox");
  assert.ok(await page.eval(`!!ROOT.BOX.n0 && ROOT.BOX.n0.col===14 && ROOT.BOX.n0.cw===2`));

  await page.eval(`document.querySelector('.tool[data-tool="del"]').click()`);
  const [nx, ny] = await page.center("n0");
  await page.mouse("mousePressed", nx, ny); await page.mouse("mouseReleased", nx, ny, 0); await sleep(50);
  assert.deepEqual((await lastCmd()).cmd, { op: "deleteBox", id: "n0" });
  await page.eval(`document.querySelector('.tool[data-tool="select"]').click()`);
});

test("editing inside an expanded container writes base (level-local) coordinates", opts, async () => {
  await page.eval(`daigram.dispatch({op:"expand",id:"b"})`);
  const base = await box("b/h1"), cell = await page.eval(`GRID.cell*zoom`);
  const [x, y] = await page.center("b/h1");
  await page.drag(x, y, x, y + cell);                         // one row down, inside b
  const mv = await lastCmd();
  assert.deepEqual(mv.cmd, { op: "moveBox", id: "b/h1", col: base.col, row: base.row + 1 });
  assert.equal((await box("b/h1")).row, base.row + 1);
  await click("btnUndo");                                     // undo through the button
  assert.equal((await lastCmd()).cmd.op, "undo");
  assert.equal((await box("b/h1")).row, base.row);
  await click("btnEdit");
});

test("resize lever, detail-pane rename and drag-to-reparent are commands too", opts, async () => {
  await click("btnEdit");
  const cell = await page.eval(`GRID.cell*zoom`), g0 = await box("g");
  const [x, y] = await page.center("g");
  await page.mouse("mousePressed", x, y); await page.mouse("mouseReleased", x, y, 0);   // select g → levers
  const se = await page.eval(`(()=>{const r=document.querySelector(".lever.se").getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  await page.drag(se[0], se[1], se[0] + cell, se[1]);
  assert.deepEqual((await lastCmd()).cmd, { op: "resizeBox", id: "g", col: g0.col, row: g0.row, cw: g0.cw + 1, ch: g0.ch });

  await page.eval(`(()=>{const f=document.getElementById("ef-n");f.value="Renamed G";f.dispatchEvent(new Event("input"));f.dispatchEvent(new Event("change"))})()`);
  assert.deepEqual((await lastCmd()).cmd, { op: "setBox", id: "g", n: "Renamed G" });
  assert.equal((await box("g")).n, "Renamed G");
  await page.eval(`(()=>{const k=document.getElementById("ef-kind");k.value="usecase";k.dispatchEvent(new Event("change"))})()`);
  assert.deepEqual((await lastCmd()).cmd, { op: "setBox", id: "g", kind: "usecase" });
  assert.equal(await page.eval(`document.getElementById("box-g").classList.contains("shaped")`), true);
  await page.eval(`(()=>{const k=document.getElementById("ef-kind");k.value="box";k.dispatchEvent(new Event("change"))})()`);
  assert.equal((await box("g")).kind, undefined);

  await page.eval(`daigram.dispatch({op:"expand",id:"b"})`);
  await page.eval(`daigram.dispatch({op:"fit",on:true})`);   // the reflow pushes c below the viewport — fit everything on screen
  const tgt = await page.eval(`(()=>{const h=BOX["b/h1"],s=stage.getBoundingClientRect(),c=GRID.cell*zoom;return [s.left+(h._ox+4+.5)*c, s.top+(h._oy+5+.5)*c]})()`);
  const [cx, cy] = await page.center("c");
  await page.drag(cx, cy, tgt[0], tgt[1], 12);                // drop c into b's sub-canvas at local (4,5), a free spot inside its shown area
  assert.deepEqual((await lastCmd()).cmd, { op: "reparentBox", id: "c", parent: "b", col: 4, row: 5 });
  assert.equal(await page.eval(`!!ROOT.BOX.b.sub.BOX.c && !ROOT.BOX.c`), true);
  assert.equal(await page.eval(`!!document.getElementById("box-b/c")`), true);
  await click("btnUndo");
  assert.equal(await page.eval(`!!ROOT.BOX.c`), true);
  await page.eval(`daigram.dispatch({op:"collapse",id:"b"})`);
  await page.eval(`daigram.dispatch({op:"fit",on:false})`);
  await click("btnEdit");
});

test("expanding everything: no overlaps, no red arrows; collapsing restores the exact layout", opts, async () => {
  const before = await page.eval(`JSON.stringify(daigram.query({q:"view"}).boxes)`);
  await page.eval(`daigram.dispatch({op:"expandAll"})`);
  const v = await page.eval(`daigram.query({q:"view"})`);
  assert.equal(v.warnWires, 0);
  assert.deepEqual(await page.eval(`DaigramCore.layoutOverlaps(Object.entries(BOX).map(([fid,b])=>({fid,col:b.col,row:b.row,cw:b.cw,ch:b.ch})))`), []);
  await page.eval(`daigram.dispatch({op:"collapseAll"})`);
  assert.equal(await page.eval(`JSON.stringify(daigram.query({q:"view"}).boxes)`), before);
});

test("an agent drives the open page through the server (live link)", opts, async () => {
  const send = body => fetch(`http://127.0.0.1:${srv.port}/api/cmd`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
  const r = await send({ cmds: [{ op: "addBox", id: "agent", n: "From agent", col: 14, row: 9, cw: 3, ch: 2 }, { op: "addWire", from: "agent", to: "g", label: "live" }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await page.eval(`!!document.getElementById("box-agent")`), true);
  assert.equal((await lastCmd()).src, "agent");
  const bad = await send({ cmd: { op: "addBox", col: 14, row: 9, cw: 1, ch: 1 } });
  assert.equal(bad.ok, false); assert.match(bad.error, /overlap box "agent"/);
  const v = await send({ query: { q: "view" } });
  assert.equal(v.ok, true); assert.equal(v.warnWires, 0);
});

test("the recording on disk replays to the identical model (in a fresh page and headless)", opts, async () => {
  await page.eval(`recFlush()`); await sleep(300);
  const file = await page.eval(`daigram.query({q:"view"}).recording.file`);
  const text = fs.readFileSync(file, "utf8"), lines = parseLog(text);
  const cmds = lines.filter(l => l.k === "cmd"), final = await page.eval(`DaigramCore.hash(ROOT)`);
  assert.ok(cmds.length > 20, "recorded " + cmds.length + " commands");
  assert.equal(cmds[cmds.length - 1].h, final);

  const p2 = await openPage(chrome, `http://127.0.0.1:${srv.port}/t.html`);
  await p2.waitFor(`window.daigram`);
  const out = await p2.eval(`daigram.replay(${JSON.stringify(text)})`);
  assert.equal(out.ok, true, JSON.stringify(out.diverged));
  assert.equal(out.hash, final);
  await p2.close();

  const hl = replayHeadless(loadCore(), lines);
  assert.equal(hl.ok, true, JSON.stringify(hl.diverged));
  assert.equal(hl.hash, final);
});

test("opened as a plain file, recording falls back to the browser", opts, async () => {
  const p3 = await openPage(chrome, "file://" + path.join(dir, "t.html"));
  await p3.waitFor(`window.daigram && daigram.query({q:"view"}).recording.sink==="browser"`);
  assert.match(await p3.eval(`document.getElementById("recStatus").title`), /in this browser/);
  assert.equal(page.logs.filter(l => l.startsWith("EXCEPTION")).length, 0, page.logs.join("\n"));
  await p3.close();
});

test("the UML showcase renders every shape, marker and zone kind", opts, async () => {
  const p = await openPage(chrome, `http://127.0.0.1:${srv.port}/uml.html`);
  await p.waitFor(`window.daigram && document.querySelectorAll(".box").length>40`);
  const r = await p.eval(`(()=>{ const kinds=Object.values(BOX).map(b=>b.kind||"box");
    const used=[...document.querySelectorAll("path.wire")].flatMap(e=>[e.getAttribute("marker-end"),e.getAttribute("marker-start")]).filter(Boolean);
    return { warn:document.querySelectorAll("path.wire.warn").length,
      decoFilled:[...document.querySelectorAll("svg.deco")].filter(s=>s.innerHTML.trim()).length,
      needDeco:kinds.filter(k=>!["box","class","interface","enum","datatype","object","state","action"].includes(k)).length,
      shaped:document.querySelectorAll(".box.shaped").length,
      markersMissing:used.filter(u=>!document.querySelector(u.slice(4,-1))).length,
      dashed:document.querySelectorAll("path.wire.dashed").length,
      endLabels:document.querySelectorAll("text.wlabel.end:not(.bg)").length,
      zoneKinds:[...new Set([...document.querySelectorAll(".zone")].map(z=>z.className.replace("zone","").trim()))].sort(),
      dividers:document.querySelectorAll(".zone .zdiv").length,
      compartments:document.querySelectorAll(".box.k-class .cp:not(.none)").length,
      stereo:[...document.querySelectorAll(".box .st")].filter(e=>e.style.display!=="none").map(e=>e.textContent) }; })()`);
  assert.equal(r.warn, 0);
  assert.equal(r.decoFilled, r.needDeco);           // every non-rectangle kind (and component/artifact icons) drew its outline
  assert.ok(r.shaped >= 20);
  assert.equal(r.markersMissing, 0);
  assert.ok(r.dashed >= 8); assert.ok(r.endLabels >= 4);
  assert.deepEqual(r.zoneKinds, ["boundary", "frame", "lane"]);
  assert.equal(r.dividers, 1);
  assert.equal(r.compartments, 8);                 // 4 classes × attrs + ops
  for (const t of ["«interface»", "«enumeration»", "«dataType»", "«component»", "«artifact»", "«device»"]) assert.ok(r.stereo.includes(t), t);
  assert.equal(p.logs.filter(l => /EXCEPTION/.test(l)).length, 0, p.logs.join("\n"));
  await p.close();
});

test("editing a .daigram.json live: Save writes the file; a change on disk reloads the page", opts, async () => {
  const { sourceText, readSource } = await import("../daigram.mjs");
  const f = path.join(dir, "live.daigram.json"), core = (await import("../daigram.mjs")).loadCore();
  fs.writeFileSync(f, sourceText({ daigram: 1, title: "Live", root: core.serializeDiagram(core.normDiag({ GRID: { cols: 18, rows: 11, cell: 64, gap: 5 } })) }));
  const p = await openPage(chrome, `http://127.0.0.1:${srv.port}/live.daigram.json?view`);
  await p.waitFor(`window.daigram && daigram.query({q:"view"}).recording.sink==="server"`);
  assert.equal(await p.eval(`SOURCE`), "/live.daigram.json");
  assert.equal((await p.eval(`daigram.dispatch({op:"addBox",id:"x",n:"From page",col:1,row:1,cw:3,ch:2})`)).ok, true);
  assert.equal(await p.eval(`document.getElementById("btnSave").textContent`), "Save •");          // unsaved
  assert.equal((await p.eval(`daigram.dispatch({op:"save"})`)).writing, "/live.daigram.json");
  await p.waitFor(`document.getElementById("btnSave").textContent.startsWith("Saved")`);
  assert.equal(readSource(fs.readFileSync(f, "utf8")).root.boxes.x.n, "From page");
  // an agent changes the file on disk → the (clean) page reloads with it
  const src = readSource(fs.readFileSync(f, "utf8")); src.root.boxes.y = { n: "From disk", s: "", cls: "", col: 6, row: 1, cw: 3, ch: 2 };
  fs.writeFileSync(f, sourceText(src));
  await p.waitFor(`!!document.getElementById("box-y")`, 6000);
  assert.equal(await p.eval(`!!document.getElementById("box-x")`), true);
  // the downloadable single file is self-contained and not tied to the source
  assert.match(await p.eval(`buildSaveHtml()`), /let SOURCE=null;/);
  await p.close();
});

test("draw inside an expanded box: resize it (neighbours make room), add boxes and an arrow in it", opts, async () => {
  const { sourceText, readSource, loadCore } = await import("../daigram.mjs"), core = loadCore();
  const f = path.join(dir, "nest.daigram.json"), root = core.normDiag({ GRID: { cols: 18, rows: 11, cell: 64, gap: 5 } });
  root.BOX.p = { n: "P", s: "", cls: "", col: 1, row: 1, cw: 3, ch: 2 }; root.BOX.q = { n: "Q", s: "", cls: "", col: 6, row: 1, cw: 3, ch: 2 };
  fs.writeFileSync(f, sourceText({ daigram: 1, title: "Nest", root: core.serializeDiagram(root) }));
  const p = await openPage(chrome, `http://127.0.0.1:${srv.port}/nest.daigram.json?view`);
  await p.send("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1300, deviceScaleFactor: 1, mobile: false });
  await p.waitFor(`window.daigram && daigram.query({q:"view"}).recording.sink==="server"`);
  const last = () => p.eval(`(()=>{const l=daigram.log().filter(e=>e.k==="cmd");return l[l.length-1]})()`);
  const cellPt = (c, r) => p.eval(`(()=>{const s=stage.getBoundingClientRect(),k=GRID.cell*zoom;return [s.left+(${c}+.5)*k,s.top+(${r}+.5)*k]})()`);
  await p.eval(`daigram.dispatch({op:"setMode",edit:true})`);
  await p.eval(`document.getElementById("box-p").querySelector(".boxexp").click()`);   // ＋ create a sub-canvas
  assert.equal((await last()).cmd.op, "addSub");
  await p.eval(`document.getElementById("box-p").querySelector(".boxexp").click()`);   // ⤢ expand
  const P = await p.eval(`[BOX.p.col,BOX.p.row,BOX.p.cw,BOX.p.ch]`);
  // resize the expanded box with its SE lever: two cells wider
  const [px, py] = await p.center("p"); await p.mouse("mousePressed", px, py); await p.mouse("mouseReleased", px, py, 0);
  const se = await p.eval(`(()=>{const r=document.querySelector(".lever.se").getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  const k = await p.eval(`GRID.cell*zoom`); await p.drag(se[0], se[1], se[0] + 2 * k, se[1]);
  const rs = await last();
  assert.deepEqual(rs.cmd, { op: "setOpenSize", id: "p", cw: P[2] - 2 + 2, ch: P[3] - 3 });
  assert.deepEqual(await p.eval(`[ROOT.BOX.p.cw,ROOT.BOX.p.ch]`), [3, 2]);                // collapsed size untouched
  const P2 = await p.eval(`[BOX.p.col,BOX.p.row,BOX.p.cw,BOX.p.ch]`), Q = await p.eval(`[BOX.q.col,BOX.q.row,BOX.q.cw,BOX.q.ch]`);
  assert.ok(Q[0] >= P2[0] + P2[2] || Q[1] >= P2[1] + P2[3], "q was pushed clear: " + JSON.stringify({ P2, Q }));
  // + Box twice inside, then an arrow between them. The drags start on the box's margin row (row +1, above the
  // drawing area) — anywhere inside an expanded box counts, the new box snaps into the drawing area
  for (const dc of [0, 4]) {
    await p.eval(`document.querySelector('.tool[data-tool="box"]').click()`);
    const [x0, y0] = await cellPt(P2[0] + 1 + dc, P2[1] + 1), [x1, y1] = await cellPt(P2[0] + 2 + dc, P2[1] + 2);
    await p.drag(x0, y0, x1, y1);
    const a = await last(); assert.equal(a.cmd.op, "addBox"); assert.equal(a.cmd.parent, "p"); assert.deepEqual([a.cmd.col, a.cmd.row], [dc, 0]); assert.equal(a.ok, true);
  }
  await p.eval(`document.querySelector('.tool[data-tool="arrow"]').click()`);
  const [ax, ay] = await p.center("p/n0"), [bx, by] = await p.center("p/n1"); await p.drag(ax, ay, bx, by);
  assert.deepEqual((await last()).cmd, { op: "addWire", from: "p/n0", to: "p/n1" });
  assert.equal(await p.eval(`document.querySelectorAll("path.wire.warn").length`), 0);
  await p.eval(`daigram.dispatch({op:"save"})`); await p.waitFor(`document.getElementById("btnSave").textContent.startsWith("Saved")`);
  const saved = readSource(fs.readFileSync(f, "utf8")).root.boxes.p;
  assert.deepEqual([saved.cw, saved.ch, saved.ecw, Object.keys(saved.sub.boxes).length, saved.sub.wires.length], [3, 2, P[2] - 2 + 2, 2, 1]);
  assert.equal(p.logs.filter(l => /EXCEPTION/.test(l)).length, 0, p.logs.join("\n"));
  await p.close();
});

test("cross-level arrows: drawn only when both ends are displayed; drawn and deleted with the mouse", opts, async () => {
  const p = await openPage(chrome, `http://127.0.0.1:${srv.port}/t.html`);
  await p.send("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1300, deviceScaleFactor: 1, mobile: false });
  await p.waitFor(`window.daigram`);
  await p.eval(`try{localStorage.clear()}catch(_){}; daigram.dispatch({op:"collapseAll"})`);
  assert.equal((await p.eval(`daigram.batch([{op:"addBox",parent:"c",id:"x",n:"X",col:1,row:1,cw:3,ch:2},
    {op:"addWire",from:"a",to:"b/h1",label:"W1"},{op:"addWire",from:"b/h2",to:"c/x",label:"W2"},
    {op:"addWire",from:"b/h3/w1",to:"c/x",label:"W3"},{op:"addWire",from:"b/h1",to:"b/h3/w2",label:"W4"}])`)).ok, true);
  const want = { "": [], "b": ["W1"], "c": [], "b,c": ["W1", "W2"], "b,b/h3": ["W1", "W4"], "b,b/h3,c": ["W1", "W2", "W3", "W4"], "b/h3,c": [] };
  for (const [ex, exp] of Object.entries(want)) {
    await p.eval(`EXPANDED=new Set(${JSON.stringify(ex ? ex.split(",") : [])}); render();`);
    assert.deepEqual(await p.eval(`wireNodes.map(n=>W[n.wi].label||"").filter(l=>/^W\\d$/.test(l)).sort()`), exp, "expanded {" + ex + "}");
    assert.equal(await p.eval(`document.querySelectorAll("path.wire.warn").length`), 0);
  }
  await p.eval(`EXPANDED=new Set(["b","c"]); render(); daigram.dispatch({op:"setMode",edit:true}); daigram.dispatch({op:"fit",on:true})`);
  await p.eval(`document.querySelector('.tool[data-tool="arrow"]').click()`);
  const [ax, ay] = await p.center("b/h1"), [bx, by] = await p.center("c/x"); await p.drag(ax, ay, bx, by, 14);
  const last = () => p.eval(`(()=>{const l=daigram.log().filter(e=>e.k==="cmd");return l[l.length-1]})()`);
  assert.deepEqual((await last()).cmd, { op: "addWire", from: "b/h1", to: "c/x" });
  assert.equal(await p.eval(`ROOT.W.some(w=>w.from==="b/h1"&&w.to==="c/x")`), true);   // stored at the common ancestor (root)
  await p.eval(`document.querySelector('.tool[data-tool="del"]').click()`);
  const mid = await p.eval(`(()=>{const n=wireNodes.find(n=>n.from==="b/h1"&&n.to==="c/x"), q=n.path.getPointAtLength(n.path.getTotalLength()/2), s=stage.getBoundingClientRect(); return [s.left+q.x*zoom, s.top+q.y*zoom]})()`);
  await p.mouse("mousePressed", mid[0], mid[1]); await p.mouse("mouseReleased", mid[0], mid[1], 0);
  assert.deepEqual((await last()).cmd, { op: "deleteWire", from: "b/h1", to: "c/x", nth: 0 });
  assert.equal(p.logs.filter(l => /EXCEPTION/.test(l)).length, 0, p.logs.join("\n"));
  await p.eval(`daigram.dispatch({op:"setMode",edit:false}); daigram.dispatch({op:"collapseAll"}); localStorage.clear()`);
  await p.close();
});
