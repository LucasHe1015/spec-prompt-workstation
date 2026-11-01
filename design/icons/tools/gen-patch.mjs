// Generates the S.P.E.C. mission patch (120×120) and its 32×32 tab icon.
// Same frame as the pre-rename badge (seamless four-colour ring, one inner hairline,
// orbit ellipse, SPEC wording) but simplified to two pieces of information and with
// the numeral taken from the top-bar wordmark (worm-style stroke, round joins).
//
// Run: node design/icons/tools/gen-patch.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const K = {
  paper: '#ECE5D6', ink: '#221F18',
  c1: '#4C5A68', c2: '#7A7F4E', c3: '#D2A85E', c4: '#A8432F',
  red: '#D63A2C',
};

const n = (v) => (Math.round(v * 100) / 100).toString();
const env = (k, d) => (process.env[k] !== undefined ? +process.env[k] : d);

// tunables (overridable for A/B renders)
const SPEC_SIZE = env('SPEC_SIZE', 8);
const SPEC_LS = env('SPEC_LS', 1.2);
const SPEC_Y = env('SPEC_Y', 34);
const NUM_H = env('NUM_H', 46);
const NUM_CY = env('NUM_CY', 67.5);
const ORBIT_RX = env('ORBIT_RX', 40);
const ORBIT_RY = env('ORBIT_RY', 12);
const ORBIT_ROT = env('ORBIT_ROT', -22);
const OUT = process.env.OUT || '';

// ---------- patch 120×120 ----------
const P = { cx: 60, cy: 60, disc: 57, ring: 53, ringW: 8, inner: 44.5 };
const quad = (r, from, to) => {
  // arc inside one quadrant: 0° = up, clockwise
  const pt = (d) => [P.cx + r * Math.sin((d * Math.PI) / 180), P.cy - r * Math.cos((d * Math.PI) / 180)];
  const [x0, y0] = pt(from), [x1, y1] = pt(to);
  return `M${n(x0)} ${n(y0)}A${r} ${r} 0 0 1 ${n(x1)} ${n(y1)}`;
};

// wordmark numeral: local box 32 × 44.5, stroke 9, round joins, flat ends
const WM = { bar: 23, drop: 35.5, sw: 9, box: { w: 32, h: 44.5, cx: 11.5, cy: 17.75 } };
const numeral = ({ cx, cy, height }) => {
  const k = height / WM.box.h;
  const tx = cx - WM.box.cx * k;
  const ty = cy - WM.box.cy * k;
  return `<g transform="translate(${n(tx)} ${n(ty)}) scale(${n(k)})"><path d="M0 0H${WM.bar}L${WM.bar - 14} ${WM.drop}" fill="none" stroke="${K.red}" stroke-width="${WM.sw}" stroke-linejoin="round" stroke-linecap="butt"/></g>`;
};

// planets ride the orbit ellipse: [angle in degrees along the ellipse, radius]
const PLANETS_ON = process.env.PLANETS !== '0';
const PLANETS = [[-10, 3.6], [152, 2.1], [65, 1.5]];
const orbitPt = (deg, rx, ry, rot) => {
  const a = (deg * Math.PI) / 180, r = (rot * Math.PI) / 180;
  const x0 = rx * Math.cos(a), y0 = ry * Math.sin(a);
  return [60 + x0 * Math.cos(r) - y0 * Math.sin(r), 60 + x0 * Math.sin(r) + y0 * Math.cos(r)];
};
// the ring splits at the ellipse's long axis: the far half passes BEHIND the numeral,
// the near half passes IN FRONT of it, so the 7 sits inside the ring instead of on top.
// (cubic-bezier approximation — an A-command arc on a rotated ellipse is degenerate
//  here because the chord equals the major axis, and renderers disagree on it)
const orbitPath = (t0, t1, steps) => {
  const rt = (ORBIT_ROT * Math.PI) / 180, cr = Math.cos(rt), sr = Math.sin(rt);
  const pt = (d) => {
    const a = (d * Math.PI) / 180, x = ORBIT_RX * Math.cos(a), y = ORBIT_RY * Math.sin(a);
    return [60 + x * cr - y * sr, 60 + x * sr + y * cr];
  };
  const tan = (d) => {
    const a = (d * Math.PI) / 180, x = -ORBIT_RX * Math.sin(a), y = ORBIT_RY * Math.cos(a);
    return [x * cr - y * sr, x * sr + y * cr];
  };
  let d = `M${n(pt(t0)[0])} ${n(pt(t0)[1])}`;
  const dt = (t1 - t0) / steps;
  for (let i = 0; i < steps; i++) {
    const a0 = t0 + i * dt, a1 = a0 + dt, k = ((dt * Math.PI) / 180) / 3;
    const p0 = pt(a0), p1 = pt(a1), d0 = tan(a0), d1 = tan(a1);
    d += `C${n(p0[0] + d0[0] * k)} ${n(p0[1] + d0[1] * k)} ${n(p1[0] - d1[0] * k)} ${n(p1[1] - d1[1] * k)} ${n(p1[0])} ${n(p1[1])}`;
  }
  return `<path d="${d}" fill="none" stroke="${K.ink}" stroke-width="0.9"/>`;
};
const ORBIT_FAR = orbitPath(180, 360, 4);
const ORBIT_NEAR = orbitPath(0, 180, 4);
const isFar = (t) => (((t % 360) + 360) % 360) > 180;
const planet = ([t, r]) => {
  const [x, y] = orbitPt(t, ORBIT_RX, ORBIT_RY, ORBIT_ROT);
  return `<circle cx="${n(x)}" cy="${n(y)}" r="${r}" fill="${K.ink}"/>`;
};
const farPlanets = PLANETS_ON ? PLANETS.filter((p) => isFar(p[0])).map(planet).join('\n  ') : '';
const nearPlanets = PLANETS_ON ? PLANETS.filter((p) => !isFar(p[0])).map(planet).join('\n  ') : '';

