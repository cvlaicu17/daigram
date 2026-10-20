#!/usr/bin/env node
// daigram.mjs — local server + agent CLI for daigram diagrams. No dependencies (Node >= 20).
//
// The diagram model only changes through commands (see `daigram commands`). This tool runs the SAME
// DOM-free core the page uses (the <script id="daigram-core"> block of the HTML), so a command means
// exactly the same thing headless and in the browser, and every recording replays in both.
//
//   daigram serve [dir] [--port 4173] [--rec-dir recordings]    serve pages, record sessions to disk, live link
//   daigram commands [--json]                                     the command + query catalog
//   daigram new <out.html> [--title T]                            a fresh, empty diagram from the template
//   daigram apply <diagram.html> <cmds.jsonl|-> [-o out.html] [--keep-going] [--rec-dir D | --no-rec]
//   daigram query <diagram.html> '<json query>'
//   daigram upgrade <diagram.html>... [--template T] [--dry-run]  swap in this engine; keep CONFIG, title, header, own CSS
//   daigram replay <recording.jsonl> [--session ID]               headless replay; checks every model hash
//   daigram send '<json>'|- [--page /x.html] [--port 4173]        drive the page open in the browser (live)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, "diagram-template.html");
const DEFAULT_PORT = 4173;

/* ============================ loading a diagram ============================ */
const CORE_RE = /<script id="daigram-core">([\s\S]*?)<\/script>/;
const CONFIG_RE = /\/\* =+ CONFIG \(edit this\) =+ \*\/\n([\s\S]*?)\n\/\* =+ \*\//;
const LEGACY_CONFIG_RE = /(let GRID=[\s\S]*?)\nlet ROOT=\{GRID/;

// The core of `html` (or of the bundled template, for pages built before the core existed), plus the
// CONFIG literals evaluated in the same sandbox. Returns {core, root, html}.
export function loadDiagramHtml(html) {
  const coreSrc = (html.match(CORE_RE) || fs.readFileSync(TEMPLATE, "utf8").match(CORE_RE))[1];
  const m = html.match(CONFIG_RE) || html.match(LEGACY_CONFIG_RE);
  if (!m) throw new Error("no CONFIG block found — is this a daigram page?");
  const ctx = vm.createContext({});
  const core = vm.runInContext(coreSrc + "\n;DaigramCore", ctx, { timeout: 2000 });
  core.addBoxClasses(core.boxClassesInCss(styleOf(html)));   // the page's own .box.<cls> styles are valid classes
  const pick = ["GRID", "BOX", "W", "ZONES", "DESC", "FLOWS"].map(k => `${k}:typeof ${k}==="undefined"?undefined:${k}`).join(",");
  const cfg = vm.runInContext(m[1] + `\n;({${pick}})`, ctx, { timeout: 2000 });
  return { core, html, root: core.normDiag({ GRID: cfg.GRID, BOX: cfg.BOX, W: cfg.W, ZONES: cfg.ZONES, DESC: cfg.DESC, FLOWS: cfg.FLOWS }) };
}
export const loadDiagram = file => loadDiagramHtml(fs.readFileSync(file, "utf8"));
const styleOf = html => { const a = html.indexOf("<style>"), b = html.indexOf("</style>"); return a >= 0 && b > a ? html.slice(a + 7, b) : ""; };

/* Upgrade a diagram to the engine of `templateHtml`: keep its CONFIG (verbatim), <title>, header text,
   BUILD stamp and its own CSS lines (lines in its <style> the template doesn't have, e.g. custom
   .box.<cls> colours); take everything else — the engine — from the template. Returns {html, kept}. */
export function upgradeHtml(oldHtml, templateHtml) {
  const cfg = oldHtml.match(CONFIG_RE), legacy = !cfg && oldHtml.match(LEGACY_CONFIG_RE);
  if (!cfg && !legacy) throw new Error("no CONFIG block found — is this a daigram page?");
  let html = templateHtml.replace(CONFIG_RE, m => m.replace(/(\*\/\n)[\s\S]*?(\n\/\* =+ \*\/)$/, (x, a, b) => a + (cfg ? cfg[1] : legacy[1]) + b));
  const kept = { title: false, header: false, build: false, css: 0 };
  const title = oldHtml.match(/<title>[^<]*<\/title>/);
  if (title) { html = html.replace(/<title>[^<]*<\/title>/, () => title[0]); kept.title = true; }
  const head = re => (oldHtml.match(re) || [])[0], hi = head(/<div class="headinfo">[\s\S]*?<\/div>/);
  if (hi) { html = html.replace(/<div class="headinfo">[\s\S]*?<\/div>/, () => hi); kept.header = true; }
  const build = head(/let BUILD="[^"]*"/);
  if (build) { html = html.replace(/let BUILD="[^"]*"/, () => build); kept.build = true; }
  const tplCss = new Set(styleOf(templateHtml).split("\n").map(l => l.trim()));
  const extra = styleOf(oldHtml).split("\n").filter(l => l.trim() && !tplCss.has(l.trim()));
  if (extra.length) { html = html.replace("</style>", () => extra.join("\n") + "\n</style>"); kept.css = extra.map(l => l.trim()); }
  return { html, kept };
}
export const loadCore = () => loadDiagramHtml(fs.readFileSync(TEMPLATE, "utf8")).core;

// A page whose CONFIG is `root`. A fresh BUILD stamp makes browsers drop a stale saved layout of the old version.
export function writeHtml(core, html, root) {
  return core.spliceConfig(html, root).replace(/let BUILD="[^"]*"/, `let BUILD="cli-${Date.now().toString(36)}"`);
}

// Commands from a JSON array, a single JSON object, or JSONL (blank lines and // or # comments skipped).
export function parseCommands(text) {
  const t = text.trim();
  if (t.startsWith("[")) return JSON.parse(t);
  return t.split("\n").map((l, i) => [l.trim(), i + 1]).filter(([l]) => l && !l.startsWith("//") && !l.startsWith("#"))
    .map(([l, n]) => { try { return JSON.parse(l); } catch (e) { throw new Error(`line ${n}: not JSON — ${e.message}`); } });
}
export const parseLog = text => text.split("\n").filter(l => l.trim()).map(l => JSON.parse(l));

/* ============================ recordings on disk ============================ */
const seg = s => s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
// recordings/<page path without .html>/<session>.jsonl — e.g. recordings/examples/example-webapp/2026-….jsonl
export function recFile(recDir, page, session) {
  const parts = String(page || "diagram").replace(/^\/+/, "").replace(/\.html?$/i, "").split("/").filter(Boolean).map(seg);
  return path.join(recDir, ...(parts.length ? parts : ["index"]), seg(String(session || "session")) + ".jsonl");
}
function appendLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}
const newSession = suffix => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + Math.random().toString(36).slice(2, 6) + (suffix || "");

/* ============================ headless replay ============================ */
// Mirrors the page: model commands through the core, undo/redo history (commit after every model command
// unless nc, dedupe, cap 80), the EXPANDED set (it is part of each history snapshot), boot then histInit.
export function replayHeadless(core, lines, sessionId) {
  const heads = lines.filter(l => l.k === "session");
  const hdr = sessionId ? heads.find(h => h.session === sessionId) : heads[heads.length - 1];
  if (!hdr || !hdr.state) return { ok: false, error: "no session header with a starting state in this log" };
  const cmds = lines.filter(l => l.k === "cmd" && l.session === hdr.session).sort((a, b) => a.seq - b.seq);
  let root = core.buildDiagram(core.stateRoot(hdr.state)), expanded = [];
  const valid = list => { const v = new Set(core.allSubFids(root, "", [])); return (list || []).filter(f => v.has(f)); };
  expanded = valid(hdr.state.expanded);
  const snap = () => ({ v: 4, root: core.serializeDiagram(root), expanded: [...expanded] });
  let history = [], hidx = -1;
  const histInit = () => { history = [snap()]; hidx = 0; };
  const commit = () => { const s = snap(); if (hidx >= 0 && JSON.stringify(history[hidx]) === JSON.stringify(s)) return;
    history = history.slice(0, hidx + 1); history.push(s); if (history.length > 80) history.shift(); hidx = history.length - 1; };
  const restore = st => { root = core.buildDiagram(core.stateRoot(st)); expanded = valid(st.expanded); };
  const out = { ok: true, of: hdr.session, steps: 0, skipped: 0, viewOnly: 0, diverged: null };
  let booted = false;
  for (const l of cmds) {
    if (!booted && l.src !== "boot") { histInit(); booted = true; }
    const c = l.cmd || {}, sp = core.COMMANDS[c.op];
    if (sp && sp.effect) { out.skipped++; continue; }
    let r, checkOk = true;
    if (sp && sp.view) {
      r = { ok: true };
      if (c.op === "undo") { if (hidx > 0) restore(history[--hidx]); }
      else if (c.op === "redo") { if (hidx < history.length - 1) restore(history[++hidx]); }
      else if (c.op === "import") { r = core.apply(root, { op: "load", state: c.state });
        if (r.ok) { root = r.root; expanded = valid(c.state.expanded); if (!expanded.length) core.apply(root, { op: "normalize" }); histInit(); } }
      else if (c.op === "expand") { const b = core.boxByFid(root, c.id); if (b && b.sub && !expanded.includes(c.id)) expanded.push(c.id); r = { ok: !!(b && b.sub) }; }
      else if (c.op === "collapse") { r = { ok: expanded.includes(c.id) }; expanded = expanded.filter(f => f !== c.id); }
      else if (c.op === "expandAll") expanded = core.allSubFids(root, "", []);
      else if (c.op === "collapseAll") expanded = [];
      else { out.viewOnly++; checkOk = false; }   // pure view (select, zoom…): no model effect, its ok can't be judged headless
    } else {
      r = core.apply(root, c);
      if (r.ok) {
        if (c.op === "load") { root = r.root; expanded = valid(c.state.expanded); }
        else if (c.op === "deleteBox") expanded = expanded.filter(f => f !== c.id && !f.startsWith(c.id + "/"));
        else if (c.op === "reparentBox" && r.fid !== c.id) expanded = expanded.map(f => f === c.id ? r.fid : f.startsWith(c.id + "/") ? r.fid + f.slice(c.id.length) : f);
        if (!l.nc) commit();
      }
    }
    out.steps++;
    const h = core.hash(root);
    if (!out.diverged && ((checkOk && r.ok !== l.ok) || (l.h && h !== l.h)))
      out.diverged = { seq: l.seq, op: c.op, recorded: { ok: l.ok, h: l.h, error: l.error }, replayed: { ok: r.ok, h, error: r.error } };
  }
  out.ok = !out.diverged; out.hash = core.hash(root); out.root = root;
  return out;
}

/* ============================ server ============================ */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/markdown; charset=utf-8" };
const sendJson = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
function readBody(req, limit = 32 << 20) {
  return new Promise((resolve, reject) => { let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(new Error("body is not JSON")); } });
    req.on("error", reject); });
}
function serveFile(res, base, rel) {
  const p = path.resolve(base, "." + rel);
  if (p !== base && !p.startsWith(base + path.sep)) return sendJson(res, 403, { ok: false, error: "outside the served directory" });
  let st; try { st = fs.statSync(p); } catch { return sendJson(res, 404, { ok: false, error: "not found: " + rel }); }
  if (st.isDirectory()) {
    if (fs.existsSync(path.join(p, "index.html"))) return serveFile(res, base, path.posix.join(rel, "index.html"));
    const items = fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory() ? !d.name.startsWith(".") && d.name !== "node_modules" : /\.html?$/i.test(d.name))
      .map(d => { const href = path.posix.join(rel, d.name) + (d.isDirectory() ? "/" : ""); return `<li><a href="${encodeURI(href)}">${d.name}${d.isDirectory() ? "/" : ""}</a></li>`; });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(`<!doctype html><meta charset="utf-8"><title>daigram</title><body style="font:14px system-ui;background:#0e1116;color:#e6edf3"><h3>${rel}</h3><ul>${items.join("")}</ul>`);
  }
  res.writeHead(200, { "content-type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(p).pipe(res);
}

export function startServer({ dir = process.cwd(), port = DEFAULT_PORT, recDir, quiet = false } = {}) {
  const base = path.resolve(dir), recBase = path.resolve(recDir || path.join(base, "recordings"));
  const clients = new Map();   // live pages: id -> {page, session, res, since}
  const pending = new Map();   // agent requests waiting for a page's answer: id -> {resolve, timer}
  let seq = 0;
  const log = (...a) => { if (!quiet) console.log(...a); };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    try {
      if (u.pathname === "/api/hello")
        return sendJson(res, 200, { daigram: true, file: recFile(recBase, u.searchParams.get("page"), u.searchParams.get("session")) });
      if (u.pathname === "/api/rec" && req.method === "POST") {
        const b = await readBody(req); if (!Array.isArray(b.lines)) return sendJson(res, 400, { ok: false, error: "lines[] missing" });
        const f = recFile(recBase, b.page, b.session); appendLines(f, b.lines);
        return sendJson(res, 200, { ok: true, n: b.lines.length });
      }
      if (u.pathname === "/api/live") {   // Server-Sent Events: commands for this page
        const id = ++seq; res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": connected\n\n");
        const c = { page: u.searchParams.get("page") || "", session: u.searchParams.get("session") || "", res, since: Date.now() };
        clients.set(id, c); log(`live: ${c.page} (${c.session}) connected`);
        const ka = setInterval(() => res.write(": ka\n\n"), 20000);
        req.on("close", () => { clearInterval(ka); clients.delete(id); log(`live: ${c.page} (${c.session}) gone`); });
        return;
      }
      if (u.pathname === "/api/live/result" && req.method === "POST") {
        const b = await readBody(req), p = pending.get(b.id);
        if (p) { clearTimeout(p.timer); pending.delete(b.id); p.resolve(b.res); }
        return sendJson(res, 200, { ok: true });
      }
      if (u.pathname === "/api/pages") return sendJson(res, 200, { ok: true, pages: [...clients.values()].map(c => ({ page: c.page, session: c.session, since: new Date(c.since).toISOString() })) });
      if (u.pathname === "/api/cmd" && req.method === "POST") {   // an agent → the page open in the browser
        const b = await readBody(req);
        const live = [...clients.values()].filter(c => (!b.session || c.session === b.session) && (!b.page || c.page === b.page));
        if (!live.length) return sendJson(res, 409, { ok: false, error: "no live page" + (b.page ? " " + b.page : "") + " — open it from this server (http://127.0.0.1:" + server.address().port + "/…) first",
          pages: [...clients.values()].map(c => c.page) });
        const target = live.sort((x, y) => y.since - x.since)[0], id = "r" + (++seq);
        const msg = { id }; for (const k of ["cmd", "cmds", "query", "replay", "opts"]) if (b[k] !== undefined) msg[k] = b[k];
        const result = await new Promise(resolve => {
          pending.set(id, { resolve, timer: setTimeout(() => { pending.delete(id); resolve({ ok: false, error: "the page did not answer in time" }); }, b.timeout || 15000) });
          target.res.write("data: " + JSON.stringify(msg) + "\n\n");
        });
        return sendJson(res, 200, Object.assign({ page: target.page, session: target.session }, result));
      }
      if (u.pathname.startsWith("/api/")) return sendJson(res, 404, { ok: false, error: "unknown endpoint " + u.pathname });
      const rel = decodeURIComponent(u.pathname);
      if (rel.startsWith("/recordings/") && !recBase.startsWith(base + path.sep)) return serveFile(res, recBase, rel.slice("/recordings".length));
      return serveFile(res, base, rel);
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => {
    log(`daigram serving ${base}\n  open:       http://127.0.0.1:${server.address().port}/\n  recordings: ${recBase}`);
    resolve({ server, port: server.address().port, recDir: recBase, close: () => new Promise(r => { for (const c of clients.values()) c.res.end(); server.close(r); }) });
  }));
}

