'use strict';

/**
 * Talks to the upstream file server: builds URLs safely, reads its
 * auto-generated directory listings (Apache / nginx / lighttpd / caddy /
 * python http.server ... anything that renders <a href> links) and offers a
 * few path helpers.
 */

const config = require('./config');

const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', '3gp', 'ogv',
]);
const SUB_EXT = new Set(['srt', 'vtt']);
const IGNORED_NAMES = /^(lost\+found|@eadir|\$recycle\.bin|system volume information|\.[^/]*)$/i;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------- path helpers ----------

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}
const isVideo = (name) => VIDEO_EXT.has(extOf(name));
const isSub = (name) => SUB_EXT.has(extOf(name));

function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function baseName(p) {
  const t = p.replace(/\/+$/, '');
  return t.slice(t.lastIndexOf('/') + 1);
}

function parentOf(p) {
  const t = p.endsWith('/') ? p.slice(0, -1) : p;
  return t.slice(0, t.lastIndexOf('/') + 1) || '/';
}

const toDirPath = (p) => (p.endsWith('/') ? p : p + '/');

function crumbs(dir) {
  const out = [{ name: 'Home', path: '/' }];
  let acc = '/';
  for (const seg of dir.split('/').filter(Boolean)) {
    acc += seg + '/';
    out.push({ name: seg, path: acc });
  }
  return out;
}

/** Validates a client-supplied path. Always returns a normalised "/a/b/c" path. */
function sanitizePath(input) {
  if (typeof input !== 'string' || !input) throw httpError(400, 'Missing path');
  if (input.includes('\0') || input.includes('\\')) throw httpError(400, 'Invalid path');
  let p = input.startsWith('/') ? input : '/' + input;
  p = p.replace(/\/{2,}/g, '/');
  if (p.split('/').some((s) => s === '.' || s === '..')) throw httpError(400, 'Invalid path');
  return p;
}

// ---------- upstream URLs ----------

function toUpstreamUrl(relPath) {
  const encoded = relPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
    .replace(/^\//, '');
  return new URL(encoded, config.BASE_URL).toString();
}

/** URL for ffmpeg/ffprobe (credentials embedded because they take no auth header option for probe). */
function toToolUrl(relPath) {
  const u = new URL(toUpstreamUrl(relPath));
  if (config.UPSTREAM_USER) {
    u.username = config.UPSTREAM_USER;
    u.password = config.UPSTREAM_PASS;
  }
  return u.toString();
}

function authHeaders() {
  if (!config.UPSTREAM_USER) return {};
  const token = Buffer.from(`${config.UPSTREAM_USER}:${config.UPSTREAM_PASS}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

// ---------- directory listing ----------

const decodeSeg = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const naturalSort = (a, b) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

async function fetchDirectory(relPath) {
  const dirPath = toDirPath(relPath);
  const url = toUpstreamUrl(dirPath);

  let res;
  try {
    res = await fetch(url, {
      headers: { ...authHeaders(), Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    const code = (e.cause && e.cause.code) || e.name || 'error';
    throw httpError(502, `Cannot reach the file server (${code})`);
  }
  if (res.status === 404) throw httpError(404, 'Folder not found');
  if (!res.ok) throw httpError(502, `File server answered with HTTP ${res.status}`);

  const html = await res.text();
  const dirUrl = new URL(url);
  const folders = new Map();
  const files = new Map();

  const anchorRe = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!href || /^(\?|#|javascript:|mailto:)/i.test(href)) continue; // sort links, anchors

    let u;
    try {
      u = new URL(href, dirUrl);
    } catch {
      continue;
    }
    if (u.origin !== dirUrl.origin) continue; // external link
    if (!u.pathname.startsWith(dirUrl.pathname) || u.pathname === dirUrl.pathname) continue; // parent / self

    const rest = u.pathname.slice(dirUrl.pathname.length); // "Name/" or "file.mkv"
    const isDir = rest.endsWith('/');
    const segments = rest.split('/').filter(Boolean);
    if (segments.length !== 1) continue; // only direct children
    const name = decodeSeg(segments[0]);
    if (IGNORED_NAMES.test(name)) continue;

    const childPath = dirPath + name + (isDir ? '/' : '');
    (isDir ? folders : files).set(childPath, { name, path: childPath });
  }

  return {
    folders: [...folders.values()].sort(naturalSort),
    files: [...files.values()].sort(naturalSort),
  };
}

const cache = new Map();

async function listDir(relPath, { fresh = false } = {}) {
  const key = toDirPath(relPath);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < config.LISTING_CACHE_SECONDS * 1000) return hit.value;
  const value = await fetchDirectory(key);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return value;
}

module.exports = {
  httpError,
  extOf,
  isVideo,
  isSub,
  stripExt,
  baseName,
  parentOf,
  toDirPath,
  crumbs,
  sanitizePath,
  toUpstreamUrl,
  toToolUrl,
  authHeaders,
  listDir,
};