const patch = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="S.P.E.C. 7 mission patch">
  <title>S.P.E.C. 7 mission patch</title>
  <circle cx="60" cy="60" r="${P.disc}" fill="${K.paper}"/>
  <g fill="none" stroke-width="${P.ringW}">
    <path d="${quad(P.ring, 0, 90)}" stroke="${K.c1}"/>
    <path d="${quad(P.ring, 90, 180)}" stroke="${K.c2}"/>
    <path d="${quad(P.ring, 180, 270)}" stroke="${K.c3}"/>
    <path d="${quad(P.ring, 270, 360)}" stroke="${K.c4}"/>
  </g>
  <circle cx="60" cy="60" r="${P.inner}" fill="none" stroke="${K.ink}" stroke-width="1"/>
  <text x="60" y="${SPEC_Y}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${SPEC_SIZE}" font-weight="700" letter-spacing="${SPEC_LS}" fill="${K.ink}">S.P.E.C.</text>
  ${ORBIT_FAR}
  ${farPlanets}
  ${numeral({ cx: 60, cy: NUM_CY, height: NUM_H })}
  ${ORBIT_NEAR}
  ${nearPlanets}
  <circle cx="60" cy="60" r="${P.disc}" fill="none" stroke="${K.ink}" stroke-width="1.6"/>
</svg>
`;

// ---------- favicon 32×32 ----------
const F = { disc: 15, ring: 13.6, ringW: 2.8 };
const fquad = (r, from, to) => {
  const pt = (d) => [16 + r * Math.sin((d * Math.PI) / 180), 16 - r * Math.cos((d * Math.PI) / 180)];
  const [x0, y0] = pt(from), [x1, y1] = pt(to);
  return `M${n(x0)} ${n(y0)}A${r} ${r} 0 0 1 ${n(x1)} ${n(y1)}`;
};
const numeral32 = (() => {
  const k = 14.5 / WM.box.h;
  const tx = 16 - WM.box.cx * k;
  const ty = 17.4 - WM.box.cy * k;
  return `<g transform="translate(${n(tx)} ${n(ty)}) scale(${n(k)})"><path d="M0 0H${WM.bar}L${WM.bar - 14} ${WM.drop}" fill="none" stroke="${K.red}" stroke-width="${WM.sw}" stroke-linejoin="round" stroke-linecap="butt"/></g>`;
})();

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${K.paper}"/>
  <circle cx="16" cy="16" r="${F.disc}" fill="${K.paper}"/>
  <g fill="none" stroke-width="${F.ringW}">
    <path d="${fquad(F.ring, 0, 90)}" stroke="${K.c1}"/>
    <path d="${fquad(F.ring, 90, 180)}" stroke="${K.c2}"/>
    <path d="${fquad(F.ring, 180, 270)}" stroke="${K.c3}"/>
    <path d="${fquad(F.ring, 270, 360)}" stroke="${K.c4}"/>
  </g>
  ${numeral32}
  <circle cx="16" cy="16" r="${F.disc}" fill="none" stroke="${K.ink}" stroke-width="1.2"/>
</svg>
`;

const suffix = OUT ? '-' + OUT : '';
writeFileSync(here + '../spec-7-patch' + suffix + '.svg', patch);
if (!OUT) writeFileSync(here + '../spec-7-favicon.svg', favicon);
console.log('written spec-7-patch' + suffix + '.svg');
