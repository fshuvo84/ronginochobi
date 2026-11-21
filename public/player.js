// A small, dependency-free video player: play/pause, seek, volume, subtitles
// (on/off + track choice + sync), speed, fullscreen, keyboard shortcuts,
// resume position and automatic "compatibility mode" fallback via the server.

const ICON = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  cc: 'M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z',
  fs: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  fsExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
};
const svg = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[n]}"/></svg>`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ---------- persistent settings & progress ----------

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode etc. */
    }
  },
};

export function loadProgress() {
  return store.get('mh_progress', {});
}

function saveProgress(path, entry) {
  const all = loadProgress();
  all[path] = entry;
  const keys = Object.keys(all);
  if (keys.length > 150) {
    keys.sort((a, b) => all[a].u - all[b].u).slice(0, keys.length - 150).forEach((k) => delete all[k]);
  }
  store.set('mh_progress', all);
}

// ---------- subtitles ----------

const toSec = (t) => t.replace(',', '.').split(':').map(Number).reduce((a, v) => a * 60 + v, 0);

function cueHtml(s) {
  s = s.replace(/\{\\[^}]*\}/g, ''); // ASS override tags
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  s = s.replace(/<(?!\/?(?:i|b|u)\b)[^>]*>/gi, ''); // keep only <i> <b> <u>
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return s.replace(/&lt;(\/?(?:i|b|u))&gt;/gi, '<$1>');
}

