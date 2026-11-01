// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LucasHe1015
/* ==========================================================================
   S.P.E.C. 7 // THEME SWITCH
   Light <-> dark console, persisted in localStorage and animated as a
   mechanical circular wipe from the switch itself (View Transitions API,
   with an instant fallback for reduced motion or older engines).
   Loaded after motion.js, before app.js.
   ========================================================================== */

(() => {
  'use strict';

  const ROOT = document.documentElement;
  const KEY = 'spec7:theme';
  const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  const FLIP_MS = 560;

  let busy = false;

  const current = () => (ROOT.dataset.theme === 'dark' ? 'dark' : 'light');

  const buttons = () => Array.from(document.querySelectorAll('[data-theme-toggle]'));

  function sync() {
    const dark = current() === 'dark';
    buttons().forEach((btn) => {
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      btn.setAttribute('aria-label', dark ? '切换到浅色模式 LIGHT' : '切换到深色模式 DARK');
      btn.setAttribute('title', dark ? '浅色模式 LIGHT MODE · 点击切换深色' : '深色模式 DARK MODE · 点击切换浅色');
    });
  }

  function commit(next) {
    ROOT.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch { /* private mode / disabled storage — theme still applies */ }
    sync();
  }

  function kick(btn) {
    if (!btn || reduceMQ.matches) return;
    btn.classList.remove('is-flipping');
    void btn.offsetWidth;
    btn.classList.add('is-flipping');
    setTimeout(() => btn.classList.remove('is-flipping'), FLIP_MS + 120);
  }

  function toggle(btn) {
    if (busy) return;
    const next = current() === 'dark' ? 'light' : 'dark';

    if (!document.startViewTransition || reduceMQ.matches) {
      commit(next);
      kick(btn);
      return;
    }

    const rect = btn ? btn.getBoundingClientRect() : null;
    const x = rect ? Math.round(rect.left + rect.width / 2) : Math.round(window.innerWidth - 48);
    const y = rect ? Math.round(rect.top + rect.height / 2) : 32;
    const radius = Math.ceil(Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    ));

    busy = true;
    kick(btn);

    /* Suppress the per-element colour transitions while the wipe runs: the
       circular reveal is the transition. Without this every button and border
       cross-fades behind the moving clip edge and the new snapshot is captured
       mid-fade. */
    ROOT.classList.add('is-theme-switching');

    const transition = document.startViewTransition(() => commit(next));
    const release = () => {
      busy = false;
      ROOT.classList.remove('is-theme-switching');
    };
    transition.ready.then(() => {
      ROOT.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${radius}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: 520,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      );
    }).catch(release);
    transition.finished.then(release).catch(release);
    /* safety net: never leave the switch locked if the transition is dropped */
    setTimeout(release, 1200);
  }

  function bind() {
    sync();
    buttons().forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        toggle(btn);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }

  window.SPECTheme = {
    get current() { return current(); },
    toggle,
    set(next) { commit(next === 'dark' ? 'dark' : 'light'); sync(); },
    sync,
  };
})();
