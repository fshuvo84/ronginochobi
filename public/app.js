import { createPlayer, loadProgress } from './player.js';

const app = document.getElementById('app');
const menuEl = document.getElementById('menu');
const qInput = document.getElementById('q');
const searchForm = document.getElementById('searchForm');

let caps = { siteName: 'MediaHub', ffmpeg: false, ffprobe: false };
let player = null;
let pollTimer = null;
let seq = 0;

// ---------- small helpers ----------

const ICONS = {
  folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  film: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
};
const icon = (n) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[n]}"/></svg>`;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const qs = (o) => new URLSearchParams(o).toString();
const browseHref = (p) => `#/browse?${qs({ p })}`;
const watchHref = (p) => `#/watch?${qs({ p })}`;

function pretty(name, isFile) {
  let n = isFile ? name.replace(/\.[^.]+$/, '') : name;
  if (!/\s/.test(n)) n = n.replace(/[._]+/g, ' ').trim();
  return n;
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

async function api(url, options) {
  const r = await fetch(url, options);
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* not json */
  }
  if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status})`);
  return data;
}

const notice = (msg, kind = '') => `<div class="notice ${kind}">${esc(msg)}</div>`;

function crumbsHtml(crumbs, lastIsLink = false) {
  return `<nav class="crumbs">${crumbs
    .map((c, i) => {
      const last = i === crumbs.length - 1 && !lastIsLink;
      const part = last ? `<span>${esc(c.name)}</span>` : `<a href="${browseHref(c.path)}">${esc(c.name)}</a>`;
      return (i ? '<span class="sep">›</span>' : '') + part;
    })
    .join('')}</nav>`;
}

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const i = h.indexOf('?');
  return { route: i < 0 ? h : h.slice(0, i), params: new URLSearchParams(i < 0 ? '' : h.slice(i + 1)) };
}

function destroyPlayer() {
  if (player) {
    player.destroy();
    player = null;
  }
}

// ---------- cards ----------

function folderCard(f) {
  return `<a class="card folder" href="${browseHref(f.path)}">${icon('folder')}<div class="title">${esc(pretty(f.name))}</div></a>`;
}

function videoCard(v, progress) {
  const p = progress[v.path];
  const pct = p && p.d ? Math.min(100, (p.t / p.d) * 100) : 0;
  return `<a class="card video" href="${watchHref(v.path)}">${icon('film')}<div class="title">${esc(pretty(v.name, true))}</div>${
    pct > 1 ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''
  }</a>`;
}

// ---------- views ----------

async function viewHome(my) {
  app.innerHTML = '<p class="muted">Loading…</p>';
  const data = await api('/api/browse?' + qs({ path: '/' }));
  if (my !== seq) return;

  const progress = loadProgress();
  const resume = Object.entries(progress)
    .filter(([, p]) => p.d && p.t > 10 && p.t < p.d - 20)
    .sort((a, b) => b[1].u - a[1].u)
    .slice(0, 8);

  let html = '';
  if (resume.length) {
    html += `<h2>Continue watching</h2><div class="grid">${resume
      .map(
        ([path, p]) =>
          `<a class="card video" href="${watchHref(path)}">${icon('film')}<div class="title">${esc(p.n)}</div><div class="sub">Resume at ${fmtTime(p.t)}</div><div class="bar"><i style="width:${Math.min(100, (p.t / p.d) * 100).toFixed(1)}%"></i></div></a>`
      )
      .join('')}</div>`;
  }
  html += '<h2>Library</h2>';
  html += data.folders.length || data.videos.length
    ? `<div class="grid">${data.folders.map(folderCard).join('')}${data.videos.map((v) => videoCard(v, progress)).join('')}</div>`
    : notice('The file server returned an empty list.');
  html += `<p class="footer-note">Search index: <span id="idxStatus">…</span> · <button class="linkbtn" id="rescan">Rescan library</button></p>`;
  app.innerHTML = html;

  document.getElementById('rescan').addEventListener('click', async () => {
    await api('/api/index/refresh', { method: 'POST' });
    refreshIndexStatus();
  });
  refreshIndexStatus();
}

async function refreshIndexStatus() {
  const el = document.getElementById('idxStatus');
  if (!el) return;
  try {
    const s = await api('/api/index/status');
    el.textContent = s.running
      ? `scanning… ${s.scanned} folders so far`
      : `${s.count.toLocaleString()} items indexed`;
    if (s.running) pollTimer = setTimeout(refreshIndexStatus, 2000);
  } catch {
    el.textContent = 'unavailable';
  }
}

async function viewBrowse(path, my) {
  app.innerHTML = '<p class="muted">Loading…</p>';
  const data = await api('/api/browse?' + qs({ path }));
  if (my !== seq) return;
  document.title = `${pretty(data.name)} – ${caps.siteName}`;

  const progress = loadProgress();
  const empty = !data.folders.length && !data.videos.length;
  app.innerHTML = `
    ${crumbsHtml(data.crumbs)}
    <h1>${esc(pretty(data.name))}</h1>
    <p class="muted">${data.folders.length} folder${data.folders.length === 1 ? '' : 's'} · ${data.videos.length} video${data.videos.length === 1 ? '' : 's'}</p>
    ${empty ? notice('This folder is empty.') : `<div class="grid">${data.folders.map(folderCard).join('')}${data.videos.map((v) => videoCard(v, progress)).join('')}</div>`}`;
}

async function viewSearch(q, my) {
  if (document.activeElement !== qInput) qInput.value = q;
  if (!q.trim()) {
    app.innerHTML = notice('Type something in the search bar to find movies and series.');
    return;
  }
  const data = await api('/api/search?' + qs({ q }));
  if (my !== seq) return;
  document.title = `${q} – ${caps.siteName}`;

  const rows = data.results
    .map((r) => {
      const where = r.parent.split('/').filter(Boolean).join(' › ') || 'Home';
      const isDir = r.type === 'dir';
      return `<a class="item ${isDir ? 'folder' : 'video'}" href="${isDir ? browseHref(r.path) : watchHref(r.path)}">
        ${icon(isDir ? 'folder' : 'film')}
        <div class="txt"><div class="t">${esc(pretty(r.name, !isDir))}</div><div class="s">${esc(where)}</div></div>
        <span class="badge">${isDir ? 'Folder' : 'Video'}</span></a>`;
    })
    .join('');

  let status = '';
  if (data.index.running) {
    status = notice(`The library is still being indexed (${data.index.scanned} folders scanned) — results may be incomplete.`);
    pollTimer = setTimeout(() => {
      if (my === seq) render();
    }, 2500);
  } else if (data.index.error && !data.index.count) {
    status = notice(`Could not index the library: ${data.index.error}`, 'error');
  }

  app.innerHTML = `
    <h1>Results for “${esc(q)}”</h1>
    <p class="muted">${data.total} match${data.total === 1 ? '' : 'es'}${data.total > data.results.length ? ` (showing first ${data.results.length})` : ''}</p>
    ${status}
    ${rows ? `<div class="items">${rows}</div>` : data.index.running ? '' : notice('Nothing found. Try fewer or different words.')}`;
}

async function viewWatch(path, my) {
  if (!path) throw new Error('No video selected');
  app.innerHTML = '<p class="muted">Loading…</p>';
  const info = await api('/api/info?' + qs({ path }));
  if (my !== seq) return;

  const title = pretty(info.name, true);
  document.title = `${title} – ${caps.siteName}`;

  const idx = info.siblings.findIndex((s) => s.path === info.path);
  const prev = idx > 0 ? info.siblings[idx - 1] : null;
  const next = idx >= 0 && idx < info.siblings.length - 1 ? info.siblings[idx + 1] : null;
  const progress = loadProgress();
  const folderName = info.crumbs[info.crumbs.length - 1].name;

  const side = info.siblings.length > 1
    ? `<aside class="side"><h3>${esc(pretty(folderName))}</h3>${info.siblings
        .map((s) => {
          const p = progress[s.path];
          const pct = p && p.d ? Math.min(100, (p.t / p.d) * 100) : 0;
          return `<a href="${watchHref(s.path)}" class="${s.path === info.path ? 'current' : ''}">${esc(pretty(s.name, true))}${
            pct > 1 ? `<div class="pbar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''
          }</a>`;
        })
        .join('')}</aside>`
    : '';

  app.innerHTML = `
    <div class="watch ${side ? '' : 'single'}">
      <section>
        <div id="playerRoot"></div>
        <div class="meta">
          ${crumbsHtml(info.crumbs, true)}
          <h1>${esc(title)}</h1>
          <div class="actions">
            <a class="btn ${prev ? '' : 'disabled'}" ${prev ? `href="${watchHref(prev.path)}"` : ''}>⏮ Previous</a>
            <a class="btn ${next ? '' : 'disabled'}" ${next ? `href="${watchHref(next.path)}"` : ''}>Next ⏭</a>
            <a class="btn" href="${esc(info.downloadUrl)}" download>⬇ Download</a>
          </div>
        </div>
      </section>
      ${side}
    </div>`;

  const cur = app.querySelector('.side a.current');
  if (cur) cur.scrollIntoView({ block: 'center' });

  player = createPlayer(document.getElementById('playerRoot'), {
    caps,
    file: { name: info.name, path: info.path },
    title,
    subtitles: info.subtitles,
    probePromise: caps.ffprobe ? api('/api/probe?' + qs({ path: info.path })) : Promise.resolve(null),
    downloadUrl: info.downloadUrl,
    next: next ? { title: pretty(next.name, true) } : null,
    onNext: () => {
      if (next) location.hash = watchHref(next.path);
    },
  });
}

// ---------- router ----------

function highlightMenu(path) {
  const top = path && path !== '/' ? '/' + path.split('/').filter(Boolean)[0] + '/' : null;
  menuEl.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.path === top));
}

