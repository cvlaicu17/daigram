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
  assert.match(await page.eval(`document.getElementById("btnRec").textContent`), /→ file/);
});

test("toolbar buttons go through dispatch", opts, async () => {
  const expect = [["btnEdit", "setMode"], ["btnZoomIn", "zoom"], ["btnZoomOut", "zoom"], ["btnFit", "fit"], ["btnFit", "fit"],
    ["btnInfo", "info"], ["btnInfo", "info"], ["btnSave", "save"], ["btnRec", "record"], ["btnRec", "record"], ["btnEdit", "setMode"]];
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
  assert.equal(await page.eval(`document.getElementById("btnRec").textContent.startsWith("⏺")`), true);   // toggled twice → recording again
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
  assert.match(await p3.eval(`document.getElementById("btnRec").title`), /in this browser only/);
  assert.equal(page.logs.filter(l => l.startsWith("EXCEPTION")).length, 0, page.logs.join("\n"));
  await p3.close();
});
