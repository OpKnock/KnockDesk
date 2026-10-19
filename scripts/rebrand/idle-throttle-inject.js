'use strict';

/**
 * KnockDesk idle throttle (injected by the launch shim into app windows).
 *
 * The shipped UI keeps an ambient layer alive: infinite CSS animations (orb
 * breathe/pulse/spin, voice-HUD beams, recording ripples) plus a WebGL
 * particle globe driven by requestAnimationFrame. Measured on the release
 * build, that layer holds the GPU process at ~150% of a core and one
 * renderer at ~55% of a core for as long as the window is visible and
 * idle, which is what users experience as "the app hangs when left alone"
 * and what certification flags as excessive idle CPU.
 *
 * Policy (restores instantly, never looks broken):
 *   - After IDLE_MS (2 min) with no user input AND no app-originated
 *     activity, the ambient layer is paused: CSS animations stop and the
 *     rAF scheduler is throttled to 2 fps.
 *   - Any of these counts as activity and immediately restores full rate:
 *     pointer/key/wheel/scroll/touch input, DOM mutation (streaming
 *     replies, HUD meter updates), a playing media element, or a
 *     network request (fetch/XHR/sendBeacon).
 *   - While a voice or AI session is streaming, its DOM mutations keep
 *     the window at full rate on their own.
 *
 * Self-guarding: only applies to the app's own file:// windows (never to
 * in-app browser pages, the admin window, or devtools). Escape hatch:
 *   KNOCKDESK_DISABLE_IDLE_THROTTLE=1
 */