/* ============================ CLI ============================ */
function args(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i];
    if (a === "-o") opt.o = argv[++i];
    else if (a.startsWith("--")) { const k = a.slice(2); if (["keep-going", "no-rec", "json", "dry-run", "force"].includes(k)) opt[k] = true; else opt[k] = argv[++i]; }
    else pos.push(a); }
  return { pos, opt };
}
const readInput = a => a === "-" ? fs.readFileSync(0, "utf8") : (fs.existsSync(a) ? fs.readFileSync(a, "utf8") : a);
const die = msg => { console.error("daigram: " + msg); process.exit(2); };

function printCatalog(cat) {
  const line = (name, sp) => { const f = Object.entries(sp.args).map(([k, t]) => t.endsWith("!") ? `${k}:${t.slice(0, -1)}` : `[${k}:${t}]`).join(" ");
    return `  ${name.padEnd(12)} ${f}\n  ${"".padEnd(12)} ${sp.doc}`; };
  const groups = [["MODEL COMMANDS  (headless: apply · live: send)", c => !c.view], ["VIEW COMMANDS  (live page only: send)", c => c.view]];
  for (const [title, pick] of groups) { console.log(title);
    for (const [k, sp] of Object.entries(cat.commands)) if (pick(sp)) console.log(line(k, sp) + (sp.effect ? "  (side effect; skipped on replay)" : ""));
    console.log(); }
  console.log("QUERIES  ({\"q\":…})"); for (const [k, sp] of Object.entries(cat.queries)) console.log(line(k, sp) + (sp.view ? "  (live only)" : ""));
  console.log("\nTYPES"); for (const [k, d] of Object.entries(cat.types)) console.log(`  ${k.padEnd(10)} ${d}`);
}

