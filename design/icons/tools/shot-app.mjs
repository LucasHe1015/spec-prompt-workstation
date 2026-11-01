// Screenshot the running app through CDP (headless Chrome + virtual time hangs on
// this page because it polls /api/health forever — always use real time like this).
// Run: node design/icons/tools/shot-app.mjs <url> <out.png> [light|dark] [w] [h]
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [, , url = 'http://127.0.0.1:8765/', out = 'shot.png', theme = 'light', w = '1600', h = '1000'] = process.argv;
const width = +w, height = +h, dpr = 2;
const port = 9300 + (process.pid % 400);
const udd = `${process.env.TEMP || '/tmp'}/cdp-app-${port}-${Date.now()}`;
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu',
  '--force-color-profile=srgb', '--font-render-hinting=none', 'about:blank',
], { stdio: 'ignore' });

const j = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
let wsUrl;
for (let i = 0; i < 120; i++) { try { wsUrl = (await j('/json/version')).webSocketDebuggerUrl; break; } catch { await sleep(120); } }
if (!wsUrl) { console.error('chrome did not start'); proc.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}, sessionId) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params, sessionId })); return new Promise((r) => pend.set(id, r)); };
const page = (await send('Target.getTargets')).result.targetInfos.find((t) => t.type === 'page');
const at = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const call = (m, p) => send(m, p, at.result.sessionId);

await call('Page.enable'); await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
await call('Page.navigate', { url });
const ready = async () => { for (let i = 0; i < 200; i++) { const r = await call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }); if (r.result?.result?.value === 'complete') return; await sleep(100); } };
await ready();
await call('Runtime.evaluate', { expression: `localStorage.setItem('spec7:theme', ${JSON.stringify(theme)})` });
await call('Page.reload');
await ready(); await sleep(1500);
const shot = await call('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log(JSON.stringify({ ok: true, out, theme, width, height }));
ws.close(); proc.kill(); await sleep(250);
try { rmSync(udd, { recursive: true, force: true }); } catch {}
