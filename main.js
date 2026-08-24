/* ==========================================================================
   Beyond the Horizon Conf — scroll-driven scrub
   --------------------------------------------------------------------------
   The video is never played. A sticky stage sits inside a tall "track"; how
   far the track has moved through the viewport is the only clock the page has.
   That single progress value drives video.currentTime, the text beats, the
   letterbox and the rail, so nothing can drift out of sync with anything else.

   Scroll position is sampled, but never applied raw: it feeds a target that an
   rAF loop chases with a frame-rate-independent lerp. Seeking straight from a
   scroll event is what makes these pages stutter — the decoder gets a new,
   slightly different timestamp on every wheel tick and never finishes one seek
   before the next arrives.
   ========================================================================== */

const html     = document.documentElement;
const video    = document.getElementById('video');
const track    = document.getElementById('track');
const stage    = document.getElementById('stage');
const hint     = document.getElementById('hint');
const rail      = document.getElementById('rail');
const railFill  = document.getElementById('railFill');
const topbar    = document.querySelector('.topbar');
const scrimTop  = document.getElementById('scrimTop');
const scrimLeft = document.getElementById('scrimLeft');

const beats = Array.from(document.querySelectorAll('.beat'));
const ticks = Array.from(document.querySelectorAll('.rail__ticks i'));

/* Tuning ------------------------------------------------------------------ */

const LERP          = 0.14;   // catch-up per 16.7ms frame; lower = heavier glide
const SETTLE        = 0.0002; // progress delta below which we snap and idle
const FALLBACK_FPS  = 24;     // only used until metadata gives us the real thing
const READY_TIMEOUT = 12000;  // ms to get a usable video before giving up

/* State ------------------------------------------------------------------- */

let mode         = 'boot';
let trackTop     = 0;
let scrollSpan   = 1;         // scrollable distance across the track
let duration     = 0;
let frameDur     = 1 / FALLBACK_FPS;
let target       = 0;         // progress the scroll position asks for, 0..1
let eased        = 0;         // progress we are actually rendering
let primed       = false;     // has eased been seeded from the initial scroll
let lastSeek     = -1;
let rafId        = 0;
let running      = false;

const windows = beats.map((el) => {
  const w = (el.dataset.window || '0,0,1,1').split(',').map((n) => parseFloat(n.trim()));
  return w.length === 4 && w.every(Number.isFinite) ? w : [0, 0, 1, 1];
});

/* Math -------------------------------------------------------------------- */

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

/**
 * Four-point envelope: fade in across [a,b], hold across [b,c], fade out
 * across [c,d]. Collapsing a==b (or c==d) means "already up" / "never leaves",
 * which is how the hero starts visible and the last beat holds to the end.
 */
function envelope(p, [a, b, c, d]) {
  if (p < a || p > d) return 0;
  const rise = b > a ? smoothstep((p - a) / (b - a)) : 1;
  const fall = d > c ? smoothstep((d - p) / (d - c)) : 1;
  return Math.min(rise, fall);
}

/* Layout ------------------------------------------------------------------ */

function measure() {
  const rect = track.getBoundingClientRect();
  trackTop = rect.top + window.scrollY;
  // stage.offsetHeight rather than innerHeight: the sticky element is sized in
  // svh, which is not innerHeight while a mobile URL bar is expanded.
  scrollSpan = Math.max(1, rect.height - stage.offsetHeight);
}

function readTarget() {
  return clamp((window.scrollY - trackTop) / scrollSpan, 0, 1);
}

/* Render ------------------------------------------------------------------ */

// Cache of the last value written to each element, so a frame where nothing
// moved does not touch the DOM at all.
const written = new WeakMap();

function setVar(el, name, value) {
  const q = Math.round(value * 1000) / 1000;
  const key = name + ':' + q;
  if (written.get(el) === key) return;
  written.set(el, key);
  el.style.setProperty(name, String(q));
}

function setOpacity(el, value) {
  const q = Math.round(value * 1000) / 1000;
  if (written.get(el) === q) return;
  written.set(el, q);
  el.style.opacity = String(q);
}

function paint(p) {
  let heroE = 0;
  let sideE = 0;

  for (let i = 0; i < beats.length; i++) {
    const e = envelope(p, windows[i]);
    setVar(beats[i], '--e', e);
    if (i === 0) heroE = e; else sideE = Math.max(sideE, e);
    const tick = ticks[i];
    if (tick) tick.classList.toggle('is-on', e > 0.05);
  }

  // Each scrim tracks only the beats it exists to support.
  setOpacity(scrimTop, heroE);
  setOpacity(scrimLeft, sideE);

  // Letterbox creeps in over the first fifth, then holds.
  setVar(stage, '--bar', smoothstep(p / 0.2));

  // The hint belongs to the very first moment of the sequence only.
  setVar(hint, '--e', 1 - smoothstep(p / 0.03));

  railFill.style.height = (p * 100).toFixed(2) + '%';
  rail.classList.toggle('is-visible', p > 0.04 && p < 0.99);
  topbar.classList.toggle('is-visible', p > 0.06);
}

