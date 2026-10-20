// Minimal Chrome DevTools Protocol driver for the page tests (no dependencies; Node >= 22 for WebSocket).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(p => fs.existsSync(p));
export const haveChrome = !!CHROME;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launchChrome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dg-chrome-"));
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + dir, "--no-first-run",
    "--no-default-browser-check", "--disable-gpu", "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
  const portFile = path.join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = +fs.readFileSync(portFile, "utf8").split("\n")[0];
  return { port, close: async () => { proc.kill(); await sleep(200); fs.rmSync(dir, { recursive: true, force: true }); } };
}

export async function openPage(chrome, url) {
  const t = await (await fetch(`http://127.0.0.1:${chrome.port}/json/new?${encodeURI(url)}`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map(), logs = [];
  ws.onmessage = ev => { const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
    else if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.type + ": " + m.params.args.map(a => a.value ?? a.description).join(" "));
    else if (m.method === "Runtime.exceptionThrown") logs.push("EXCEPTION: " + m.params.exceptionDetails.exception?.description); };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  const page = {
    logs, send,
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async waitFor(expr, ms = 5000) {
      for (let t = 0; t < ms; t += 50) { try { if (await page.eval(expr)) return; } catch {} await sleep(50); }
      throw new Error("timeout waiting for: " + expr + "\n" + logs.join("\n"));
    },
    mouse: (type, x, y, buttons = 1) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1, pointerType: "mouse" }),
    // press at (x0,y0), move in steps to (x1,y1), release — a real pointer drag
    async drag(x0, y0, x1, y1, steps = 8) {
      await page.mouse("mouseMoved", x0, y0, 0); await page.mouse("mousePressed", x0, y0);
      for (let i = 1; i <= steps; i++) { await page.mouse("mouseMoved", x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); await sleep(10); }
      await page.mouse("mouseReleased", x1, y1, 0); await sleep(50);
    },
    // middle of the top-left grid cell of the box with this fid, in viewport pixels (never on a cell boundary)
    center: fid => page.eval(`(()=>{const r=document.getElementById(${JSON.stringify("box-" + fid)}).getBoundingClientRect(),c=GRID.cell*zoom;return [r.left+c/2-GRID.gap*zoom/2,r.top+c/2-GRID.gap*zoom/2]})()`),
    close: async () => { ws.close(); await fetch(`http://127.0.0.1:${chrome.port}/json/close/${t.id}`).catch(() => {}); },
  };
  return page;
}
