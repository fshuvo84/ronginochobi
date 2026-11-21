'use strict';

const express = require('express');
const path = require('path');
const { Readable } = require('stream');

const config = require('./config');
const L = require('./listing');
const ff = require('./ffmpeg');
const { Indexer } = require('./indexer');
const { findSubtitles, decodeText } = require('./subtitles');

const app = express();
app.disable('x-powered-by');

const indexer = new Indexer();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Browsers only trust the Content-Type when picking a demuxer. Chrome/Edge play
// H.264/AAC (and VP9/Opus) mkv files fine when they are labelled "video/webm".
const MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/webm',
  ogv: 'video/ogg',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  '3gp': 'video/3gpp',
};

// ---------------------------------------------------------------- API

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/config', (req, res) => {
  res.json({ siteName: config.SITE_NAME, ffmpeg: ff.caps.ffmpeg, ffprobe: ff.caps.ffprobe });
});

// Top level folders = the navigation menu.
app.get(
  '/api/menu',
  wrap(async (req, res) => {
    const { folders } = await L.listDir('/');
    res.json({ folders });
  })
);

app.get(
  '/api/browse',
  wrap(async (req, res) => {
    const rel = L.toDirPath(L.sanitizePath(req.query.path || '/'));
    const { folders, files } = await L.listDir(rel, { fresh: req.query.fresh === '1' });
    res.json({
      path: rel,
      name: rel === '/' ? 'Home' : L.baseName(rel),
      crumbs: L.crumbs(rel),
      folders,
      videos: files.filter((f) => L.isVideo(f.name)),
    });
  })
);

app.get('/api/search', (req, res) => {
  res.json({ ...indexer.search(String(req.query.q || '')), index: indexer.status() });
});

app.get('/api/index/status', (req, res) => res.json(indexer.status()));

app.post('/api/index/refresh', (req, res) => {
  indexer.refresh();
  res.json(indexer.status());
});

// Everything the watch page needs: siblings (next episode), external subtitles.
app.get(
  '/api/info',
  wrap(async (req, res) => {
    const rel = L.sanitizePath(req.query.path);
    if (rel.endsWith('/') || !L.isVideo(rel)) throw L.httpError(400, 'Not a video file');

    const dir = L.parentOf(rel);
    const { files } = await L.listDir(dir);
    const subtitles = await findSubtitles(rel).catch(() => []);

    res.json({
      name: L.baseName(rel),
      path: rel,
      dir,
      crumbs: L.crumbs(dir),
      siblings: files.filter((f) => L.isVideo(f.name)),
      subtitles,
      downloadUrl: config.UPSTREAM_USER
        ? `/stream?path=${encodeURIComponent(rel)}&download=1`
        : L.toUpstreamUrl(rel),
    });
  })
);

// Codec / duration / embedded subtitle info (needs ffprobe).
app.get(
  '/api/probe',
  wrap(async (req, res) => {
    if (!ff.caps.ffprobe) throw L.httpError(501, 'ffprobe is not installed on the server');
    res.json(await ff.probe(L.sanitizePath(req.query.path)));
  })
);

app.get(
  '/api/subtitle',
  wrap(async (req, res) => {
    const rel = L.sanitizePath(req.query.path);
    if (!L.isSub(rel)) throw L.httpError(400, 'Not a subtitle file');
    const up = await fetch(L.toUpstreamUrl(rel), {
      headers: L.authHeaders(),
      signal: AbortSignal.timeout(20000),
    });
    if (!up.ok) throw L.httpError(up.status === 404 ? 404 : 502, 'Subtitle not available');
    const buf = Buffer.from(await up.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw L.httpError(413, 'Subtitle file too large');
    res.type('text/plain; charset=utf-8').send(decodeText(buf));
  })
);

app.get(
  '/api/embedded-sub',
  wrap(async (req, res) => {
    if (!ff.caps.ffmpeg) throw L.httpError(501, 'ffmpeg is not installed on the server');
    const rel = L.sanitizePath(req.query.path);
    const index = parseInt(req.query.i, 10);
    if (!(index >= 0 && index < 64)) throw L.httpError(400, 'Bad subtitle index');
    res.sendFile(await ff.extractSubtitle(rel, index));
  })
);

// ---------------------------------------------------------------- video streaming

// Transparent proxy with HTTP Range support, so seeking works.
app.get('/stream', async (req, res, next) => {
  let rel;
  try {
    rel = L.sanitizePath(req.query.path);
    if (rel.endsWith('/')) throw L.httpError(400, 'Not a file');
  } catch (e) {
    return next(e);
  }

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  const headers = { ...L.authHeaders(), 'Accept-Encoding': 'identity' };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];

  let up;
  try {
    up = await fetch(L.toUpstreamUrl(rel), { headers, signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return;
    return next(L.httpError(502, 'Cannot reach the file server'));
  }
  if (up.status === 404) return next(L.httpError(404, 'File not found'));
  if (up.status >= 400 && up.status !== 416) return next(L.httpError(502, `File server answered ${up.status}`));

  res.status(up.status);
  for (const h of ['content-length', 'content-range', 'last-modified', 'etag']) {
    const v = up.headers.get(h);
    if (v) res.set(h, v);
  }
  res.set('Accept-Ranges', 'bytes');
  res.set('Content-Type', MIME[L.extOf(rel)] || up.headers.get('content-type') || 'application/octet-stream');
  if (req.query.download === '1') {
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(L.baseName(rel))}`);
  }

  if (req.method === 'HEAD' || !up.body) {
    ac.abort();
    return res.end();
  }
  const body = Readable.fromWeb(up.body);
  body.on('error', () => res.destroy());
  body.pipe(res);
});

// On-the-fly conversion (fragmented MP4 piped straight to the browser).
app.get('/transcode', (req, res, next) => {
  try {
    if (!ff.caps.ffmpeg) throw L.httpError(501, 'ffmpeg is not installed on the server');
    const rel = L.sanitizePath(req.query.path);
    if (rel.endsWith('/') || !L.isVideo(rel)) throw L.httpError(400, 'Not a video file');
    const start = Math.max(0, Number(req.query.start) || 0);
    const mode = req.query.mode === 'h264' ? 'h264' : 'copy';

    const child = ff.spawnTranscode(rel, start, mode);
    res.status(200).set({ 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    child.stdout.pipe(res);
    child.stderr.on('data', (d) => {
      if (process.env.DEBUG_FFMPEG) process.stderr.write(d);
    });
    child.on('error', () => res.destroy());
    res.on('close', () => child.kill('SIGKILL'));
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------- static site + errors

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(`[${req.method} ${req.path}]`, err.message);
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: err.message || 'Server error' });
});

// ---------------------------------------------------------------- start

(async () => {
  await ff.detect();
  await indexer.init();
  app.listen(config.PORT, config.HOST, () => {
    console.log(`\n  ${config.SITE_NAME} is running:  http://localhost:${config.PORT}`);
    console.log(`  File server:  ${config.BASE_URL}`);
    console.log(
      `  ffmpeg: ${ff.caps.ffmpeg ? 'yes' : 'no'}, ffprobe: ${ff.caps.ffprobe ? 'yes' : 'no'}` +
        (ff.caps.ffmpeg ? '' : '  (optional: install ffmpeg for wider format support)') +
        '\n'
    );
  });
})();