(function injectIdleThrottle() {
  try {
    var IDLE_MS = 2 * 60 * 1000;
    var KEY = '__kdIdleThrottleInstalled';
    if (window[KEY]) return;
    window[KEY] = true;

    // Only the app's own UI. The main window is served by the bundled
    // loopback static server (http://127.0.0.1:<ui-port>/index.html); the
    // dist build also runs from an unpacked asar path. In-app browser
    // pages, AgentTown, and the bridge/CDP ports are left untouched.
    var href = location.href || '';
    var hostOk = /^https?:\/\/(127\.0\.0\.1|localhost):\d+\//.test(href);
    var portOk = hostOk && /:(45678|45679|45680)\//.test(href);
    var isAppUi = portOk
      || (location.protocol === 'file:'
          && (href.indexOf('app.asar') !== -1
              || href.indexOf('app.asar.unpacked') !== -1
              || /[\\/]dist[\\/]index\.html/.test(href)));
    if (!isAppUi) return;
    if (typeof URL === 'function' && URL.searchParams && URL.searchParams.get('kdidle') === 'verbose') {
      window.__kdDbg = {};
      console.log('[KnockDesk] idle signals debug enabled');
    }

    var doc = document;
    var html = doc.documentElement;
    var paused = false;
    var idleTimer = null;
    var lastActivity = Date.now();

    // ---- rAF throttle (the page resolves rAF at call time, so this patch
    //      takes over the ambient loop within one frame) -------------------
    var nativeRaf = window.requestAnimationFrame.bind(window);

    var pending = {};        // id -> callback, while paused
    var pendingSeq = 1;
    var flushTimer = null;

    function flush() {
      flushTimer = null;
      var due = pending;
      pending = {};
      pendingSeq = 1;
      for (var id in due) {
        try { due[id](performance.now()); } catch (e) {}
      }
      scheduleFlush();
    }

    function scheduleFlush() {
      if (flushTimer || !paused) return;
      flushTimer = setTimeout(flush, 500); // 2 fps floor
    }

    function markActive(src) {
      if (window.__kdDbg) {
        window.__kdDbg[src || 'unknown'] = (window.__kdDbg[src || 'unknown'] || 0) + 1;
      }
      lastActivity = Date.now();
      if (paused) resume();
    }
    var dbgTimer = setInterval(function () {
      if (!window.__kdDbg) return;
      var parts = [];
      for (var k in window.__kdDbg) parts.push(k + '=' + window.__kdDbg[k]);
      var anims = -1, running = -1;
      try {
        var list = document.getAnimations ? document.getAnimations() : [];
        anims = list.length;
        running = list.filter(function (a) { return a.playState === 'running'; }).length;
      } catch (e) {}
      var gl = 0;
      try { gl = document.querySelectorAll('canvas').length; } catch (e) {}
      console.log('[KnockDesk] idle signals: ' + (parts.join(' ') || 'none') + ' | stale=' + (Date.now() - lastActivity) + 'ms paused=' + paused + ' anims=' + anims + ' running=' + running + ' canvases=' + gl);
      window.__kdDbg = {};
    }, 15000);

    // NOTE: the ambient loop itself must NOT count as activity, or the
    // throttle could never engage. Only real user/app signals call
    // markActive().
    window.requestAnimationFrame = function patchedRaf(cb) {
      if (typeof cb !== 'function') return 0;
      if (window.__kdDbg) { window.__kdDbg.raf = (window.__kdDbg.raf || 0) + 1; }
      if (!paused) return nativeRaf(cb);
      var id = pendingSeq++;
      pending[id] = cb;
      scheduleFlush();
      return id;
    };

    function pause() {
      if (paused) return;
      paused = true;
      if (typeof console !== 'undefined') console.log('[KnockDesk] idle: paused ambient layer');
      html.classList.add('kd-idle-ambient');
      if (!doc.getElementById('kd-idle-ambient-style')) {
        var st = doc.createElement('style');
        st.id = 'kd-idle-ambient-style';
        st.textContent =
          'html.kd-idle-ambient *, html.kd-idle-ambient *::before, html.kd-idle-ambient *::after {' +
          '  animation-play-state: paused !important;' +
          '}';
        (doc.head || doc.documentElement).appendChild(st);
      }
    }

    function resume() {
      if (!paused) return;
      paused = false;
      if (typeof console !== 'undefined') console.log('[KnockDesk] idle: resumed on activity');
      html.classList.remove('kd-idle-ambient');
      var st = doc.getElementById('kd-idle-ambient-style');
      if (st && st.parentNode) st.parentNode.removeChild(st);
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      pending = {};
      pendingSeq = 1;
    }

    function armTimer() {
      if (idleTimer) clearInterval(idleTimer);
      // Check frequently, so the pause lands within 15s of the idle mark
      // instead of drifting to the next 2-minute boundary.
      idleTimer = setInterval(function () {
        if (Date.now() - lastActivity >= IDLE_MS) pause();
      }, 15000);
    }

    // ---- activity signals --------------------------------------------------
    // user input
    ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'input', 'click'].forEach(function (ev) {
      window.addEventListener(ev, function onInput() { markActive('input:' + ev); }, { passive: true, capture: true });
    });

    // app-originated activity: streaming replies, HUD meters, transcript rows
    var IDLE_STYLE_ID = 'kd-idle-ambient-style';
    function isSelfMutation(m) {
      try {
        if (m.type === 'attributes') {
          if (m.target === html) return true;
          if (m.target && m.target.id === IDLE_STYLE_ID) return true;
          return false;
        }
        var lists = [m.addedNodes, m.removedNodes];
        for (var li = 0; li < 2; li++) {
          var l = lists[li];
          for (var i = 0; i < l.length; i++) {
            var n = l[i];
            if (n && (n.id === IDLE_STYLE_ID || (n.classList && n.classList.contains('kd-idle-ambient')))) return true;
          }
        }
      } catch (e) {}
      return false;
    }
    try {
      new MutationObserver(function onMutation(muts) {
        var adds = 0, attrs = 0, text = 0;
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (isSelfMutation(m)) continue;
          if (m.type === 'childList') adds += m.addedNodes.length;
          else if (m.type === 'attributes') attrs++;
          else text++;
        }
        if (adds || text || attrs) markActive('mutation(a=' + adds + ',t=' + text + ',x=' + attrs + ')');
      }).observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (e) {}

    // media activity (TTS playback, SFX) and network activity
    setInterval(function () {
      try {
        var els = doc.querySelectorAll('audio, video');
        for (var i = 0; i < els.length; i++) {
          if (!els[i].paused && !els[i].ended) { markActive('media'); return; }
        }
      } catch (e) {}
    }, 1500);

    ['fetch', 'XMLHttpRequest', 'sendBeacon'].forEach(function (name) {
      var orig = window[name];
      if (typeof orig !== 'function') return;
      if (name === 'XMLHttpRequest') {
        var origOpen = orig.prototype.open;
        orig.prototype.open = function () { window.__kdNetHit = Date.now(); return origOpen.apply(this, arguments); };
      } else {
        window[name] = function () { window.__kdNetHit = Date.now(); return orig.apply(this, arguments); };
      }
    });
    setInterval(function () {
      var hit = window.__kdNetHit;
      if (hit && Date.now() - hit < 4000) { window.__kdNetHit = 0; markActive('network'); }
    }, 2000);

    armTimer();
    if (typeof console !== 'undefined') {
      var frameInfo = 'top=' + (window.top === window) + ' frames=' + (window.frames ? window.frames.length : 0)
        + ' iframes=' + document.querySelectorAll('iframe').length
        + ' href=' + location.href;
      console.log('[KnockDesk] idle throttle armed (2 min idle, 2 fps floor) | ' + frameInfo);
    }
  } catch (err) {
    try { console.warn('[KnockDesk] idle throttle skipped:', (err && err.message) || err); } catch (e) {}
  }
})();
