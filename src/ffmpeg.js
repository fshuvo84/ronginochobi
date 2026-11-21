'use strict';

/**
 * Optional ffmpeg support. Without ffmpeg the site still streams every file
 * the browser can play natively (mp4/h264, webm, most mkv). With ffmpeg it can
 * also convert on the fly (e.g. mkv with AC3/DTS audio, HEVC, avi) and read
 * subtitles embedded inside mkv/mp4 files.
 */

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { toToolUrl } = require('./listing');

const caps = { ffmpeg: false, ffprobe: false };

function check(bin) {
  return new Promise((resolve) => execFile(bin, ['-version'], { timeout: 5000 }, (err) => resolve(!err)));
}

async function detect() {
  [caps.ffmpeg, caps.ffprobe] = await Promise.all([check('ffmpeg'), check('ffprobe')]);
}

function run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        // never include args in the message: they contain credentials
        const e = new Error(`${bin} failed (${err.code || err.signal || 'error'})`);
        e.status = 502;
        return reject(e);
      }
      resolve(stdout);
    });
  });
}

// ---------- probe ----------

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const probeCache = new Map();

async function probe(rel) {
  if (probeCache.has(rel)) return probeCache.get(rel);

  const out = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', toToolUrl(rel)],
    30000
  );
  const json = JSON.parse(out);
  const streams = json.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.find((s) => s.codec_type === 'audio');

  const subtitles = [];
  let ordinal = -1;
  for (const s of streams) {
    if (s.codec_type !== 'subtitle') continue;
    ordinal++;
    if (!TEXT_SUB_CODECS.has(s.codec_name)) continue; // bitmap subtitles can't be converted
    const tags = s.tags || {};
    subtitles.push({ index: ordinal, lang: tags.language || null, title: tags.title || null });
  }

  const result = {
    duration: parseFloat(json.format && json.format.duration) || null,
    videoCodec: video ? video.codec_name : null,
    audioCodec: audio ? audio.codec_name : null,
    subtitles,
  };
  probeCache.set(rel, result);
  if (probeCache.size > 500) probeCache.delete(probeCache.keys().next().value);
  return result;
}

// ---------- on-the-fly conversion ----------

/**
 * mode "copy": keep the video stream, convert audio to AAC (fast, tiny CPU use).
 * mode "h264": re-encode video as H.264 (slow, works for any source).
 */
function spawnTranscode(rel, start, mode) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', toToolUrl(rel), '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

  if (mode === 'h264') {
    args.push(
      '-vf', 'scale=-2:min(1080\\,ih)',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'
    );
  } else {
    args.push('-c:v', 'copy');
  }
  args.push(
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-max_muxing_queue_size', '1024',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1'
  );
  return spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------- embedded subtitle extraction ----------

const inflight = new Map();

function extractSubtitle(rel, index) {
  const key = crypto.createHash('sha1').update(`${rel}\0${index}`).digest('hex');
  const dir = path.join(config.DATA_DIR, 'subs');
  const file = path.join(dir, `${key}.vtt`);
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.part`;
    await run(
      'ffmpeg',
      ['-v', 'error', '-y', '-i', toToolUrl(rel), '-map', `0:s:${index}`, '-f', 'webvtt', tmp],
      10 * 60 * 1000
    );
    await fsp.rename(tmp, file);
    return file;
  })().finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

module.exports = { caps, detect, probe, spawnTranscode, extractSubtitle };
