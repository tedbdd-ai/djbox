'use strict';
if (new URLSearchParams(location.search).has('kiosk')) document.body.classList.add('kiosk');
/* DJBOX – Oberfläche. Zwei Decks, Mixer, Plattenkisten, Automix, MIDI-Learn. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = s => { s = Math.max(0, Math.round(s || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
function toast(msg, ms = 1800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}

/* ───────── Punktmatrix-Schrift (5×7) ───────── */
const GL = {
  '0': ['01110','10001','10011','10101','11001','10001','01110'], '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'], '3': ['11111','00010','00100','00010','00001','10001','01110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'], '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['00110','01000','10000','11110','10001','10001','01110'], '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'], '9': ['01110','10001','10001','01111','00001','00010','01100'],
  '.': ['0','0','0','0','0','0','1'], ':': ['0','1','1','0','1','1','0'], ' ': ['00','00','00','00','00','00','00'],
  '-': ['000','000','000','111','000','000','000'], '+': ['000','000','010','111','010','000','000'],
  '%': ['11001','11010','00010','00100','01000','01011','10011'], '~': ['00000','00000','01000','10101','00010','00000','00000'],
  'D': ['11110','10001','10001','10001','10001','10001','11110'], 'J': ['00111','00010','00010','00010','00010','10010','01100'],
  'B': ['11110','10001','10001','11110','10001','10001','11110'], 'O': ['01110','10001','10001','10001','10001','10001','01110'],
  'X': ['10001','10001','01010','00100','01010','10001','10001'],
};
function dots(cv, text, { align = 'left', lit = '#ececec', off = '#141414' } = {}) {
  const g = cv.getContext('2d'), p = Math.floor(cv.height / 7);
  g.clearRect(0, 0, cv.width, cv.height);
  const cols = [];
  for (const ch of String(text)) {
    const gl = GL[ch] || GL[' '];
    for (let x = 0; x < gl[0].length; x++) cols.push(gl.map(r => r[x] === '1'));
    cols.push(null);
  }
  cols.pop();
  const x0 = align === 'right' ? cv.width - cols.length * p : 0;
  for (let i = 0; i < cols.length; i++) for (let y = 0; y < 7; y++) {
    g.fillStyle = cols[i] && cols[i][y] ? lit : off;
    g.fillRect(x0 + i * p, y * p, p - 1, p - 1);
  }
}

/* ───────── Steuerwerte ───────── */
const DEF = { volA: .85, volB: .85, xfader: 0, hiA: 0, midA: 0, loA: 0, filterA: 0, hiB: 0, midB: 0, loB: 0, filterB: 0, tempoA: 0, tempoB: 0 };
const c = { ...DEF };
const widgets = {};
const TEMPO_RANGE = 0.08;
let settings = { automix_seconds: 16, keylock: false, midi_map: {} };

function bindW(name, fn) { (widgets[name] ||= []).push(fn); fn(c[name]); }
function setCtl(name, v, src = 'ui') {
  const lo = name.startsWith('vol') || name === 'xfader' ? 0 : -1;
  v = clamp(+v, lo, 1);
  if (lo === -1 && Math.abs(v) < 0.02) v = 0;
  c[name] = v;
  applyCtl(name);
  (widgets[name] || []).forEach(f => f(v));
  if (src !== 'auto') {
    if (name === 'xfader' && auto.trans) cancelTransition('MANUELL');
    if (name.startsWith('tempo')) { const d = decks[name.slice(-1)]; if (d && src !== 'sync') d.setSync(false); }
  }
}

/* ───────── Audio ───────── */
let ctx, master, masterAn;
function initAudio() {
  ctx = new AudioContext({ latencyHint: 'playback' });
  master = ctx.createGain();
  masterAn = ctx.createAnalyser(); masterAn.fftSize = 512;
  master.connect(masterAn); masterAn.connect(ctx.destination);
}
function resumeAudio() { if (ctx && ctx.state !== 'running') ctx.resume(); }
function eqDb(v) { return v < 0 ? v * 32 : v * 6; }
function applyCtl(name) {
  if (!ctx) return;
  const now = ctx.currentTime, k = name.slice(-1), d = decks[k];
  if (name === 'xfader') {
    const x = c.xfader;
    decks.A.xf.gain.setTargetAtTime(Math.cos(x * Math.PI / 2), now, .01);
    decks.B.xf.gain.setTargetAtTime(Math.sin(x * Math.PI / 2), now, .01);
  } else if (name.startsWith('vol')) d.vol.gain.setTargetAtTime(Math.pow(c[name], 1.6), now, .01);
  else if (/^(hi|mid|lo)/.test(name)) d[name.slice(0, -1)].gain.setTargetAtTime(eqDb(c[name]), now, .01);
  else if (name.startsWith('filter')) {
    const v = c[name], f = d.flt;
    if (v <= 0) { f.type = 'lowpass'; f.frequency.setTargetAtTime(20000 * Math.pow(100 / 20000, -v), now, .02); }
    else { f.type = 'highpass'; f.frequency.setTargetAtTime(15 * Math.pow(6000 / 15, v), now, .02); }
    f.Q.value = Math.abs(v) < .03 ? .5 : 1.3;
  } else if (name.startsWith('tempo')) d.updateRate();
}
function peakOf(an, buf) {
  an.getFloatTimeDomainData(buf);
  let m = 0; for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; }
  return clamp((20 * Math.log10(m || 1e-6) + 48) / 48, 0, 1);
}