/** Parses both SRT and WebVTT text into [{start, end, html}]. */
export function parseCues(text) {
  const TIME = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => TIME.test(l));
    if (i < 0) continue;
    const m = lines[i].match(TIME);
    const body = lines.slice(i + 1).join('\n').trim();
    if (body) cues.push({ start: toSec(m[1]), end: toSec(m[2]), html: cueHtml(body) });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function decodeText(buf) {
  let b = new Uint8Array(buf);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

let langNames = null;
try {
  langNames = new Intl.DisplayNames(['en'], { type: 'language' });
} catch {
  /* ignore */
}
function langName(code) {
  if (!code) return null;
  try {
    const n = langNames && langNames.of(code);
    return n && n.toLowerCase() !== code.toLowerCase() ? n : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

// ---------- codec decisions (used only when the server has ffmpeg) ----------

const NATIVE_CONTAINERS = ['mp4', 'm4v', 'webm', 'mov', 'mkv'];
const OK_VIDEO = ['h264', 'vp8', 'vp9', 'av1'];
const OK_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];

function pickMode(file, probe, caps) {
  if (!caps.ffmpeg) return 'direct';
  const ext = file.name.split('.').pop().toLowerCase();
  if (probe) {
    if (probe.videoCodec && !OK_VIDEO.includes(probe.videoCodec)) return 'h264';
    if (!NATIVE_CONTAINERS.includes(ext)) return 'copy';
    if (probe.audioCodec && !OK_AUDIO.includes(probe.audioCodec)) return 'copy';
    return 'direct';
  }
  if (['avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ogv'].includes(ext)) return 'h264';
  if (['ts', 'm2ts'].includes(ext)) return 'copy';
  return 'direct';
}

// ---------- the player ----------

export function createPlayer(root, opts) {
  const { file, caps } = opts;
  root.innerHTML = `
    <div class="player show-ui" tabindex="0">
      <video playsinline preload="auto"></video>
      <div class="sub-layer"><span></span></div>
      <div class="spinner"><i></i></div>
      <div class="topinfo"></div>
      <div class="toast"></div>
      <div class="errbox" hidden></div>
      <div class="nextup" hidden>
        <div class="nt">Up next</div>
        <div class="nn"></div>
        <div class="nb">
          <button class="btn" data-a="next-now">Play now (<span class="cd">8</span>)</button>
          <button class="btn" data-a="next-cancel">Cancel</button>
        </div>
      </div>
      <div class="controls">
        <div class="seek"><div class="track"><div class="buf"></div><div class="played"></div><div class="thumb"></div></div><div class="tip">0:00</div></div>
        <div class="ctl-row">
          <button class="ctl" data-a="play" title="Play / Pause (k)">${svg('play')}</button>
          <button class="ctl" data-a="next" title="Next episode (n)" hidden>${svg('next')}</button>
          <div class="vol">
            <button class="ctl" data-a="mute" title="Mute (m)">${svg('volume')}</button>
            <input type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
          </div>
          <span class="time">0:00 / --:--</span>
          <span class="spacer"></span>
          <div class="ctl-wrap">
            <button class="ctl dim" data-a="cc" title="Subtitles (c)">${svg('cc')}</button>
            <div class="menu-pop" data-m="cc"></div>
          </div>
          <div class="ctl-wrap">
            <button class="ctl text" data-a="speed" title="Playback speed">1x</button>
            <div class="menu-pop" data-m="speed"></div>
          </div>
          <button class="ctl" data-a="fs" title="Fullscreen (f)">${svg('fs')}</button>
        </div>
      </div>
      <input type="file" accept=".srt,.vtt,text/vtt" hidden>
    </div>`;

  const el = root.querySelector('.player');
  const q = (s) => el.querySelector(s);
  const video = q('video');
  const seekEl = q('.seek');
  const bufEl = q('.buf');
  const playedEl = q('.played');
  const thumbEl = q('.thumb');
  const tipEl = q('.tip');
  const timeEl = q('.time');
  const volInput = q('.vol input');
  const subSpan = q('.sub-layer span');
  const toastEl = q('.toast');
  const errBox = q('.errbox');
  const nextBox = q('.nextup');
  const fileInput = q('input[type=file]');
  const btn = (a) => q(`[data-a="${a}"]`);
  const menus = { cc: q('[data-m="cc"]'), speed: q('[data-m="speed"]') };

  q('.topinfo').textContent = opts.title || file.name;
  if (opts.next) {
    btn('next').hidden = false;
    q('.nn').textContent = opts.next.title;
  }

  // state
  let destroyed = false;
  let mode = 'direct';
  let offset = 0; // seconds already "consumed" by a converted stream started with ?start=
  let pendingSeek = 0;
  let probe = null;
  let scrubbing = false;
  let scrubTime = 0;
  let hideTimer = null;
  let toastTimer = null;
  let clickTimer = null;
  let nextTimer = null;
  let lastSave = 0;
  let audioChecked = false;

  let tracks = []; // {id,label,lang,url?,cues?}
  let activeTrack = null;
  let cues = [];
  let subDelay = 0;
  let lastHtml = '';

  // ---------- helpers ----------

  const curTime = () => (mode === 'direct' ? video.currentTime : offset + video.currentTime);
  const duration = () => {
    if (mode === 'direct') return isFinite(video.duration) ? video.duration : (probe && probe.duration) || NaN;
    return (probe && probe.duration) || NaN;
  };

  function toast(msg, ms = 2200) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms);
  }

  function setLoading(on) {
    el.classList.toggle('loading', on);
  }

  function menuOpen() {
    return Object.values(menus).some((m) => m.classList.contains('open'));
  }

  function showUI() {
    el.classList.add('show-ui');
    el.classList.remove('hide-cursor');
    clearTimeout(hideTimer);
    if (!video.paused && !menuOpen() && !scrubbing) {
      hideTimer = setTimeout(() => {
        el.classList.remove('show-ui');
        if (document.fullscreenElement === el || !video.paused) el.classList.add('hide-cursor');
      }, 2800);
    }
  }

  function bufferedEnd() {
    const b = video.buffered;
    const t = video.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.5 && b.end(i) >= t) return b.end(i);
    }
    return t;
  }

  function inBuffered(rel) {
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) if (rel >= b.start(i) && rel <= b.end(i) - 0.5) return true;
    return false;
  }

  // ---------- UI refresh ----------

  function updateUI() {
    const d = duration();
    const t = scrubbing ? scrubTime : curTime();
    timeEl.textContent = `${fmt(t)} / ${isFinite(d) ? fmt(d) : '--:--'}`;
    const pct = isFinite(d) && d > 0 ? clamp((t / d) * 100, 0, 100) : 0;
    playedEl.style.width = pct + '%';
    thumbEl.style.left = pct + '%';
    const end = (mode === 'direct' ? 0 : offset) + bufferedEnd();
    bufEl.style.width = (isFinite(d) && d > 0 ? clamp((end / d) * 100, 0, 100) : 0) + '%';
  }

  function updatePlayIcon() {
    btn('play').innerHTML = svg(video.paused ? 'play' : 'pause');
  }

  function updateVolIcon() {
    btn('mute').innerHTML = svg(video.muted || video.volume === 0 ? 'mute' : 'volume');
    volInput.value = video.muted ? 0 : video.volume;
  }

  function renderSub() {
    let html = '';
    if (activeTrack !== null && cues.length) {
      const t = curTime() - subDelay;
      const parts = [];
      for (const c of cues) {
        if (c.start > t) break;
        if (t <= c.end) parts.push(c.html);
      }
      html = parts.join('\n');
    }
    if (html !== lastHtml) {
      subSpan.innerHTML = html;
      lastHtml = html;
    }
  }

  // ---------- progress saving ----------

  function persist(force) {
    const now = Date.now();
    if (!force && now - lastSave < 5000) return;
    const d = duration();
    const t = curTime();
    if (!isFinite(d) || d <= 0 || t < 1) return;
    lastSave = now;
    saveProgress(file.path, { t, d, u: now, n: opts.title || file.name });
  }

  // ---------- loading / fallback ----------

  const srcFor = (m, start) => {
    const p = encodeURIComponent(file.path);
    return m === 'direct' ? `/stream?path=${p}` : `/transcode?path=${p}&mode=${m}&start=${Math.floor(start)}`;
  };

  function load(newMode, start, autoplay) {
    mode = newMode;
    offset = mode === 'direct' ? 0 : start;
    pendingSeek = mode === 'direct' ? start : 0;
    audioChecked = false;
    errBox.hidden = true;
    setLoading(true);
    video.src = srcFor(mode, start);
    if (autoplay) {
      const p = video.play();
      if (p && p.catch) p.catch(() => { setLoading(false); showUI(); });
    }
  }

  function fallback() {
    if (!caps.ffmpeg) return false;
    const order = ['direct', 'copy', 'h264'];
    const next = order[order.indexOf(mode) + 1];
    if (!next) return false;
    toast(next === 'copy' ? 'Switching to compatibility mode…' : 'Converting video for your browser (may take a moment)…', 3500);
    load(next, curTime(), true);
    return true;
  }

  function showError() {
    setLoading(false);
    errBox.hidden = false;
    errBox.innerHTML = `
      <strong>This video can't be played in your browser.</strong>
      <span class="muted">${caps.ffmpeg ? 'The server could not convert it either.' : 'Install ffmpeg on the server to enable automatic conversion, or download the file and play it locally.'}</span>
      ${opts.downloadUrl ? `<a class="btn" href="${opts.downloadUrl}" download>Download file</a>` : ''}`;
  }

  function seekTo(t) {
    const d = duration();
    if (isFinite(d)) t = clamp(t, 0, Math.max(0, d - 0.25));
    else t = Math.max(0, t);

    if (mode === 'direct') {
      video.currentTime = t;
      return;
    }
    const rel = t - offset;
    if (rel >= 0 && inBuffered(rel)) {
      video.currentTime = rel;
      return;
    }
    if (!isFinite(d)) return; // converted stream without known duration can't jump
    load(mode, t, true);
  }

  // ---------- subtitles ----------

  function setTrackList(list) {
    tracks = list;
    buildCcMenu();
    btn('cc').classList.toggle('dim', tracks.length === 0 && activeTrack === null);
  }

  async function selectTrack(id) {
    if (id === null) {
      activeTrack = null;
      cues = [];
      store.set('mh_sublang', 'off');
      renderSub();
    } else {
      const t = tracks.find((x) => x.id === id);
      if (!t) return;
      try {
        if (!t.cues) {
          toast('Loading subtitles…');
          const r = await fetch(t.url);
          if (!r.ok) throw new Error('http ' + r.status);
          t.cues = parseCues(decodeText(await r.arrayBuffer()));
        }
        if (!t.cues.length) throw new Error('empty');
        activeTrack = id;
        cues = t.cues;
        if (!t.local) store.set('mh_sublang', t.lang);
        toast(`Subtitles: ${t.label}`);
      } catch {
        toast('Could not load these subtitles');
        return;
      }
    }
    btn('cc').classList.toggle('active', activeTrack !== null);
    btn('cc').classList.toggle('dim', tracks.length === 0 && activeTrack === null);
    lastHtml = null;
    renderSub();
    buildCcMenu();
  }

  function autoSelectTrack() {
    if (activeTrack !== null) return;
    const pref = store.get('mh_sublang', 'off');
    if (pref === 'off') return;
    const match = tracks.find((t) => t.lang === pref);
    if (match) selectTrack(match.id);
  }

  function addEmbeddedTracks(p) {
    if (!p || !p.subtitles || !p.subtitles.length) return;
    const extra = p.subtitles.map((s) => {
      const lang = langName(s.lang) || `Track ${s.index + 1}`;
      return {
        id: `emb-${s.index}`,
        lang,
        label: `${lang}${s.title ? ' – ' + s.title : ''} (embedded)`,
        url: `/api/embedded-sub?path=${encodeURIComponent(file.path)}&i=${s.index}`,
      };
    });
    setTrackList([...tracks.filter((t) => !String(t.id).startsWith('emb-')), ...extra]);
    autoSelectTrack();
  }

  function buildCcMenu() {
    const m = menus.cc;
    m.innerHTML = '';
    const add = (label, selected, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (selected) b.classList.add('sel');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      m.appendChild(b);
    };
    add('Off', activeTrack === null, () => { selectTrack(null); closeMenus(); });
    for (const t of tracks) add(t.label, activeTrack === t.id, () => { selectTrack(t.id); closeMenus(); });
    if (!tracks.length) {
      const n = document.createElement('div');
      n.className = 'note';
      n.textContent = 'No subtitles found for this video.';
      m.appendChild(n);
    }
    m.appendChild(document.createElement('hr'));
    add('Load from file…', false, () => fileInput.click());

    if (activeTrack !== null) {
      const row = document.createElement('div');
      row.className = 'delay';
      row.innerHTML = `<span>Sync</span><div><button type="button" data-d="-0.5">−</button><output>${subDelay.toFixed(1)}s</output><button type="button" data-d="0.5">+</button></div>`;
      row.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          subDelay = Math.round((subDelay + Number(b.dataset.d)) * 10) / 10;
          row.querySelector('output').textContent = `${subDelay.toFixed(1)}s`;
          lastHtml = null;
          renderSub();
        })
      );
      m.appendChild(row);
    }
  }

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    const parsed = parseCues(decodeText(await f.arrayBuffer()));
    if (!parsed.length) return toast('That file has no readable subtitles');
    const t = { id: 'local-' + Date.now(), label: f.name, lang: 'Local file', local: true, cues: parsed };
    setTrackList([...tracks, t]);
    closeMenus();
    selectTrack(t.id);
  });

  function buildSpeedMenu() {
    const m = menus.speed;
    m.innerHTML = '';
    for (const s of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
      const b = document.createElement('button');
      b.textContent = s === 1 ? 'Normal' : `${s}x`;
      if (video.playbackRate === s) b.classList.add('sel');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        setSpeed(s);
        closeMenus();
      });
      m.appendChild(b);
    }
  }

  function setSpeed(s) {
    s = clamp(Math.round(s * 100) / 100, 0.25, 3);
    video.defaultPlaybackRate = s;
    video.playbackRate = s;
    store.set('mh_speed', s);
    btn('speed').textContent = `${s}x`;
  }

  function toggleMenu(name) {
    const m = menus[name];
    const willOpen = !m.classList.contains('open');
    closeMenus();
    if (willOpen) {
      if (name === 'cc') buildCcMenu();
      else buildSpeedMenu();
      m.classList.add('open');
    }
    showUI();
  }

  function closeMenus() {
    Object.values(menus).forEach((m) => m.classList.remove('open'));
  }

  // ---------- actions ----------

  function togglePlay() {
    if (video.paused || video.ended) {
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      video.pause();
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iOS Safari
  }

  function cancelNext() {
    clearInterval(nextTimer);
    nextBox.hidden = true;
  }

  function startNextCountdown() {
    if (!opts.next) return;
    let n = 8;
    nextBox.hidden = false;
    q('.cd').textContent = n;
    nextTimer = setInterval(() => {
      n--;
      q('.cd').textContent = n;
      if (n <= 0) {
        cancelNext();
        opts.onNext();
      }
    }, 1000);
  }

  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]');
    if (a) {
      const act = a.dataset.a;
      if (act === 'play') togglePlay();
      else if (act === 'mute') video.muted = !video.muted;
      else if (act === 'fs') toggleFullscreen();
      else if (act === 'cc') toggleMenu('cc');
      else if (act === 'speed') toggleMenu('speed');
      else if (act === 'next' || act === 'next-now') { cancelNext(); opts.onNext(); }
      else if (act === 'next-cancel') cancelNext();
      return;
    }
    if (e.target.closest('.menu-pop, .vol, .seek, .nextup, .errbox')) return;
    if (menuOpen()) { closeMenus(); return; }
    // single click = play/pause, double click = fullscreen
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      toggleFullscreen();
    } else {
      clickTimer = setTimeout(() => { clickTimer = null; togglePlay(); }, 220);
    }
  });

  volInput.addEventListener('input', () => {
    video.muted = false;
    video.volume = Number(volInput.value);
  });

  // seek bar (pointer events cover mouse + touch)
  const timeAt = (e) => {
    const r = seekEl.getBoundingClientRect();
    const f = clamp((e.clientX - r.left) / r.width, 0, 1);
    const d = duration();
    return { f, t: isFinite(d) ? f * d : 0 };
  };
  const moveTip = (e) => {
    const { f, t } = timeAt(e);
    tipEl.style.left = f * 100 + '%';
    tipEl.textContent = fmt(t);
    return t;
  };
  seekEl.addEventListener('pointermove', (e) => {
    const t = moveTip(e);
    if (scrubbing) { scrubTime = t; updateUI(); }
  });
  seekEl.addEventListener('pointerdown', (e) => {
    if (!isFinite(duration()) && mode !== 'direct') return;
    scrubbing = true;
    seekEl.classList.add('scrub');
    seekEl.setPointerCapture(e.pointerId);
    scrubTime = moveTip(e);
    updateUI();
  });
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    seekEl.classList.remove('scrub');
    seekTo(timeAt(e).t);
    showUI();
  };
  seekEl.addEventListener('pointerup', endScrub);
  seekEl.addEventListener('pointercancel', () => { scrubbing = false; seekEl.classList.remove('scrub'); });

  // show/hide controls
  el.addEventListener('pointermove', showUI);
  el.addEventListener('pointerdown', showUI);
  el.addEventListener('mouseleave', () => { if (!video.paused && !menuOpen()) el.classList.remove('show-ui'); });
  const onDocClick = (e) => {
    if (!e.target.closest || !e.target.closest('.ctl-wrap')) closeMenus();
  };
  document.addEventListener('click', onDocClick);
  const onFsChange = () => {
    btn('fs').innerHTML = svg(document.fullscreenElement === el ? 'fsExit' : 'fs');
    showUI();
  };
  document.addEventListener('fullscreenchange', onFsChange);

  // keyboard shortcuts (global while the watch page is open)
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' && e.target.type !== 'range') return;
    if (tag === 'textarea' || e.target.isContentEditable) return;
    const k = e.key;
    let handled = true;
    if (k === ' ' || k === 'k' || k === 'K') togglePlay();
    else if (k === 'ArrowLeft') seekTo(curTime() - 5);
    else if (k === 'ArrowRight') seekTo(curTime() + 5);
    else if (k === 'j' || k === 'J') seekTo(curTime() - 10);
    else if (k === 'l' || k === 'L') seekTo(curTime() + 10);
    else if (k === 'ArrowUp') { video.muted = false; video.volume = clamp(video.volume + 0.05, 0, 1); }
    else if (k === 'ArrowDown') video.volume = clamp(video.volume - 0.05, 0, 1);
    else if (k === 'm' || k === 'M') video.muted = !video.muted;
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else if (k === 'c' || k === 'C') {
      if (activeTrack !== null) selectTrack(null);
      else if (tracks.length) {
        const preferred = tracks.find((t) => t.lang === store.get('mh_sublang', ''));
        selectTrack((preferred || tracks[0]).id);
      } else toast('No subtitles available');
    }
    else if (k === '>' || k === '.') { setSpeed(video.playbackRate + 0.25); toast(`Speed ${video.playbackRate}x`); }
    else if (k === '<' || k === ',') { setSpeed(video.playbackRate - 0.25); toast(`Speed ${video.playbackRate}x`); }
    else if ((k === 'n' || k === 'N') && opts.next) { opts.onNext(); }
    else if (/^[0-9]$/.test(k)) { const d = duration(); if (isFinite(d)) seekTo((Number(k) / 10) * d); }
    else handled = false;
    if (handled) { e.preventDefault(); showUI(); }
  };
  document.addEventListener('keydown', onKey);

  // video events
  video.addEventListener('loadedmetadata', () => {
    if (pendingSeek > 0) {
      video.currentTime = pendingSeek;
      pendingSeek = 0;
    }
    updateUI();
  });
  video.addEventListener('timeupdate', () => { updateUI(); persist(false); });
  video.addEventListener('progress', updateUI);
  video.addEventListener('play', () => { updatePlayIcon(); showUI(); cancelNext(); });
  video.addEventListener('pause', () => { updatePlayIcon(); showUI(); persist(true); });
  video.addEventListener('waiting', () => setLoading(true));
  video.addEventListener('seeking', () => setLoading(true));
  video.addEventListener('canplay', () => setLoading(false));
  video.addEventListener('seeked', () => setLoading(false));
  video.addEventListener('playing', () => {
    setLoading(false);
    errBox.hidden = true;
    if (mode === 'direct' && !audioChecked) {
      audioChecked = true;
      // Chrome/Safari: a video that decodes zero audio bytes after a few seconds has an unsupported audio track.
      setTimeout(() => {
        if (destroyed || mode !== 'direct' || video.paused || video.currentTime < 2) return;
        const hasAudio = !probe || probe.audioCodec;
        if (hasAudio && typeof video.webkitAudioDecodedByteCount === 'number' && video.webkitAudioDecodedByteCount === 0) fallback();
      }, 3500);
    }
  });
  video.addEventListener('volumechange', () => {
    updateVolIcon();
    store.set('mh_volume', video.volume);
    store.set('mh_muted', video.muted);
  });
  video.addEventListener('ratechange', () => { btn('speed').textContent = `${video.playbackRate}x`; });
  video.addEventListener('ended', () => {
    const d = duration();
    if (isFinite(d)) saveProgress(file.path, { t: d, d, u: Date.now(), n: opts.title || file.name });
    updatePlayIcon();
    showUI();
    startNextCountdown();
  });
  video.addEventListener('error', () => {
    if (destroyed || !video.getAttribute('src')) return;
    if (!fallback()) showError();
  });

  const ticker = setInterval(() => { renderSub(); updateUI(); }, 120);

  // ---------- start ----------

  video.volume = clamp(Number(store.get('mh_volume', 1)), 0, 1);
  video.muted = !!store.get('mh_muted', false);
  setSpeed(Number(store.get('mh_speed', 1)) || 1);
  updatePlayIcon();
  updateVolIcon();
  setTrackList((opts.subtitles || []).map((s, i) => ({ id: `ext-${i}`, lang: s.lang, label: s.label, url: s.url })));
  autoSelectTrack();

  (async () => {
    setLoading(true);
    const probeP = (opts.probePromise || Promise.resolve(null)).catch(() => null);
    probeP.then((p) => {
      if (destroyed || !p) return;
      probe = p;
      addEmbeddedTracks(p);
    });
    if (caps.ffprobe) await Promise.race([probeP, sleep(5000)]);
    if (destroyed) return;

    // resume where the viewer stopped
    let start = 0;
    const saved = loadProgress()[file.path];
    if (saved && saved.t > 10 && saved.d && saved.t < saved.d - 20) {
      start = saved.t;
      toast(`Resuming from ${fmt(start)}`, 2800);
    }
    load(pickMode(file, probe, caps), start, true);
  })();

  el.focus({ preventScroll: true });

  return {
    destroy() {
      destroyed = true;
      persist(true);
      clearInterval(ticker);
      clearInterval(nextTimer);
      clearTimeout(hideTimer);
      clearTimeout(toastTimer);
      clearTimeout(clickTimer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('fullscreenchange', onFsChange);
      if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
      video.pause();
      video.removeAttribute('src');
      video.load(); // aborts the download / stops the server-side conversion
      root.innerHTML = '';
    },
  };
}