async function render() {
  const my = ++seq;
  clearTimeout(pollTimer);
  destroyPlayer();
  const { route, params } = parseHash();
  document.title = caps.siteName;

  let menuPath = null;
  try {
    if (route === '/browse') {
      menuPath = params.get('p') || '/';
      await viewBrowse(menuPath, my);
    } else if (route === '/watch') {
      menuPath = params.get('p') || '/';
      await viewWatch(params.get('p'), my);
    } else if (route === '/search') {
      await viewSearch(params.get('q') || '', my);
    } else {
      await viewHome(my);
    }
  } catch (e) {
    if (my === seq) app.innerHTML = notice(e.message, 'error');
  }
  highlightMenu(menuPath);
  if (route !== '/search') window.scrollTo(0, 0);
}

// ---------- search box ----------

let searchTimer = null;
function goSearch(q) {
  q = q.trim();
  const onSearch = parseHash().route === '/search';
  if (!q) {
    if (onSearch) location.hash = '#/';
    return;
  }
  const target = '#/search?' + qs({ q });
  if (onSearch) location.replace(target);
  else location.hash = target;
}

qInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => goSearch(qInput.value), 300);
});
searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  goSearch(qInput.value);
  qInput.blur();
});
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (e.key === '/' && tag !== 'input' && tag !== 'textarea') {
    e.preventDefault();
    qInput.focus();
    qInput.select();
  }
});

// ---------- init ----------

async function loadMenu() {
  try {
    const { folders } = await api('/api/menu');
    menuEl.innerHTML = folders
      .map((f) => `<a href="${browseHref(f.path)}" data-path="${esc(f.path)}">${esc(pretty(f.name))}</a>`)
      .join('');
    const { route, params } = parseHash();
    highlightMenu(route === '/browse' || route === '/watch' ? params.get('p') || '/' : null);
  } catch {
    /* the main view shows the error */
  }
}

(async function init() {
  try {
    caps = await api('/api/config');
  } catch {
    /* defaults */
  }
  document.getElementById('siteName').textContent = caps.siteName;
  document.title = caps.siteName;
  window.addEventListener('hashchange', render);
  loadMenu();
  render();
})();