/* ───────── Deck ───────── */
const anCache = {};
class Deck {
  constructor(id) {
    this.id = id; this.track = null; this.an = null; this.cue = 0; this.tc = false;
    this.fresh = false; this.loading = false; this.sync = false; this.nudge = 0; this.glide = false;
    const el = this.el = new Audio();
    el.preload = 'auto';
    el.addEventListener('canplay', () => { this.loading = false; this.updateRate(); this.ui(); });
    el.addEventListener('play', () => this.ui());
    el.addEventListener('pause', () => this.ui());
    el.addEventListener('ended', () => { this.ui(); onEnded(this); });
    el.addEventListener('error', () => {
      if (!this.track) return;
      if (!this.tc) { this.tc = true; el.src = `/api/audio/${this.track.id}?tc=1`; el.load(); return; }
      this.loading = false; this.ui(); toast(`DECK ${id}: DATEI NICHT LESBAR`);
    });
    this.root = $('#deck' + id);
    this.root.append($('#deck-tpl').content.cloneNode(true));
    const q = s => $(s, this.root);
    Object.assign(this, {
      uName: q('.d-name'), uState: q('.d-state'), uBpm: q('.d-bpm'), uCover: q('.d-cover'), uTitle: q('.d-title'),
      uArtist: q('.d-artist'), uTime: q('.d-time'), uPitch: q('.d-pitch'), uZoom: q('.d-zoom'), uOver: q('.d-over'),
      bPlay: q('.b-play'), bCue: q('.b-cue'), bSync: q('.b-sync'),
    });
    this.uName.textContent = id;
    q('.tempo').dataset.ctl = 'tempo' + id;
    this.bPlay.onclick = () => this.toggle();
    this.bCue.onclick = () => this.cuePress();
    this.bSync.onclick = () => this.setSync(!this.sync, true);
    $$('.b-nudge', this.root).forEach(b => {
      const n = +b.dataset.n;
      b.addEventListener('pointerdown', () => { this.nudge = n * 0.04; this.updateRate(); });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => { this.nudge = 0; this.updateRate(); });
    });
    this.wireWave();
  }
  graph() {
    const mk = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; };
    this.src = ctx.createMediaElementSource(this.el);
    this.lo = mk('lowshelf', 220); this.mid = mk('peaking', 1000, .7); this.hi = mk('highshelf', 3200);
    this.flt = mk('lowpass', 20000, .5);
    this.vol = ctx.createGain(); this.xf = ctx.createGain();
    this.anl = ctx.createAnalyser(); this.anl.fftSize = 512;
    this.src.connect(this.lo); this.lo.connect(this.mid); this.mid.connect(this.hi); this.hi.connect(this.flt);
    this.flt.connect(this.vol); this.vol.connect(this.anl); this.vol.connect(this.xf); this.xf.connect(master);
  }
  get other() { return this.id === 'A' ? decks.B : decks.A; }
  get playing() { return !this.el.paused && !this.el.ended; }
  get rate() { return this.el.playbackRate || 1; }
  get duration() { return (isFinite(this.el.duration) && this.el.duration) || this.an?.duration || this.track?.duration || 0; }
  get bpm() { return this.an?.bpm || this.track?.bpm || null; }
  get audible() { const x = this.id === 'A' ? 1 - c.xfader : c.xfader; return this.playing && x > .1 && c['vol' + this.id] > .05; }
  updateRate() {
    this.el.preservesPitch = !!settings.keylock;
    this.el.playbackRate = clamp(1 + c['tempo' + this.id] * TEMPO_RANGE + this.nudge, .5, 2);
  }
  load(t) {
    if (!t) return;
    this.track = t; this.an = anCache[t.id] || null; this.cue = 0; this.tc = false;
    this.fresh = true; this.loading = true; this.glide = false;
    this.setSync(false);
    this.el.src = `/api/audio/${t.id}`; this.el.load();
    this.overview = null;
    this.ui(); markLoaded();
    if (!this.an) {
      fetch(`/api/analysis/${t.id}`).then(r => r.ok ? r.json() : null).then(a => {
        if (!a) return;
        anCache[t.id] = a;
        if (this.track?.id === t.id) { this.an = a; this.overview = null; this.ui(); }
      }).catch(() => {});
    }
  }
  toggle() {
    if (!this.track) return;
    resumeAudio();
    if (this.playing) this.el.pause();
    else { this.fresh = false; this.el.play().catch(() => {}); }
  }
  cuePress() {
    if (!this.track) return;
    if (this.playing) { this.el.pause(); this.el.currentTime = this.cue; }
    else if (Math.abs(this.el.currentTime - this.cue) < .05) this.el.currentTime = 0, this.cue = 0;
    else { this.cue = this.el.currentTime; toast(`CUE ${this.id} @ ${fmt(this.cue)}`, 900); }
    this.overview = null;
  }
  setSync(on, user) {
    this.sync = on;
    this.bSync.classList.toggle('on', on);
    if (on) {
      const r = this.syncRatio();
      if (r == null) { this.sync = false; this.bSync.classList.remove('on'); if (user) toast('SYNC: BPM UNBEKANNT ODER ZU WEIT WEG'); return; }
      setCtl('tempo' + this.id, (r - 1) / TEMPO_RANGE, 'sync');
    }
  }
  syncRatio() {
    const o = this.other;
    if (!this.bpm || !o.bpm) return null;
    const target = o.bpm * o.rate / this.bpm;
    let best = null;
    for (const m of [1, 2, .5]) { const r = target * m; if (Math.abs(r - 1) <= TEMPO_RANGE && (best == null || Math.abs(r - 1) < Math.abs(best - 1))) best = r; }
    return best;
  }
  wireWave() {
    this.uOver.addEventListener('pointerdown', e => {
      if (!this.track) return;
      const r = this.uOver.getBoundingClientRect();
      this.el.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * this.duration;
    });
    let lx = null;
    this.uZoom.addEventListener('pointerdown', e => { lx = e.clientX; this.uZoom.setPointerCapture(e.pointerId); });
    this.uZoom.addEventListener('pointermove', e => {
      if (lx == null || !this.track) return;
      const dx = e.clientX - lx; lx = e.clientX;
      this.el.currentTime = clamp(this.el.currentTime - dx / this.uZoom.width * ZOOM_WIN, 0, this.duration);
    });
    for (const ev of ['pointerup', 'pointercancel']) this.uZoom.addEventListener(ev, () => (lx = null));
  }
  ui() {
    const t = this.track;
    this.root.classList.toggle('playing', this.playing);
    this.bPlay.textContent = this.playing ? '❚❚' : '▶';
    this.uState.textContent = !t ? 'EMPTY' : this.loading ? 'LOADING…' : this.playing ? 'PLAY' : this.el.ended ? 'END' : 'CUE';
    this.uTitle.textContent = t ? t.title : '—';
    this.uArtist.textContent = t ? t.artist || ' ' : ' ';
    setCover(this.uCover, t?.album, t ? (t.artist || t.title) : '');
    if (this.coverAlbum !== t?.album) this.coverAlbum = t?.album;
  }
}
const ZOOM_WIN = 12; // Sekunden im Zoom-Fenster

