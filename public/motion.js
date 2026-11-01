// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 LucasHe1015
/* ==========================================================================
   S.P.E.C. 7 // MOTION HELPER
   Small, dependency-free animation helper shared by app.js.
   Loaded BEFORE app.js. Pure additive: never changes business state, never
   throws on missing nodes, and degrades to instant switching when the user
   asks for reduced motion.
   ========================================================================== */

(() => {
  'use strict';

  if (window.SPECMotion) return;

  const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

  const DUR = { fast: 120, base: 220, slow: 300 };

  const ENTER = {
    fade: 'm-enter-fade',
    rise: 'm-enter-rise',
    drop: 'm-enter-drop',
    pop: 'm-enter-pop',
    right: 'm-enter-right',
    left: 'm-enter-left',
    flip: 'm-enter-flip',
    chip: 'm-enter-chip',
  };

  const LEAVE = {
    fade: 'm-leave-fade',
    rise: 'm-leave-rise',
    drop: 'm-leave-drop',
    pop: 'm-leave-pop',
    right: 'm-leave-right',
    left: 'm-leave-left',
  };

  const ALL_ANIM_CLASSES = [
    'm-enter', 'm-leave',
    'm-enter-fast', 'm-enter-slow',
    ...Object.values(ENTER), ...Object.values(LEAVE),
  ];

  const versions = new WeakMap();   // el -> token, cancels stale callbacks
  const pressTimes = new WeakMap(); // el -> last press timestamp
  const foldTimers = new WeakMap(); // el -> timeout id

  function reduced() {
    return reduceMQ.matches;
  }

  function dur(name) {
    return DUR[name] != null ? DUR[name] : DUR.base;
  }

  function bump(tokenHost) {
    const next = (versions.get(tokenHost) || 0) + 1;
    versions.set(tokenHost, next);
    return next;
  }

  function isCurrent(tokenHost, token) {
    return versions.get(tokenHost) === token;
  }

  function clearAnimClasses(node) {
    if (!node || !node.classList) return;
    node.classList.remove(...ALL_ANIM_CLASSES);
  }

  /* Run `done` when the element's own animation finishes, with a safety net
     for interrupted or never-started animations. */
  function afterAnimation(node, fallbackMs, done) {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      node.removeEventListener('animationend', onEnd);
      node.removeEventListener('animationcancel', onEnd);
      clearTimeout(timer);
      done();
    };
    const onEnd = (event) => {
      if (event.target === node) finish();
    };
    node.addEventListener('animationend', onEnd);
    node.addEventListener('animationcancel', onEnd);
    const timer = setTimeout(finish, Math.max(60, fallbackMs) + 140);
    return finish;
  }

  /* ----------------------------------------------------------------------- */
  /* play / show / hide                                                      */
  /* ----------------------------------------------------------------------- */

  function play(node, anim = 'fade', opts = {}) {
    if (!node) return;
    if (reduced()) return;
    bump(node);
    clearAnimClasses(node);
    void node.offsetWidth;
    const enterClass = ENTER[anim] || ENTER.fade;
    node.classList.add('m-enter', enterClass);
    if (opts.fast) node.classList.add('m-enter-fast');
    if (opts.slow) node.classList.add('m-enter-slow');
    const duration = opts.duration != null ? opts.duration : dur(opts.fast ? 'fast' : opts.slow ? 'slow' : 'base');
    afterAnimation(node, duration, () => {
      clearAnimClasses(node);
    });
  }

  function show(node, opts = {}) {
    if (!node) return node;
    bump(node);
    clearAnimClasses(node);
    node.hidden = false;
    if (!reduced()) play(node, opts.enter || 'fade', opts);
    return node;
  }

  function hide(node, opts = {}) {
    return new Promise((resolve) => {
      if (!node) { resolve(); return; }
      const token = bump(node);
      clearAnimClasses(node);
      if (node.hidden || reduced()) {
        node.hidden = true;
        resolve();
        return;
      }
      const leaveClass = LEAVE[opts.leave] || LEAVE.fade;
      node.classList.add('m-leave', leaveClass);
      afterAnimation(node, dur('fast'), () => {
        if (!isCurrent(node, token)) { resolve(); return; }
        clearAnimClasses(node);
        node.hidden = true;
        resolve();
      });
    });
  }

  function toggle(node, open, opts = {}) {
    if (open) return show(node, opts);
    return hide(node, opts);
  }

  /* ----------------------------------------------------------------------- */
  /* fold: mechanical drawer for the collapsible strips                      */
  /* ----------------------------------------------------------------------- */

  /* `mode: 'pop'` (default) suits the absolutely-positioned flyouts used by
     the composer / source header: it never measures content, so asynchronously
     loaded lists cannot make the drawer jump. `mode: 'drawer'` animates a real
     height change and is meant for in-flow containers only. */
  function fold(body, open, opts = {}) {
    if (!body) return;
    const token = bump(body);
    clearTimeout(foldTimers.get(body));
    const duration = opts.duration != null ? opts.duration : 200;
    const drawer = opts.mode === 'drawer';

    if (reduced()) {
      body.classList.remove('m-fold-host');
      body.style.height = '';
      body.hidden = !open;
      return;
    }

    if (!drawer) {
      /* flyout pop: opacity + small slide, transform-origin comes from CSS */
      if (open) {
        body.hidden = false;
        const animation = body.animate(
          [
            { opacity: 0, transform: 'translateY(6px) scale(0.985)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
        );
        const finish = () => {
          if (!isCurrent(body, token)) return;
          body.style.opacity = '';
          body.style.transform = '';
        };
        animation.onfinish = finish;
        animation.oncancel = finish;
        foldTimers.set(body, setTimeout(finish, duration + 160));
        return;
      }
      if (body.hidden) return;
      const animation = body.animate(
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'translateY(6px) scale(0.985)' },
        ],
        { duration: Math.round(duration * 0.7), easing: 'cubic-bezier(0.4, 0, 1, 1)' },
      );
      const finish = () => {
        if (!isCurrent(body, token)) return;
        body.style.opacity = '';
        body.style.transform = '';
        body.hidden = true;
      };
      animation.onfinish = finish;
      animation.oncancel = finish;
      foldTimers.set(body, setTimeout(finish, Math.round(duration * 0.7) + 160));
      return;
    }

    if (open) {
      body.hidden = false;
      body.classList.add('m-fold-host');
      body.style.height = 'auto';
      const target = Math.ceil(body.getBoundingClientRect().height) || body.scrollHeight;
      body.style.height = '0px';
      const animation = body.animate(
        [
          { height: '0px', opacity: 0, transform: 'translateY(-4px)' },
          { height: `${target}px`, opacity: 1, transform: 'none' },
        ],
        { duration, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      );
      const finish = () => {
        if (!isCurrent(body, token)) return;
        body.classList.remove('m-fold-host');
        body.style.height = '';
      };
      animation.onfinish = finish;
      animation.oncancel = finish;
      foldTimers.set(body, setTimeout(finish, duration + 160));
      return;
    }

    if (body.hidden) {
      body.classList.remove('m-fold-host');
      body.style.height = '';
      return;
    }

    body.classList.add('m-fold-host');
    body.style.height = 'auto';
    const start = Math.ceil(body.getBoundingClientRect().height);
    const animation = body.animate(
      [
        { height: `${start}px`, opacity: 1, transform: 'none' },
        { height: '0px', opacity: 0, transform: 'translateY(-4px)' },
      ],
      { duration: Math.round(duration * 0.82), easing: 'cubic-bezier(0.4, 0, 1, 1)' },
    );
    const finish = () => {
      if (!isCurrent(body, token)) return;
      body.classList.remove('m-fold-host');
      body.style.height = '';
      body.hidden = true;
    };
    animation.onfinish = finish;
    animation.oncancel = finish;
    foldTimers.set(body, setTimeout(finish, Math.round(duration * 0.82) + 160));
  }

  /* ----------------------------------------------------------------------- */
  /* stagger: give children a cascading entrance                             */
  /* ----------------------------------------------------------------------- */

  function stagger(container, opts = {}) {
    if (!container) return;
    const step = opts.step != null ? opts.step : 26;
    const max = opts.max != null ? opts.max : 14;
    const children = Array.from(container.children || []);
    children.forEach((child, index) => {
      if (child.style && child.style.setProperty) {
        child.style.setProperty('--m-i', String(Math.min(index, max)));
      }
    });
    if (opts.play === false || reduced()) {
      container.classList.remove('m-stagger');
      return;
    }
    container.classList.remove('m-stagger');
    void container.offsetWidth;
    container.classList.add('m-stagger');
    const total = Math.min(children.length, max + 1) * step + dur('base') + 120;
    setTimeout(() => container.classList.remove('m-stagger'), total);
  }

  /* ----------------------------------------------------------------------- */
  /* micro feedback                                                          */
  /* ----------------------------------------------------------------------- */

  function flip(node) {
    if (!node) return;
    if (reduced()) return;
    bump(node);
    clearAnimClasses(node);
    void node.offsetWidth;
    node.classList.add('m-enter', ENTER.flip, 'm-enter-fast');
    afterAnimation(node, dur('fast'), () => clearAnimClasses(node));
  }

  function press(node) {
    if (!node || reduced() || typeof node.animate !== 'function') return;
    const now = performance.now();
    const last = pressTimes.get(node) || 0;
    if (now - last < 120) return;
    pressTimes.set(node, now);
    try {
      node.animate(
        [
          { transform: 'translateY(0) scale(1)' },
          { transform: 'translateY(2px) scale(0.986)' },
          { transform: 'translateY(0) scale(1)' },
        ],
        { duration: 190, easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)' },
      );
    } catch { /* older engines — non critical */ }
  }

  function sweep(node) {
    if (!node || reduced() || !node.classList) return;
    const bar = document.createElement('span');
    bar.className = 'm-sweep-bar';
    node.classList.add('m-sweep-host');
    node.appendChild(bar);
    const cleanup = () => {
      bar.remove();
      node.classList.remove('m-sweep-host');
    };
    afterAnimation(bar, dur('slow'), cleanup);
    setTimeout(cleanup, dur('slow') + 260);
  }

  function shake(node) {
    if (!node || reduced()) return;
    bump(node);
    clearAnimClasses(node);
    void node.offsetWidth;
    node.classList.add('m-enter');
    node.style.animationName = 'mShakeX';
    node.style.animationDuration = '320ms';
    afterAnimation(node, 320, () => {
      node.style.animationName = '';
      node.style.animationDuration = '';
      clearAnimClasses(node);
    });
  }

  window.SPECMotion = {
    get reduced() { return reduced(); },
    dur,
    play,
    show,
    hide,
    toggle,
    fold,
    stagger,
    flip,
    press,
    sweep,
    shake,
  };
})();
