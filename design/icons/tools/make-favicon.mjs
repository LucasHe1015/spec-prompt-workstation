// Rebuild the <link rel="icon"> data URI in public/index.html from spec-7-favicon.svg.
// Run: node design/icons/tools/make-favicon.mjs   (from the repo root)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));           // design/icons/tools/
const svgPath = here + '../spec-7-favicon.svg';
const indexPath = here + '../../../public/index.html';

const svg = readFileSync(svgPath, 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/>\s+</g, '><')
  .trim();
const uri = 'data:image/svg+xml,' + encodeURIComponent(svg);

const re = /[ \t]*<link rel="icon" href="data:image\/svg\+xml,[^"]*">/;
const html = readFileSync(indexPath, 'utf8');
if (!re.test(html)) throw new Error('icon link not found in ' + indexPath);
writeFileSync(indexPath, html.replace(re, `  <link rel="icon" href="${uri}">`));
console.log('favicon written,', uri.length, 'chars');