/* ───────── Zeichnen ───────── */
function drawOverview(d) {
  const cv = d.uOver, W = cv.width, H = cv.height;
  const o = d.overview = document.createElement('canvas'); o.width = W; o.height = H;
  const g = o.getContext('2d'), pk = d.an?.peaks;
  if (!pk?.length) return;
  g.fillStyle = '#ececec';
  for (let x = 0; x < W; x += 2) {
    const i0 = Math.floor(x / W * pk.length), i1 = Math.max(i0 + 1, Math.floor((x + 2) / W * pk.length));
    let m = 0; for (let i = i0; i < i1; i++) m = Math.max(m, pk[i] || 0);
    const bh = Math.max(1, Math.round(m * (H - 2)));
    g.fillRect(x, (H - bh) >> 1, 1, bh);
  }
}
function drawDeck(d) {
  const t = d.track, pos = d.el.currentTime || 0, dur = d.duration;
  const bpm = d.bpm ? d.bpm * d.rate : null;
  dots(d.uBpm, bpm ? (d.an?.bpm_estimated && !d.track?.bpm ? '~' : '') + bpm.toFixed(1) : '---.-', { align: 'right' });
  dots(d.uTime, t ? '-' + fmt((dur - pos) / d.rate) : '--:--');
  const pct = (d.rate - 1) * 100;
  dots(d.uPitch, (pct >= 0 ? '+' : '-') + Math.abs(pct).toFixed(1) + '%', { lit: Math.abs(pct) < .05 ? '#7a7a7a' : '#ececec' });
  // Zoom
  const z = d.uZoom, g = z.getContext('2d'), W = z.width, H = z.height, pk = d.an?.peaks;
  g.clearRect(0, 0, W, H);
  if (pk?.length && dur) {
    const bps = pk.length / dur, t0 = pos - ZOOM_WIN / 2, mid = H / 2;
    for (let x = 0; x < W; x += 3) {
      const ts = t0 + x / W * ZOOM_WIN;
      if (ts < 0 || ts > dur) continue;
      const v = pk[Math.floor(ts * bps)] || 0, bh = Math.max(1, Math.round(v * (H - 4) / 2));
      g.fillStyle = ts < pos ? '#555' : '#ececec';
      g.fillRect(x, mid - bh, 2, bh * 2);
    }
    if (d.cue > 0) { const cx = (d.cue - t0) / ZOOM_WIN * W; g.fillStyle = '#ececec'; g.fillRect(cx, 0, 1, 6); g.fillRect(cx, H - 6, 1, 6); }
  } else if (t) {
    g.fillStyle = '#3a3a3a'; g.font = '11px DejaVu Sans Mono'; g.fillText(d.loading ? 'LOADING …' : 'ANALYSE …', 8, H / 2 + 4);
  } else {
    g.fillStyle = '#1c1c1c'; for (let x = 0; x < W; x += 6) g.fillRect(x, H / 2, 2, 1);
  }
  g.fillStyle = '#fff'; g.fillRect(W / 2, 0, 1, H);
  // Übersicht
  const o = d.uOver, og = o.getContext('2d');
  og.clearRect(0, 0, o.width, o.height);
  if (pk?.length && !d.overview) drawOverview(d);
  if (d.overview) og.drawImage(d.overview, 0, 0);
  else { og.fillStyle = '#1c1c1c'; og.fillRect(0, o.height / 2, o.width, 1); }
  if (dur) {
    const px = pos / dur * o.width;
    og.fillStyle = 'rgba(0,0,0,.62)'; og.fillRect(0, 0, px, o.height);
    og.fillStyle = '#fff'; og.fillRect(px, 0, 2, o.height);
    if (d.cue > 0) { og.fillRect(d.cue / dur * o.width, 0, 1, 4); }
    // letzte 30 s markieren
    const w30 = Math.min(o.width, 30 / dur * o.width);
    og.fillStyle = '#ececec'; og.fillRect(o.width - w30, o.height - 1, w30, 1);
  }
}

