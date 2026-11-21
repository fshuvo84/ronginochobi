'use strict';

/**
 * Crawls the whole library in the background and keeps an in-memory index so
 * the search bar answers instantly. The index is cached on disk so a restart
 * does not need a full re-crawl.
 */

const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const { listDir, isVideo, parentOf } = require('./listing');

function normalize(s) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[._\-+()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class Indexer {
  constructor() {
    this.items = [];
    this.cacheFile = path.join(config.DATA_DIR, 'index.json');
    this.state = {
      running: false,
      scanned: 0,
      errors: 0,
      count: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
    };
  }

  status() {
    return { ...this.state, count: this.items.length };
  }

  _build(raw) {
    return raw.map((r) => {
      const nameKey = normalize(r.n);
      return { name: r.n, path: r.p, type: r.t === 'd' ? 'dir' : 'video', nameKey, key: `${nameKey} ${normalize(parentOf(r.p))}` };
    });
  }

  async init() {
    let stale = true;
    try {
      const saved = JSON.parse(await fsp.readFile(this.cacheFile, 'utf8'));
      if (Array.isArray(saved.items)) {
        this.items = this._build(saved.items);
        this.state.finishedAt = saved.savedAt || null;
        stale = !saved.savedAt || Date.now() - saved.savedAt > config.INDEX_REFRESH_MINUTES * 60000;
      }
    } catch {
      /* no cache yet */
    }
    if (stale) this.refresh();
    const timer = setInterval(() => this.refresh(), config.INDEX_REFRESH_MINUTES * 60000);
    timer.unref();
  }

  async refresh() {
    if (this.state.running) return;
    Object.assign(this.state, { running: true, scanned: 0, errors: 0, startedAt: Date.now(), error: null });

    const raw = [];
    const queue = [{ path: '/', depth: 0 }];
    let active = 0;

    await new Promise((resolve) => {
      const pump = () => {
        while (active < config.INDEX_CONCURRENCY && queue.length) {
          const job = queue.shift();
          active++;
          listDir(job.path, { fresh: true })
            .then(({ folders, files }) => {
              for (const f of folders) {
                raw.push({ n: f.name, p: f.path, t: 'd' });
                if (job.depth + 1 < config.INDEX_DEPTH) queue.push({ path: f.path, depth: job.depth + 1 });
              }
              for (const f of files) if (isVideo(f.name)) raw.push({ n: f.name, p: f.path, t: 'v' });
              this.state.scanned++;
            })
            .catch((e) => {
              this.state.errors++;
              if (job.path === '/') this.state.error = e.message;
            })
            .finally(() => {
              active--;
              pump();
            });
        }
        if (!active && !queue.length) resolve();
      };
      pump();
    });

    // Don't throw away a good index if the file server was unreachable.
    if (raw.length || !this.items.length) {
      this.items = this._build(raw);
      try {
        await fsp.mkdir(config.DATA_DIR, { recursive: true });
        await fsp.writeFile(this.cacheFile, JSON.stringify({ savedAt: Date.now(), items: raw }));
      } catch (e) {
        console.warn('Could not write search index cache:', e.message);
      }
    }
    Object.assign(this.state, { running: false, finishedAt: Date.now() });
    console.log(`[index] ${this.items.length} items, ${this.state.scanned} folders scanned, ${this.state.errors} errors`);
  }

  search(query, limit = 200) {
    const q = normalize(query || '');
    if (!q) return { results: [], total: 0 };
    const tokens = q.split(' ');
    const scored = [];

    for (const it of this.items) {
      if (!tokens.every((t) => it.key.includes(t))) continue;
      let score = 0;
      if (it.nameKey.includes(q)) score += 50;
      if (it.nameKey.startsWith(q)) score += 20;
      for (const t of tokens) {
        if (it.nameKey.includes(t)) score += 5;
        if ((' ' + it.nameKey).includes(' ' + t)) score += 3;
      }
      if (it.type === 'dir') score += 2;
      score -= it.nameKey.length / 100;
      scored.push({ it, score });
    }

    scored.sort((a, b) => b.score - a.score || a.it.name.localeCompare(b.it.name, undefined, { numeric: true }));
    return {
      total: scored.length,
      results: scored.slice(0, limit).map(({ it }) => ({
        name: it.name,
        path: it.path,
        type: it.type,
        parent: parentOf(it.path),
      })),
    };
  }
}

module.exports = { Indexer };
