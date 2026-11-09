// ফাইলের দৈর্ঘ্য/মাপ জানার হালকা ফাংশন (ব্রাউজারের নিজস্ব ডিকোডার দিয়ে)।

const AUDIO_EXT = ['mp3', 'aac', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'wma', 'amr'];
const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', '3gp', 'mpg', 'mpeg', 'ts'];
const extOf = (n) => { const m = /\.([a-z0-9]+)$/i.exec(n || ''); return m ? m[1].toLowerCase() : ''; };

export function fileKind(f) {
  if (f.type.startsWith('audio/')) return 'audio';
  if (f.type.startsWith('video/')) return 'video';
  const e = extOf(f.name);
  if (AUDIO_EXT.includes(e)) return 'audio';
  if (VIDEO_EXT.includes(e)) return 'video';
  return null;
}

const AUDIO_MIME = { aac: 'audio/aac', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac' };

function waitFor(node, ok, ms = 20000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { cleanup(); rej(new Error('timeout')); }, ms);
    const good = () => { cleanup(); res(); };
    const bad = () => { cleanup(); rej(new Error('media error')); };
    const cleanup = () => { clearTimeout(t); node.removeEventListener(ok, good); node.removeEventListener('error', bad); };
    node.addEventListener(ok, good); node.addEventListener('error', bad);
  });
}

export async function probeVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.preload = 'metadata'; v.muted = true; v.playsInline = true;
  try {
    v.src = url;
    await waitFor(v, 'loadedmetadata');
    let dur = v.duration;
    if (!isFinite(dur)) { v.currentTime = 1e7; await waitFor(v, 'timeupdate'); dur = v.duration; }
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h || !isFinite(dur) || dur <= 0) throw new Error('bad video');
    return { dur, w, h };
  } catch (_) {
    throw new Error('ভিডিও পড়া যায়নি (ফরম্যাট/কোডেক ব্রাউজার সমর্থন করে না?)');
  } finally {
    v.removeAttribute('src'); v.load();
    URL.revokeObjectURL(url);
  }
}

async function decodeDuration(file) {
  const C = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new C(1, 44100, 44100);
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  return buf.duration;
}

export async function probeAudio(file) {
  let blob = file;
  if (!file.type || !file.type.startsWith('audio/')) {
    const t = AUDIO_MIME[extOf(file.name)];
    if (t) blob = new Blob([file], { type: t });
  }
  const url = URL.createObjectURL(blob);
  const a = new Audio();
  a.preload = 'metadata';
  try {
    a.src = url;
    await waitFor(a, 'loadedmetadata');
    if (isFinite(a.duration) && a.duration > 0) return { dur: a.duration };
    throw new Error('no duration');
  } catch (_) {
    // raw .aac (ADTS) প্রায়ই duration দেয় না → ডিকোড করে মাপি
    try {
      const dur = await decodeDuration(file);
      if (dur > 0) return { dur };
    } catch (_) {}
    throw new Error('অডিও পড়া যায়নি');
  } finally {
    a.removeAttribute('src'); a.load();
    URL.revokeObjectURL(url);
  }
}