const meterBuf = new Float32Array(512);
let lastFrame = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (ts - lastFrame < 33) return;
  lastFrame = ts;
  for (const d of Object.values(decks)) {
    drawDeck(d);
    d.root.classList.toggle('live', d.audible);
    if (ctx) $(`[data-meter="${d.id}"]`).style.setProperty('--v', (d.playing ? peakOf(d.anl, meterBuf) * 100 : 0) + '%');
  }
  if (ctx) {
    const m = (decks.A.playing || decks.B.playing) ? peakOf(masterAn, meterBuf) * 100 : 0;
    $$('#master-meter i').forEach(i => i.style.setProperty('--v', m + '%'));
  }
  const now = new Date();
  dots($('#clock'), `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, { align: 'right', off: '#000' });
}

/* ───────── Bedienelemente ───────── */
function arcPath(cx, cy, r, a0, a1) {
  const p = a => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${Math.abs(a1 - a0) > Math.PI ? 1 : 0} ${a1 > a0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function makeKnob(el) {
  const name = el.dataset.ctl, R = .75 * Math.PI;
  el.innerHTML = `<svg viewBox="0 0 60 54"><path class="trk" fill="none" stroke="#2a2a2a" stroke-width="3"/><path class="val" fill="none" stroke="#ececec" stroke-width="3"/><line class="ind" stroke="#ececec" stroke-width="2" stroke-linecap="square"/><circle cx="30" cy="24" r="13" fill="#0c0c0c" stroke="#3a3a3a"/><text x="30" y="52" text-anchor="middle" fill="#7a7a7a" font-size="10" font-family="DejaVu Sans Mono">${el.dataset.label}</text></svg>`;
  $('.trk', el).setAttribute('d', arcPath(30, 24, 19, -R, R));
  const val = $('.val', el), ind = $('.ind', el);
  bindW(name, v => {
    const a = v * R;
    val.setAttribute('d', Math.abs(a) < .01 ? '' : arcPath(30, 24, 19, Math.min(0, a), Math.max(0, a)));
    ind.setAttribute('x1', 30 + 4 * Math.sin(a)); ind.setAttribute('y1', 24 - 4 * Math.cos(a));
    ind.setAttribute('x2', 30 + 12 * Math.sin(a)); ind.setAttribute('y2', 24 - 12 * Math.cos(a));
    ind.setAttribute('stroke', v <= -.99 ? '#555' : '#ececec');
  });
  let y0 = null, v0 = 0, lastTap = 0;
  el.addEventListener('pointerdown', e => {
    resumeAudio();
    if (e.timeStamp - lastTap < 320) { setCtl(name, 0); lastTap = 0; return; }
    lastTap = e.timeStamp; y0 = e.clientY; v0 = c[name]; el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => { if (y0 != null) setCtl(name, v0 + (y0 - e.clientY) / 110); });
  for (const ev of ['pointerup', 'pointercancel']) el.addEventListener(ev, () => (y0 = null));
}
function makeFader(el, vertical) {
  const name = el.dataset.ctl, cap = h('div', { class: 'cap' });
  el.append(cap);
  const bip = name.startsWith('tempo');
  const toUnit = v => bip ? (v + 1) / 2 : v, fromUnit = u => bip ? u * 2 - 1 : u;
  bindW(name, v => { const u = toUnit(v); if (vertical) cap.style.top = `calc(7px + ${(1 - u)} * (100% - 14px))`; else cap.style.left = `calc(8px + ${u} * (100% - 16px))`; });
  let active = false, lastTap = 0;
  const set = e => {
    const r = el.getBoundingClientRect();
    const u = vertical ? 1 - (e.clientY - r.top - 7) / (r.height - 14) : (e.clientX - r.left - 8) / (r.width - 16);
    let v = fromUnit(clamp(u, 0, 1));
    if (bip && Math.abs(v) < .04) v = 0;
    setCtl(name, v);
  };
  el.addEventListener('pointerdown', e => {
    resumeAudio();
    if (bip && e.timeStamp - lastTap < 320) { setCtl(name, 0); return; }
    lastTap = e.timeStamp; active = true; el.setPointerCapture(e.pointerId); set(e);
  });
  el.addEventListener('pointermove', e => active && set(e));
  for (const ev of ['pointerup', 'pointercancel']) el.addEventListener(ev, () => (active = false));
}

/* ───────── Bibliothek / Browser ───────── */
let lib = { tracks: {}, albums: {}, status: {} };
let view = store.get('djbox.view', 'ALL');
let queueIds = store.get('djbox.queue', []);
const history = [];

function setCover(el, aid, label) {
  if (el.dataset.aid === (aid || '')) return;
  el.dataset.aid = aid || '';
  el.textContent = ''; el.classList.remove('ph'); el.style.backgroundImage = '';
  if (!aid) return;
  const img = new Image();
  img.onload = () => { if (el.dataset.aid === aid) el.style.backgroundImage = `url(${img.src})`; };
  img.onerror = () => { if (el.dataset.aid === aid) { el.classList.add('ph'); el.textContent = initials(label); } };
  img.src = `/api/cover/${aid}`;
}
function initials(s) { return (s || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'; }

const crateOrder = () => [...new Set(Object.values(lib.albums).map(a => a.crate))].sort();
function albumsFor(v) {
  const all = Object.values(lib.albums);
  if (v === 'NEW') return all.sort((a, b) => b.added - a.added).slice(0, 60);
  const list = v === 'ALL' ? all : all.filter(a => a.crate === v);
  return list.sort((a, b) => norm(a.artist + a.title).localeCompare(norm(b.artist + b.title)));
}
function renderCrates() {
  const nav = $('#crates'); nav.textContent = '';
  const items = [['ALL', Object.keys(lib.albums).length], ['NEW', null],
    ...crateOrder().map(cr => [cr, Object.values(lib.albums).filter(a => a.crate === cr).length]),
    ['QUEUE', queueIds.length], ['SEARCH', null]];
  for (const [k, n] of items) {
    nav.append(h('button', { class: view === k ? 'on' : null, onclick: () => k === 'SEARCH' ? openSearch() : setView(k) },
      h('span', {}, k), n != null ? h('small', {}, String(n)) : null));
  }
}
function setView(v) { view = v; store.set('djbox.view', v); renderCrates(); renderView(); }
function renderView() {
  const grid = $('#grid'), list = $('#list'), az = $('#az');
  if (view === 'QUEUE') {
    grid.hidden = true; az.hidden = true; list.hidden = false; list.textContent = '';
    if (!queueIds.length) list.append(h('div', { class: 'empty' }, 'QUEUE LEER — IM ALBUM MIT + HINZUFÜGEN. AUTO SPIELT SONST ZUFÄLLIG AUS DER AKTUELLEN KISTE.'));
    else list.append(h('div', { class: 'tr' }, h('span', { class: 'tt' }, `${queueIds.length} TRACKS`), h('button', { onclick: () => { queueIds = []; saveQueue(); } }, 'LEEREN')));
    queueIds.forEach((id, i) => { const t = lib.tracks[id]; if (t) list.append(trackRow(t, i + 1, { remove: () => { queueIds.splice(i, 1); saveQueue(); } })); });
    return;
  }
  list.hidden = true; grid.hidden = false; az.hidden = view === 'NEW';
  grid.textContent = '';
  const als = albumsFor(view);
  const letters = new Map();
  for (const a of als) {
    const L = norm(a.artist)[0]?.toUpperCase() || '#', key = /[A-Z]/.test(L) ? L : '#';
    const cv = h('div', { class: 'cv' });
    const card = h('div', { class: 'al', onclick: () => openAlbum(a.id) }, cv, h('div', { class: 't' }, a.title), h('div', { class: 'a' }, a.artist));
    if (view === 'ALL' || view === 'NEW') cv.append(h('span', { class: 'badge' }, a.crate));
    lazyCover(cv, a);
    if (!letters.has(key)) letters.set(key, card);
    grid.append(card);
  }
  if (!als.length) grid.append(h('div', { class: 'empty' }, lib.status.scanning ? `SAMMLUNG WIRD GELESEN … ${lib.status.done}/${lib.status.total}` : 'KEINE ALBEN'));
  az.textContent = '';
  for (const L of '#ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const target = letters.get(L);
    az.append(h('button', { style: target ? null : 'opacity:.25', onclick: () => target && (grid.scrollLeft = target.offsetLeft - 10) }, L));
  }
  grid.scrollLeft = store.get('djbox.scroll.' + view, 0);
}
$('#grid').addEventListener('scroll', () => store.set('djbox.scroll.' + view, $('#grid').scrollLeft), { passive: true });

const coverObs = new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return;
  coverObs.unobserve(e.target);
  const a = lib.albums[e.target.dataset.aid0];
  if (a) setCover(e.target, a.id, a.artist || a.title);
}), { root: $('#grid'), rootMargin: '0px 600px' });
function lazyCover(cv, a) { cv.dataset.aid0 = a.id; coverObs.observe(cv); }

function trackRow(t, n, { remove } = {}) {
  const row = h('div', { class: 'tr', 'data-tid': t.id },
    h('span', { class: 'n' }, n != null ? String(n).padStart(2, '0') : ''),
    h('div', { class: 'tt' }, h('div', {}, t.title), h('div', { class: 'ar' }, t.artist)),
    h('span', { class: 'bpm' }, t.bpm ? String(Math.round(t.bpm)) : (anCache[t.id]?.bpm ? '~' + Math.round(anCache[t.id].bpm) : '')),
    h('span', { class: 'dur' }, fmt(t.duration)),
    loadBtn('A', t), loadBtn('B', t),
    remove ? h('button', { onclick: remove }, '×') : h('button', { onclick: e => { addQueue(t.id); e.target.classList.add('on'); setTimeout(() => e.target.classList.remove('on'), 400); } }, '+Q'));
  if ([decks.A.track?.id, decks.B.track?.id].includes(t.id)) row.classList.add('loaded');
  return row;
}
function loadBtn(id, t) {
  return h('button', {
    onclick: e => {
      const d = decks[id], b = e.currentTarget;
      if (d.audible && !b.classList.contains('arm')) {
        b.classList.add('arm'); toast(`DECK ${id} LÄUFT — NOCHMAL TIPPEN ZUM LADEN`);
        setTimeout(() => b.classList.remove('arm'), 2500); return;
      }
      b.classList.remove('arm');
      d.load(t); toast(`→ DECK ${id}: ${t.title}`, 1200);
    },
  }, id);
}
function markLoaded() {
  const ids = [decks.A.track?.id, decks.B.track?.id];
  $$('.tr[data-tid]').forEach(r => r.classList.toggle('loaded', ids.includes(r.dataset.tid)));
}
function addQueue(id) { queueIds.push(id); saveQueue(); fetch(`/api/prepare/${id}`, { method: 'POST' }).catch(() => {}); toast(`QUEUE +1 (${queueIds.length})`, 900); }
function saveQueue() { store.set('djbox.queue', queueIds); renderCrates(); if (view === 'QUEUE') renderView(); }

function openAlbum(aid) {
  const a = lib.albums[aid]; if (!a) return;
  const ov = $('#album'); ov.textContent = ''; ov.hidden = false;
  const tr = a.tracks.map(id => lib.tracks[id]).filter(Boolean);
  const total = tr.reduce((s, t) => s + t.duration, 0);
  const cv = h('div', { class: 'cv' });
  ov.append(
    h('div', { class: 'ov-head' }, h('span', {}, `${a.crate} / ${a.artist}`), h('button', { 'data-close': true, onclick: () => (ov.hidden = true) }, '×')),
    h('div', { class: 'body' },
      h('div', { class: 'big' }, cv, h('h2', {}, a.title), h('div', {}, a.artist),
        h('div', { class: 'meta' }, [a.year, a.genres.join(' / '), `${tr.length} TRACKS`, fmt(total)].filter(Boolean).join(' · ')),
        h('button', { onclick: () => { tr.forEach(t => queueIds.push(t.id)); saveQueue(); toast(`${tr.length} TRACKS IN QUEUE`); } }, 'ALLES IN QUEUE')),
      h('div', { class: 'tracks' }, tr.map((t, i) => trackRow(t, t.track || i + 1)))));
  setCover(cv, a.id, a.artist || a.title);
}

/* ───────── Suche ───────── */
let qText = '';
function openSearch() {
  $('#search').hidden = false;
  if (!$('#kbd').children.length) buildKbd();
  renderSearch();
}
function buildKbd() {
  const rows = ['1234567890', 'QWERTZUIOP', 'ASDFGHJKL', 'YXCVBNM'];
  for (const r of rows) $('#kbd').append(h('div', { class: 'row' }, [...r].map(k => h('button', { onclick: () => { qText += k.toLowerCase(); renderSearch(); } }, k))));
  $('#kbd').append(h('div', { class: 'row' },
    h('button', { class: 'w', onclick: () => { qText = ''; renderSearch(); } }, 'CLR'),
    h('button', { class: 'ww', onclick: () => { qText += ' '; renderSearch(); } }, 'SPACE'),
    h('button', { class: 'w', onclick: () => { qText = qText.slice(0, -1); renderSearch(); } }, '⌫')));
}
function renderSearch() {
  $('#q').textContent = qText;
  const res = $('#results'); res.textContent = '';
  const toks = norm(qText).split(/\s+/).filter(Boolean);
  if (!toks.length) { res.append(h('div', { class: 'empty' }, 'TITEL, ARTIST, ALBUM ODER GENRE')); return; }
  const als = Object.values(lib.albums).filter(a => toks.every(t => norm(`${a.title} ${a.artist} ${a.genres.join(' ')}`).includes(t))).slice(0, 6);
  for (const a of als) res.append(h('div', { class: 'tr', onclick: () => { $('#search').hidden = true; openAlbum(a.id); } },
    h('span', { class: 'n' }, '▣'), h('div', { class: 'tt' }, h('div', {}, a.title), h('div', { class: 'ar' }, `ALBUM · ${a.artist}`))));
  const trs = Object.values(lib.tracks).filter(t => {
    const s = norm(`${t.title} ${t.artist} ${lib.albums[t.album]?.title} ${lib.albums[t.album]?.artist} ${t.genre}`);
    return toks.every(x => s.includes(x));
  }).slice(0, 80);
  for (const t of trs) res.append(trackRow(t, null));
  if (!als.length && !trs.length) res.append(h('div', { class: 'empty' }, 'NICHTS GEFUNDEN'));
}

/* ───────── Automix ───────── */
const auto = { on: false, trans: null };
function liveDeck() { return c.xfader < .5 ? decks.A : decks.B; }
function pickNext(cur) {
  while (queueIds.length) { const t = lib.tracks[queueIds.shift()]; saveQueue(); if (t) return t; }
  const crate = cur?.crate || (view !== 'ALL' && view !== 'NEW' && view !== 'QUEUE' ? view : null);
  const busy = new Set([decks.A.track?.id, decks.B.track?.id, ...history.slice(-80)]);
  let pool = Object.values(lib.tracks).filter(t => (!crate || t.crate === crate) && !busy.has(t.id) && t.duration > 90 && t.duration < 1200);
  if (!pool.length) pool = Object.values(lib.tracks).filter(t => !busy.has(t.id));
  if (!pool.length) return null;
  const curBpm = cur && (anCache[cur.id]?.bpm || cur.bpm);
  const cands = Array.from({ length: Math.min(12, pool.length) }, () => pool[Math.floor(Math.random() * pool.length)]);
  const score = t => { const b = anCache[t.id]?.bpm || t.bpm; if (!curBpm || !b) return .5 + Math.random() * .2; const r = b / curBpm; return Math.min(...[r, r * 2, r / 2].map(x => Math.abs(x - 1))); };
  return cands.sort((a, b) => score(a) - score(b))[0];
}
function setAuto(on) {
  auto.on = on;
  $('#btn-auto').classList.toggle('on', on);
  if (!on) { cancelTransition(); return; }
  resumeAudio();
  const L = liveDeck();
  if (!L.track) { L.load(pickNext(null)); }
  if (!L.playing) { L.fresh = false; L.el.play().catch(() => {}); }
  toast('AUTO MIX AN');
}
function startTransition(L, O, len) {
  O.fresh = false;
  if (O.el.currentTime > 1) O.el.currentTime = 0;
  if (O.syncRatio() != null) O.setSync(true); else setCtl('tempo' + O.id, 0, 'auto');
  setCtl('lo' + O.id, -1, 'auto');
  setCtl('vol' + O.id, c['vol' + L.id] || .85, 'auto');
  O.el.play().catch(() => {});
  auto.trans = { L, O, t0: performance.now(), dur: len * 1000, x0: c.xfader, x1: O.id === 'B' ? 1 : 0, loL: c['lo' + L.id] };
  history.push(O.track.id);
}
function cancelTransition(why) {
  if (!auto.trans) return;
  const { O } = auto.trans;
  if (c['lo' + O.id] < 0) setCtl('lo' + O.id, 0, 'auto');
  auto.trans = null;
  if (why) toast('AUTO: ' + why);
}
function autoTick() {
  const tr = auto.trans;
  if (tr) {
    const p = clamp((performance.now() - tr.t0) / tr.dur, 0, 1);
    const e = p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    setCtl('xfader', tr.x0 + (tr.x1 - tr.x0) * e, 'auto');
    const s = clamp((p - .4) / .2, 0, 1); // Bass-Tausch in der Mitte
    setCtl('lo' + tr.O.id, -1 + s, 'auto');
    setCtl('lo' + tr.L.id, tr.loL - s * (1 + tr.loL), 'auto');
    if (p >= 1) {
      tr.L.el.pause(); setCtl('lo' + tr.L.id, 0, 'auto'); tr.L.fresh = false;
      tr.O.glide = true; tr.O.setSync(false);
      auto.trans = null;
    }
    return;
  }
  for (const d of Object.values(decks)) {
    // nach dem Übergang Tempo langsam zurück auf 0 ziehen
    if (d.glide) { const v = c['tempo' + d.id]; if (Math.abs(v) < .01) { setCtl('tempo' + d.id, 0, 'auto'); d.glide = false; } else setCtl('tempo' + d.id, v - Math.sign(v) * .002, 'auto'); }
    if (d.sync && d.playing) { const r = d.syncRatio(); if (r) setCtl('tempo' + d.id, (r - 1) / TEMPO_RANGE, 'sync'); }
  }
  if (!auto.on) return;
  const L = liveDeck(), O = L.other;
  if (!L.track || !L.playing) return;
  const len = settings.automix_seconds || 16;
  const rem = (L.duration - L.el.currentTime) / L.rate;
  if (!L.duration) return;
  if (rem < len + 45 && !O.fresh && !O.loading && !O.playing) { const n = pickNext(L.track); if (n) { O.load(n); } }
  if (rem <= len && O.fresh && !O.loading) startTransition(L, O, Math.max(4, Math.min(len, rem - 1)));
}
function onEnded(d) {
  if (auto.on && !auto.trans && d === liveDeck() && d.other.fresh) startTransition(d, d.other, 4);
}

/* ───────── MIDI ───────── */
const MIDI_TARGETS = [
  ['xfader', 'CROSSFADER'], ['volA', 'FADER A'], ['volB', 'FADER B'],
  ['hiA', 'HI A'], ['midA', 'MID A'], ['loA', 'LO A'], ['filterA', 'FILTER A'],
  ['hiB', 'HI B'], ['midB', 'MID B'], ['loB', 'LO B'], ['filterB', 'FILTER B'],
  ['tempoA', 'TEMPO A'], ['tempoB', 'TEMPO B'],
  ['playA', 'PLAY A', 'btn'], ['playB', 'PLAY B', 'btn'], ['cueA', 'CUE A', 'btn'], ['cueB', 'CUE B', 'btn'],
  ['syncA', 'SYNC A', 'btn'], ['syncB', 'SYNC B', 'btn'], ['auto', 'AUTO MIX', 'btn'],
];
let learning = null, midiDevs = [];
const btnState = {};
function midiKey(ev) {
  const s = ev.s === 0x80 ? 0x90 : ev.s;
  return s === 0xE0 ? `${ev.dev}|${s}|${ev.ch}` : `${ev.dev}|${s}|${ev.ch}|${ev.d1}`;
}
function onMidi(ev) {
  if (![0x80, 0x90, 0xB0, 0xE0].includes(ev.s)) return;
  const key = midiKey(ev);
  if (learning) {
    if (ev.s === 0x80 || (ev.s === 0x90 && ev.d2 === 0)) return;
    for (const k of Object.keys(settings.midi_map)) if (settings.midi_map[k] === learning) delete settings.midi_map[k];
    settings.midi_map[key] = learning;
    toast(`MIDI → ${learning.toUpperCase()}`); learning = null; saveSettings(); renderSettings();
    return;
  }
  const target = settings.midi_map[key];
  if (!target) return;
  const def = MIDI_TARGETS.find(t => t[0] === target);
  if (!def) return;
  if (def[2] === 'btn') {
    const down = ev.s === 0x90 ? ev.d2 > 0 : ev.s === 0xB0 ? ev.d2 >= 64 : false;
    const was = btnState[key]; btnState[key] = down;
    if (down && !was) midiButton(target);
    return;
  }
  const u = ev.s === 0xE0 ? (ev.d1 | (ev.d2 << 7)) / 16383 : ev.d2 / 127;
  const bip = !(target.startsWith('vol') || target === 'xfader');
  setCtl(target, bip ? u * 2 - 1 : u, 'midi');
}
function midiButton(t) {
  resumeAudio();
  const d = decks[t.slice(-1)];
  if (t.startsWith('play')) d.toggle();
  else if (t.startsWith('cue')) d.cuePress();
  else if (t.startsWith('sync')) d.setSync(!d.sync, true);
  else if (t === 'auto') setAuto(!auto.on);
}
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'midi') onMidi(ev);
    else if (ev.type === 'mididev') {
      midiDevs = ev.devices;
      const el = $('#st-midi');
      el.textContent = midiDevs.length ? 'MIDI ' + midiDevs.join(' + ') : 'MIDI —';
      el.classList.toggle('live', midiDevs.length > 0);
      if (!$('#settings').hidden) renderSettings();
    }
  };
}

/* ───────── Einstellungen ───────── */
function saveSettings() { fetch('/api/settings', { method: 'POST', body: JSON.stringify(settings) }).catch(() => {}); }
function renderSettings() {
  const ov = $('#settings'); ov.textContent = '';
  const row = (lbl, val, ...btns) => h('div', { class: 'srow' }, h('span', { class: 'lbl' }, lbl), val != null ? h('span', { class: 'val' }, val) : null, ...btns);
  const opt = (v, cur, fn) => h('button', { class: v === cur ? 'on' : null, onclick: () => { fn(v); saveSettings(); renderSettings(); } }, String(v));
  const body = h('div', { class: 'body' },
    h('h3', {}, 'AUTO MIX'),
    row('ÜBERGANG (SEK.)', null, ...[8, 16, 32].map(v => opt(v, settings.automix_seconds, x => (settings.automix_seconds = x)))),
    row('KEYLOCK', 'TONHÖHE BEI TEMPO HALTEN', opt('AUS', settings.keylock ? 'AN' : 'AUS', () => { settings.keylock = false; decks.A.updateRate(); decks.B.updateRate(); }),
      opt('AN', settings.keylock ? 'AN' : 'AUS', () => { settings.keylock = true; decks.A.updateRate(); decks.B.updateRate(); })),
    h('h3', {}, `MIDI · ${midiDevs.length ? midiDevs.join(' + ') : 'KEIN GERÄT ERKANNT'} — LEARN TIPPEN, DANN REGLER AM GERÄT BEWEGEN`),
    ...MIDI_TARGETS.map(([k, lbl]) => {
      const key = Object.keys(settings.midi_map).find(m => settings.midi_map[m] === k);
      const kv = key ? key.split('|') : null;
      const desc = kv ? `${kv[0]} · ${({ 144: 'NOTE', 176: 'CC', 224: 'PB' })[kv[1]]} ${kv[3] ?? ''} CH${+kv[2] + 1}` : '—';
      return row(lbl, desc,
        h('button', { class: learning === k ? 'arm' : null, onclick: () => { learning = learning === k ? null : k; renderSettings(); } }, 'LEARN'),
        h('button', { onclick: () => { if (key) { delete settings.midi_map[key]; saveSettings(); renderSettings(); } } }, '×'));
    }),
    h('h3', {}, 'SAMMLUNG'),
    row('STATUS', lib.status.scanning ? `LIEST … ${lib.status.done}/${lib.status.total}` : `${Object.keys(lib.tracks).length} TRACKS · ${Object.keys(lib.albums).length} ALBEN`,
      h('button', { onclick: () => { fetch('/api/rescan', { method: 'POST' }); toast('SAMMLUNG WIRD NEU GELESEN'); } }, 'NEU EINLESEN')),
    row('OBERFLÄCHE', null, h('button', { onclick: () => location.reload() }, 'NEU LADEN'),
      h('button', { onclick: () => document.body.classList.toggle('cursor') }, 'MAUSZEIGER')),
  );
  ov.append(h('div', { class: 'ov-head' }, h('span', {}, 'EINSTELLUNGEN'), h('button', { 'data-close': true, onclick: () => { learning = null; ov.hidden = true; } }, '×')), body);
}

/* ───────── Start ───────── */
const decks = {};
async function loadLibrary() {
  try {
    lib = await (await fetch('/api/library')).json();
    for (const [id, a] of Object.entries(lib.analysis || {})) anCache[id] = a;
    renderCrates(); renderView();
    updateStatus(lib.status);
  } catch { setTimeout(loadLibrary, 3000); }
}
let lastUpdated = null, lastDone = 0;
function updateStatus(s) {
  const el = $('#st-lib');
  el.textContent = s.scanning ? `LIB ${s.done}/${s.total}` : `LIB ${Object.keys(lib.tracks).length}`;
  el.classList.toggle('live', !s.scanning);
  if (s.temp != null) $('#st-temp').textContent = s.temp + '°';
}
async function pollStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    updateStatus(s);
    if ((lastUpdated != null && s.updated !== lastUpdated) || (s.scanning && s.done - lastDone >= 100)) { lastDone = s.done; await loadLibrary(); }
    lastUpdated = s.updated;
  } catch {}
  setTimeout(pollStatus, 5000);
}

function init() {
  initAudio();
  decks.A = new Deck('A'); decks.B = new Deck('B');
  decks.A.graph(); decks.B.graph();
  $$('.knob').forEach(makeKnob);
  $$('.vfader').forEach(el => makeFader(el, true));
  $$('.hfader').forEach(el => makeFader(el, false));
  Object.keys(c).forEach(applyCtl);
  for (const d of Object.values(decks)) { for (const cv of [d.uZoom, d.uOver]) { cv.width = cv.clientWidth; cv.height = cv.clientHeight; } d.ui(); }
  dots($('#logo'), 'DJBOX', { off: '#000' });
  $('#btn-auto').onclick = () => setAuto(!auto.on);
  $('#btn-settings').onclick = () => { $('#settings').hidden = false; renderSettings(); };
  $('[data-close]', $('#search')).onclick = () => ($('#search').hidden = true);
  document.addEventListener('pointerdown', resumeAudio, { capture: true });
  document.addEventListener('contextmenu', e => e.preventDefault());
  fetch('/api/settings').then(r => r.json()).then(s => { settings = { ...settings, ...s }; decks.A.updateRate(); decks.B.updateRate(); }).catch(() => {});
  loadLibrary(); pollStatus(); connectEvents();
  setInterval(autoTick, 50);
  requestAnimationFrame(frame);
}
init();

/* ───────── Selbsttest (nur mit ?selftest) ───────── */
if (location.search.includes('selftest')) setTimeout(async () => {
  const log = (...a) => console.log('SELFTEST', ...a.map(x => typeof x === 'object' ? JSON.stringify(x) : x));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(250); return fn(); };
  try {
    const ts = Object.values(lib.tracks);
    const aiff = ts.find(t => t.ext.startsWith('aif') && t.duration > 120 && t.duration < 600);
    const mp3 = ts.find(t => t.ext === 'mp3' && t.duration > 120 && t.duration < 600);
    log('tracks', ts.length, 'aiff', aiff?.title, 'mp3', mp3?.title);
    let t0 = Date.now(); decks.A.load(aiff); decks.B.load(mp3);
    log('A ready', await until(() => !decks.A.loading, 40000), Date.now() - t0, 'ms', 'B ready', await until(() => !decks.B.loading, 20000));
    decks.A.toggle(); await sleep(3000);
    log('A playing', decks.A.playing, decks.A.el.currentTime.toFixed(2), 'meter', peakOf(decks.A.anl, meterBuf).toFixed(2), 'ctx', ctx.state);
    log('analysis A', await until(() => decks.A.an, 60000) && { bpm: decks.A.an.bpm, est: decks.A.an.bpm_estimated, peaks: decks.A.an.peaks.length },
        'B', await until(() => decks.B.an, 60000) && { bpm: decks.B.an.bpm, peaks: decks.B.an.peaks.length });
    setCtl('hiA', -1); setCtl('filterA', -.5); log('eq', decks.A.hi.gain.value.toFixed(1), decks.A.flt.type);
    setCtl('hiA', 0); setCtl('filterA', 0);
    decks.B.setSync(true, true); log('sync B', decks.B.sync, decks.B.rate.toFixed(3));
    settings.automix_seconds = 8; decks.A.el.currentTime = decks.A.duration - 14; setAuto(true);
    log('trans started', await until(() => auto.trans, 10000), 'B playing', decks.B.playing);
    await sleep(4000); log('mid', 'x', c.xfader.toFixed(2), 'loA', c.loA.toFixed(2), 'loB', c.loB.toFixed(2));
    await until(() => !auto.trans, 15000);
    log('done', 'x', c.xfader, 'A playing', decks.A.playing, 'B playing', decks.B.playing, 'loA', c.loA, 'loB', c.loB);
    await sleep(6000); log('next preload on A', decks.A.track?.title, 'fresh', decks.A.fresh);
    setAuto(false); decks.B.el.pause();
    log('END');
  } catch (e) { log('ERROR', e.message, e.stack); }
}, 2500);
