// Packs design/icons/spec-7.ico from the vector badge.
//
// Why BMP frames and not PNG frames: Windows Explorer and the "change icon" dialog
// go through ExtractIconEx / SHDefExtractIcon, which only understand classic
// 32bpp BITMAPINFOHEADER frames (XOR bitmap + AND mask). PNG-compressed ICO entries
// are only decoded by newer paths (IShellItemImageFactory / GDI+), so a PNG-only
// .ico loads fine in `new Icon(...)` but renders blank as a shortcut icon.
//
// Every size is rasterised from the vector at that size (no bitmap scaling), via
// canvas inside headless Chrome, then encoded as a bottom-up BGRA bitmap.
//
// Run: node design/icons/tools/make-ico.mjs [out.ico]
//      SIZES=256 node design/icons/tools/make-ico.mjs design/icons/spec-7-256.ico
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.argv[2] || here + '../spec-7.ico';
const SIZES = (process.env.SIZES || '16,24,32,48,64,128,256').split(',').map((s) => +s.trim()).filter(Boolean);

const svg = readFileSync(here + '../spec-7-patch.svg', 'utf8').replace(/<svg[^>]*>/, (m) => m.replace(/width="[^"]*"/, '').replace(/height="[^"]*"/, ''));

const tmp = (process.env.TEMP || '/tmp') + '/spec7-ico-' + Date.now();
mkdirSync(tmp, { recursive: true });
const htmlPath = tmp + '/icon.html';
writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}</style>
${svg}
<script>
window.raster = (S) => new Promise((resolve, reject) => {
  try {
    const el = document.querySelector('svg');
    el.setAttribute('width', S);
    el.setAttribute('height', S);
    const xml = new XMLSerializer().serializeToString(el);
    const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, S, S);
      ctx.drawImage(img, 0, 0, S, S);
      const d = ctx.getImageData(0, 0, S, S).data;
      let bin = '';
      const chunk = 8192;
      for (let i = 0; i < d.length; i += chunk) {
        bin += String.fromCharCode.apply(null, Array.prototype.slice.call(d, i, i + chunk));
      }
      resolve({ w: S, b64: btoa(bin) });
    };
    img.onerror = (e) => reject(new Error('svg image load failed'));
    img.src = url;
  } catch (e) { reject(e); }
});
</script>`);

const port = 9400 + (process.pid % 300);
const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tmp}/profile`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu',
  '--force-color-profile=srgb', '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 150; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const p = list.find((t) => t.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(120);
}
if (!wsUrl) { console.error('no page target'); proc.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const call = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pend.set(id, r)); };

await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 400, deviceScaleFactor: 1, mobile: false });
await call('Page.navigate', { url: 'file:///' + htmlPath.replace(/\\/g, '/') });
for (let i = 0; i < 150; i++) {
  const r = await call('Runtime.evaluate', { expression: 'document.readyState + ":" + (typeof window.raster)', returnByValue: true });
  if (r.result?.result?.value === 'complete:function') break;
  await sleep(80);
}
await sleep(200);

// --- classic 32bpp BMP frame (bottom-up BGRA + 1bpp AND mask) ---
const bmpFrame = (rgba, w) => {
  const h = w;
  const rowSize = w * 4;
  const maskRow = Math.ceil(w / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);            // biSize
  header.writeInt32LE(w, 4);              // biWidth
  header.writeInt32LE(h * 2, 8);          // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12);            // biPlanes
  header.writeUInt16LE(32, 14);           // biBitCount
  header.writeUInt32LE(0, 16);            // biCompression = BI_RGB
  header.writeUInt32LE(rowSize * h + maskRow * h, 20);
  const xor = Buffer.alloc(rowSize * h);
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4;   // bottom-up
    const dstRow = y * rowSize;
    for (let x = 0; x < w; x++) {
      const s = srcRow + x * 4, d = dstRow + x * 4;
      xor[d] = rgba[s + 2];       // B
      xor[d + 1] = rgba[s + 1];   // G
      xor[d + 2] = rgba[s];       // R
      xor[d + 3] = rgba[s + 3];   // A
    }
  }
  const and = Buffer.alloc(maskRow * h);  // all zero: transparency comes from alpha
  return Buffer.concat([header, xor, and]);
};

const frames = [];
for (const size of SIZES) {
  const r = await call('Runtime.evaluate', { expression: `window.raster(${size})`, awaitPromise: true, returnByValue: true });
  const v = r.result?.result?.value;
  if (!v?.b64) { console.error('raster failed @' + size + ': ' + JSON.stringify(r).slice(0, 300)); ws.close(); proc.kill(); process.exit(1); }
  const rgba = Buffer.from(v.b64, 'base64');
  if (rgba.length !== size * size * 4) throw new Error('bad raster size @' + size + ': ' + rgba.length);
  const frame = bmpFrame(rgba, size);
  frames.push({ size, buf: frame });
}
frames.sort((a, b) => a.size - b.size);

// --- ICO container with BITMAPINFOHEADER entries ---
const n = frames.length;
const head = Buffer.alloc(6 + 16 * n);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(n, 4);
let offset = head.length;
frames.forEach(({ size, buf }, i) => {
  const o = 6 + i * 16;
  head.writeUInt8(size >= 256 ? 0 : size, o);
  head.writeUInt8(size >= 256 ? 0 : size, o + 1);
  head.writeUInt8(0, o + 2);
  head.writeUInt8(0, o + 3);
  head.writeUInt16LE(1, o + 4);
  head.writeUInt16LE(32, o + 6);
  head.writeUInt32LE(buf.length, o + 8);
  head.writeUInt32LE(offset, o + 12);
  offset += buf.length;
});
writeFileSync(out, Buffer.concat([head, ...frames.map((f) => f.buf)]));

ws.close(); proc.kill(); await sleep(250);
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(JSON.stringify({ ok: true, out, format: 'BMP (BITMAPINFOHEADER)', entries: frames.map((f) => f.size + ':' + f.buf.length + 'B'), bytes: readFileSync(out).length }));
