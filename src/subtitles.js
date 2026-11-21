'use strict';

/** Finds external subtitle files (.srt / .vtt) that belong to a video. */

const { listDir, isSub, isVideo, stripExt, baseName, parentOf } = require('./listing');

let displayNames = null;
try {
  displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
} catch {
  /* very old ICU build: fall back to raw tags */
}

const FLAGS = new Set(['sdh', 'cc', 'forced', 'hi']);

function labelFor(suffix, n) {
  const tokens = suffix.split(/[._\-\s[\]()]+/).filter(Boolean);
  let lang = null;
  const extras = [];
  const rest = [];
  for (const t of tokens) {
    const low = t.toLowerCase();
    if (FLAGS.has(low)) {
      extras.push(low.toUpperCase());
      continue;
    }
    if (!lang && displayNames && /^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(t)) {
      try {
        const name = displayNames.of(t);
        if (name && name.toLowerCase() !== low) {
          lang = name;
          continue;
        }
      } catch {
        /* not a language code */
      }
    }
    rest.push(t);
  }
  const main = lang || rest.join(' ') || `Subtitle ${n}`;
  return { lang: lang || main, label: extras.length ? `${main} (${extras.join(', ')})` : main };
}

async function findSubtitles(videoPath) {
  const dir = parentOf(videoPath);
  const base = stripExt(baseName(videoPath)).toLowerCase();
  const { folders, files } = await listDir(dir);

  const candidates = new Map(); // path -> suffix
  const take = (list, fuzzy) => {
    for (const f of list) {
      if (!isSub(f.name)) continue;
      const noExt = stripExt(f.name);
      if (noExt.toLowerCase().startsWith(base)) candidates.set(f.path, noExt.slice(base.length));
      else if (fuzzy) candidates.set(f.path, noExt);
    }
  };

  take(files, false);

  for (const folder of folders) {
    const name = folder.name.toLowerCase();
    try {
      if (/^(subs?|subtitles?)$/.test(name)) {
        const inner = await listDir(folder.path);
        take(inner.files, false);
        for (const sub of inner.folders) {
          if (sub.name.toLowerCase() === base) take((await listDir(sub.path)).files, true);
        }
      } else if (name === base) {
        take((await listDir(folder.path)).files, true);
      }
    } catch {
      /* unreadable folder: ignore */
    }
  }

  // Folder with a single video: any subtitle file in it belongs to that video.
  if (!candidates.size && files.filter((f) => isVideo(f.name)).length === 1) take(files, true);

  const used = new Map();
  const out = [];
  let n = 0;
  for (const [p, suffix] of candidates) {
    n++;
    const { lang, label } = labelFor(suffix, n);
    const count = (used.get(label) || 0) + 1;
    used.set(label, count);
    out.push({
      lang,
      label: count > 1 ? `${label} ${count}` : label,
      url: `/api/subtitle?path=${encodeURIComponent(p)}`,
    });
  }
  return out;
}

/** Subtitle files come in all kinds of encodings; return clean UTF-8 text. */
function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

module.exports = { findSubtitles, decodeText };