async function main(argv) {
  const [cmd, ...rest] = argv, { pos, opt } = args(rest);
  switch (cmd) {
    case "serve": {
      const s = await startServer({ dir: pos[0] || process.cwd(), port: opt.port !== undefined ? +opt.port : DEFAULT_PORT, recDir: opt["rec-dir"] });
      process.on("SIGINT", () => s.close().then(() => process.exit(0)));
      return;
    }
    case "commands": {
      const cat = loadCore().catalog();
      return opt.json ? console.log(JSON.stringify(cat, null, 1)) : printCatalog(cat);
    }
    case "new": {
      if (!pos[0]) die("usage: daigram new <out.html> [--title T]");
      if (fs.existsSync(pos[0])) die(pos[0] + " already exists");
      const { core, html } = loadDiagramHtml(fs.readFileSync(TEMPLATE, "utf8")), title = opt.title || path.basename(pos[0]).replace(/\.html?$/i, "");
      const empty = core.normDiag({ GRID: { cols: 18, rows: 11, cell: 64, gap: 5 } });
      const esc = s => s.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
      let out = writeHtml(core, html, empty).replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
        .replace(/<h1>[\s\S]*?<\/h1>/, `<h1>${esc(title)}</h1>`).replace(/(<div class="headinfo">\s*<h1>[\s\S]*?<\/h1>\s*)<p>[\s\S]*?<\/p>/, "$1<p></p>");
      fs.writeFileSync(pos[0], out); console.log(JSON.stringify({ ok: true, wrote: pos[0] }));
      return;
    }
    case "apply": {
      if (pos.length < 2) die("usage: daigram apply <diagram.html> <cmds.jsonl|-> [-o out.html] [--keep-going] [--no-rec]");
      const d = loadDiagram(pos[0]), cmds = parseCommands(readInput(pos[1]));
      let root = d.root, failed = 0;
      const session = newSession("-cli"), rf = opt["no-rec"] ? null : recFile(path.resolve(opt["rec-dir"] || "recordings"), path.basename(pos[0]), session);
      const rec = [{ k: "session", seq: 0, ts: new Date().toISOString(), session, v: d.core.VERSION, src: "cli", page: path.basename(pos[0]),
        state: { v: 4, root: d.core.serializeDiagram(root), expanded: [] } }];
      for (let i = 0; i < cmds.length; i++) {
        const c = cmds[i], r = d.core.apply(root, c);
        if (r.ok && c.op === "load") root = r.root;
        const res = Object.assign({}, r); delete res.root;
        console.log(JSON.stringify(Object.assign({ i, op: c && c.op }, res)));
        const e = { k: "cmd", seq: i + 1, ts: new Date().toISOString(), session, src: "cli", cmd: c, ok: r.ok, h: d.core.hash(root) };
        if (!r.ok) e.error = r.error; const out = Object.assign({}, res); delete out.ok; delete out.error; if (Object.keys(out).length) e.result = out;
        rec.push(e);
        if (!r.ok) { failed++; if (!opt["keep-going"]) break; }
      }
      if (rf) appendLines(rf, rec);
      if (failed && !opt["keep-going"]) { console.log(JSON.stringify({ ok: false, wrote: null, failed, recording: rf, note: "nothing written: fix the failing command and re-run" })); process.exit(1); }
      const target = opt.o || pos[0];
      fs.writeFileSync(target, writeHtml(d.core, d.html, root));
      console.log(JSON.stringify({ ok: !failed, wrote: target, failed, hash: d.core.hash(root), recording: rf }));
      return process.exit(failed ? 1 : 0);
    }
    case "upgrade": {
      if (!pos.length) die("usage: daigram upgrade <diagram.html>... [--template T] [--dry-run] [--force]   (in place; keeps CONFIG, title, header, own CSS)");
      const tpl = fs.readFileSync(opt.template || TEMPLATE, "utf8"); let bad = 0;
      for (const f of pos) {
        try {
          const old = fs.readFileSync(f, "utf8"), { html, kept } = upgradeHtml(old, tpl);
          const a = loadDiagramHtml(old), b = loadDiagramHtml(html), same = a.core.hash(a.root) === b.core.hash(b.root);
          const unk = b.core.unknownFields(b.root);   // e.g. a hand-patched engine rendered extra box fields: upgrading would silently drop them
          if ((unk.box.length || unk.wire.length) && !opt.force) { bad++; console.log(JSON.stringify({ file: f, ok: false, unknownFields: unk,
            error: "the model uses fields this engine does not render — the old engine was probably patched; not written (--force to upgrade anyway)" })); continue; }
          if (!same) { bad++; console.log(JSON.stringify({ file: f, ok: false, error: "model changed during upgrade — not written" })); continue; }
          const changed = html !== old;
          if (changed && !opt["dry-run"]) fs.writeFileSync(f, html);
          console.log(JSON.stringify({ file: f, ok: true, changed, written: changed && !opt["dry-run"], hash: b.core.hash(b.root), kept }));
        } catch (e) { bad++; console.log(JSON.stringify({ file: f, ok: false, error: e.message })); }
      }
      return process.exit(bad ? 1 : 0);
    }
    case "query": {
      if (pos.length < 2) die("usage: daigram query <diagram.html> '<json>'");
      const d = loadDiagram(pos[0]), r = d.core.query(d.root, JSON.parse(readInput(pos[1])));
      console.log(JSON.stringify(r, null, 1)); return process.exit(r.ok ? 0 : 1);
    }
    case "replay": {
      if (!pos[0]) die("usage: daigram replay <recording.jsonl> [--session ID] [-o out.html]");
      const core = loadCore(), r = replayHeadless(core, parseLog(fs.readFileSync(pos[0], "utf8")), opt.session);
      if (opt.o && r.root) { const { html } = loadDiagramHtml(fs.readFileSync(TEMPLATE, "utf8")); fs.writeFileSync(opt.o, writeHtml(core, html, r.root)); r.wrote = opt.o; }
      delete r.root; console.log(JSON.stringify(r, null, 1)); return process.exit(r.ok ? 0 : 1);
    }
    case "send": {
      if (!pos[0]) die("usage: daigram send '<json>'|- [--page /x.html] [--port 4173]   (a command, a [list] of commands, or {\"q\":…})");
      const v = JSON.parse(readInput(pos[0])), body = { page: opt.page, session: opt.session };
      if (Array.isArray(v)) body.cmds = v; else if (v && v.q) body.query = v; else body.cmd = v;
      const r = await fetch(`http://127.0.0.1:${opt.port || DEFAULT_PORT}/api/cmd`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        .then(x => x.json()).catch(e => ({ ok: false, error: "no daigram server on port " + (opt.port || DEFAULT_PORT) + " (" + e.message + ")" }));
      console.log(JSON.stringify(r, null, 1)); return process.exit(r.ok ? 0 : 1);
    }
    default:
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 16).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
      return process.exit(cmd ? 2 : 0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href)
  main(process.argv.slice(2)).catch(e => die(e.message));