function seek(p) {
  if (!duration) return;
  // Never ask for the very last instant; some decoders resolve that to a
  // blank frame or refuse to fire seeked.
  const t = clamp(p * duration, 0, duration - frameDur * 0.5);
  // Sub-half-frame moves are invisible but still cost a decode.
  if (Math.abs(t - lastSeek) < frameDur * 0.5) return;
  lastSeek = t;
  video.currentTime = t;
}

/* Loop -------------------------------------------------------------------- */

let lastTime = 0;

function tick(now) {
  rafId = requestAnimationFrame(tick);

  const dt = lastTime ? Math.min(now - lastTime, 100) : 16.7;
  lastTime = now;

  target = readTarget();

  if (!primed) {
    // Reloading mid-page must not animate a 5-second flight from frame zero.
    eased = target;
    primed = true;
  } else {
    // Frame-rate independent lerp: the same glide on 60Hz and 144Hz.
    const k = 1 - Math.pow(1 - LERP, dt / 16.667);
    eased += (target - eased) * k;
    if (Math.abs(target - eased) < SETTLE) eased = target;
  }

  paint(eased);
  seek(eased);
}

function start() {
  if (running) return;
  running = true;
  lastTime = 0;
  rafId = requestAnimationFrame(tick);
}

function stop() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
}

/* Video readiness --------------------------------------------------------- */

/**
 * iOS will not decode a frame for a video that has never been allowed to play,
 * so a muted inline play/pause is the price of admission for scrubbing there.
 * It is allowed without a gesture in current Safari; if a browser still
 * refuses, we retry once on the first real interaction.
 */
function primeDecoder() {
  const attempt = video.play();
  if (!attempt || typeof attempt.catch !== 'function') return;
  attempt.then(() => video.pause()).catch(() => {
    const retry = () => {
      video.play().then(() => video.pause()).catch(() => {});
      window.removeEventListener('pointerdown', retry);
      window.removeEventListener('touchstart', retry);
    };
    window.addEventListener('pointerdown', retry, { once: true, passive: true });
    window.addEventListener('touchstart', retry, { once: true, passive: true });
  });
}

/* Modes ------------------------------------------------------------------- */

function goStatic(reason) {
  if (mode === 'static') return;
  mode = 'static';
  stop();
  html.dataset.mode = 'static';

  // Stop paying for a video we are not going to use.
  video.removeAttribute('src');
  video.load();

  revealOnEnter([...beats.filter((b) => !b.classList.contains('beat--hero')),
                 ...document.querySelectorAll('.reveal')]);

  if (reason) console.info('[horizon] static mode:', reason);
}

function goScrub() {
  if (mode === 'scrub') return;
  mode = 'scrub';
  html.dataset.mode = 'scrub';

  measure();
  revealOnEnter(document.querySelectorAll('.reveal'));

  // Only burn frames while the runway is actually on screen.
  new IntersectionObserver(
    ([entry]) => (entry.isIntersecting ? start() : stop()),
    { rootMargin: '10% 0px' }
  ).observe(track);

  start();
}

function revealOnEnter(nodes) {
  const list = Array.from(nodes);
  if (!list.length) return;
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -12%' });
  list.forEach((n) => io.observe(n));
}

/* Boot -------------------------------------------------------------------- */

function boot() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const conn = navigator.connection || {};
  const starved = conn.saveData === true || /^(slow-2g|2g)$/.test(conn.effectiveType || '');

  if (reduceMotion.matches) return goStatic('prefers-reduced-motion');
  if (starved) return goStatic('save-data or 2g');

  // A preference flipped mid-session should be honoured immediately.
  const onPrefChange = (e) => { if (e.matches) goStatic('prefers-reduced-motion'); };
  if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onPrefChange);
  else reduceMotion.addListener(onPrefChange);

  video.addEventListener('error', () => goStatic('video failed to load'), { once: true });

  video.addEventListener('loadedmetadata', () => {
    duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return goStatic('no usable duration');
    // 24fps source; without a frames API this is the honest estimate to use for
    // the "is this seek worth a decode" threshold.
    frameDur = 1 / FALLBACK_FPS;
    primeDecoder();
    goScrub();
  }, { once: true });

  // If nothing decodable has arrived by now, the scrub would stutter more than
  // a still frame would disappoint. Bail out — unless the user is already deep
  // enough into the sequence that yanking the layout would be worse.
  window.setTimeout(() => {
    if (video.readyState < 2 && eased < 0.05) goStatic('video not ready in time');
  }, READY_TIMEOUT);

  if (video.readyState >= 1) video.dispatchEvent(new Event('loadedmetadata'));
}

/* Re-measure whenever the runway's geometry can have changed. Mobile URL bars
   fire resize constantly, so this stays cheap: two reads, no writes. */
let resizeTimer = 0;
function scheduleMeasure() {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { if (mode === 'scrub') measure(); }, 120);
}

window.addEventListener('resize', scheduleMeasure, { passive: true });
window.addEventListener('orientationchange', scheduleMeasure, { passive: true });
if ('ResizeObserver' in window) new ResizeObserver(scheduleMeasure).observe(track);

boot();
