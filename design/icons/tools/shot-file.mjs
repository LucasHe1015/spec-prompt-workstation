// usage: node shot.mjs <fileUrl> <out.png> [w] [h] [scale] [waitMs]
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [, , url, out, w = '1400', h = '800', scale = '2', wait = '600'] = process.argv;
const width = +w, height = +h, dpr = +scale;
const port = 9300 + (process.pid % 400);
const udd = `${process.env.TEMP}/cdp-${port}-${Date.now()}`;
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu',
  '--force-color-profile=srgb', '--font-render-hinting=none', 'about:blank',
], { stdio: 'ignore' });
const j = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
let wsUrl;
for (let i = 0; i < 120; i++) { try { wsUrl = (await j('/json/version')).webSocketDebuggerUrl; break; } catch { await sleep(120); } }
if (!wsUrl) { console.error('no chrome'); proc.kill(); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((r, e) => { ws.onopen = r; ws.onerror = e; });
let seq = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}, sessionId) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params, sessionId })); return new Promise((r) => pend.set(id, r)); };
const page = (await send('Target.getTargets')).result.targetInfos.find((t) => t.type === 'page');
const at = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const call = (m, p) => send(m, p, at.result.sessionId);
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
await call('Page.navigate', { url });
for (let i = 0; i < 150; i++) { const r = await call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }); if (r.result?.result?.value === 'complete') break; await sleep(100); }
await sleep(+wait);
const shot = await call('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log(JSON.stringify({ ok: true, out }));
ws.close(); proc.kill(); await sleep(200);
try { rmSync(udd, { recursive: true, force: true }); } catch {}
