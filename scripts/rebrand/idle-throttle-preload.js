'use strict';

/**
 * KnockDesk idle-throttle preload.
 *
 * Installed by the launch shim as the window's preload, so it runs BEFORE
 * any page script: every ambient loop the app starts (rAF, setTimeout,
 * setInterval, WAAPI) flows through the schedulers defined here, and the
 * throttle can actually reach them. A post-load injection cannot: minified
 * bundles capture timer references at module scope.
 *
 * Behaviour: after IDLE_MS with no user input and no app activity, ambient
 * schedulers are throttled to a 2 fps floor. Any input, DOM mutation,
 * media playback, network request, or WebSocket message restores full rate
 * immediately. Nothing is ever dropped, only slowed.
 *
 * Applies to every window of the app (main UI, in-app browser pages, the
 * agent office) because idle means idle for all of them. Skips devtools.
 * Escape hatch: KNOCKDESK_DISABLE_IDLE_THROTTLE=1 (checked by the shim,
 * which then does not install this preload at all).
 */

(function idleThrottlePreload() {
  try {
    if (window.__kdIdleThrottleInstalled) return;
    window.__kdIdleThrottleInstalled = true;

    var href = location.href || '';
    if (href.indexOf('devtools://') === 0) return;

    var IDLE_MS = 2 * 60 * 1000;
    var FLOOR_MS = 500;               // 2 fps floor while paused
    var doc = document;
    var html = doc.documentElement;
    var paused = false;
    var lastActivity = Date.now();

    var nativeRaf = window.requestAnimationFrame.bind(window);
    var nativeSetTimeout = window.setTimeout.bind(window);
    var nativeSetInterval = window.setInterval.bind(window);
    var nativeClearTimeout = window.clearTimeout.bind(window);
    var nativeClearInterval = window.clearInterval.bind(window);
    var nativeAnimate = window.Element && window.Element.prototype.animate;

    // ---- state -------------------------------------------------------------
    function markActive(src) {
      if (window.__kdDbg) {
        var k = src || 'unknown';
        window.__kdDbg[k] = (window.__kdDbg[k] || 0) + 1;
      }
      lastActivity = Date.now();
      if (paused) resume();
    }

    var rafPending = {};
    var rafSeq = 1;
    var rafTimer = null;
    var timerPending = {};   // id -> {fn, args} for throttled timers
    var timerSeq = 1;
    var timerFlush = null;

    function rafFlush() {
      rafTimer = null;
      var due = rafPending; rafPending = {}; rafSeq = 1;
      for (var id in due) { try { due[id](performance.now()); } catch (e) {} }
      rafSchedule();
    }
    function rafSchedule() {
      if (rafTimer || !paused) return;
      rafTimer = nativeSetTimeout(rafFlush, FLOOR_MS);
    }

    function timerFlushNow() {
      timerFlush = null;
      var due = timerPending; timerPending = {}; timerSeq = 1;
      for (var tid in due) {
        var item = due[tid];
        try { item.fn.apply(null, item.args); } catch (e) {}
      }
      timerSchedule();
    }
    function timerSchedule() {
      if (timerFlush || !paused) return;
      timerFlush = nativeSetTimeout(timerFlushNow, FLOOR_MS);
    }

    function pause() {
      if (paused) return;
      paused = true;
      if (typeof console !== 'undefined') console.log('[KnockDesk] idle: paused ambient schedulers');
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
      rafSchedule();
      timerSchedule();
    }

    function resume() {
      if (!paused) return;
      paused = false;
      if (typeof console !== 'undefined') console.log('[KnockDesk] idle: resumed on activity');
      html.classList.remove('kd-idle-ambient');
      var st = doc.getElementById('kd-idle-ambient-style');
      if (st && st.parentNode) st.parentNode.removeChild(st);
      if (rafTimer) { nativeClearTimeout(rafTimer); rafTimer = null; }
      if (timerFlush) { nativeClearTimeout(timerFlush); timerFlush = null; }
      rafPending = {}; rafSeq = 1;
      timerPending = {}; timerSeq = 1;
    }

    // ---- scheduler patches (installed before page scripts) ----------------
    window.requestAnimationFrame = function patchedRaf(cb) {
      if (typeof cb !== 'function') return 0;
      if (window.__kdDbg) window.__kdDbg.raf = (window.__kdDbg.raf || 0) + 1;
      if (!paused) return nativeRaf(cb);
      var id = rafSeq++;
      rafPending[id] = cb;
      rafSchedule();
      return id;
    };

    function patchTimer(kind) {
      var native = kind === 'timeout' ? nativeSetTimeout : nativeSetInterval;
      return function patchedTimer(fn) {
        if (typeof fn !== 'function') return native.apply(null, arguments);
        var args = Array.prototype.slice.call(arguments, 2);
        if (!paused) return native(fn, arguments[1]);
        // while paused: run once after the floor interval, then reschedule
        // itself through the same patched path (self-perpetuating loops keep
        // their cadence but at the floor rate)
        var id = timerSeq++;
        var wrapper = function wrapper() {
          if (!paused) { native(fn, arguments[1]); return; }
          timerPending[id] = { fn: wrapper, args: [] };
          try { fn.apply(null, args); } catch (e) {}
          timerSchedule();
        };
        timerPending[id] = { fn: wrapper, args: [] };
        timerSchedule();
        return id;
      };
    }
    window.setTimeout = patchTimer('timeout');
    window.setInterval = patchTimer('interval');

    if (nativeAnimate) {
      window.Element.prototype.animate = function patchedAnimate(keyframes, options) {
        var anim = nativeAnimate.apply(this, arguments);
        try {
          if (paused && anim && typeof anim.pause === 'function') anim.pause();
        } catch (e) {}
        return anim;
      };
    }

    // WebSocket messages are app activity (streaming sessions)
    var NativeWS = window.WebSocket;
    if (typeof NativeWS === 'function') {
      var PatchedWS = function (url, protocols) {
        var ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
        var origOn = ws.addEventListener ? ws.addEventListener.bind(ws) : null;
        if (origOn) {
          ws.addEventListener('message', function onWsMessage() { markActive('ws'); });
        }
        return ws;
      };
      PatchedWS.prototype = NativeWS.prototype;
      window.WebSocket = PatchedWS;
    }

    // ---- activity signals ----------------------------------------------------
    ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'input', 'click'].forEach(function (ev) {
      window.addEventListener(ev, function onInput() { markActive('input:' + ev); }, { passive: true, capture: true });
    });

    var IDLE_STYLE_ID = 'kd-idle-ambient-style';
    function isSelfMutation(m) {
      try {
        if (m.type === 'attributes') {
          return m.target === html || (m.target && m.target.id === IDLE_STYLE_ID);
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

    nativeSetInterval(function pollMedia() {
      try {
        var els = doc.querySelectorAll('audio, video');
        for (var i = 0; i < els.length; i++) {
          if (!els[i].paused && !els[i].ended) { markActive('media'); return; }
        }
      } catch (e) {}
    }, 1500);

    // network activity
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
    nativeSetInterval(function pollNet() {
      var hit = window.__kdNetHit;
      if (hit && Date.now() - hit < 4000) { window.__kdNetHit = 0; markActive('network'); }
    }, 2000);

    // idle checker + debug reporter
    nativeSetInterval(function checkIdle() {
      if (Date.now() - lastActivity >= IDLE_MS) pause();
    }, 15000);

    if (process.env && process.env.KNOCKDESK_DEBUG_IDLE === '1') window.__kdDbg = {};
    nativeSetInterval(function dbgReport() {
      if (!window.__kdDbg) return;
      var parts = [];
      for (var k in window.__kdDbg) parts.push(k + '=' + window.__kdDbg[k]);
      var anims = -1, running = -1;
      try {
        var list = doc.getAnimations ? doc.getAnimations() : [];
        anims = list.length;
        running = list.filter(function (a) { return a.playState === 'running'; }).length;
      } catch (e) {}
      console.log('[KnockDesk] idle signals: ' + (parts.join(' ') || 'none')
        + ' | stale=' + (Date.now() - lastActivity) + 'ms paused=' + paused
        + ' anims=' + anims + ' running=' + running);
      window.__kdDbg = {};
    }, 15000);

    console.log('[KnockDesk] idle throttle armed (preload, 2 min idle -> 2 fps floor)');
  } catch (err) {
    try { console.warn('[KnockDesk] idle throttle preload skipped:', (err && err.message) || err); } catch (e) {}
  }
})();
