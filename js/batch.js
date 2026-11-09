// ব্যাচ মোড: অনেক (অডিও + ভিডিও) জোড়া কিউতে রেখে প্যারালালে অটো এডিট ও অটো ডাউনলোড।

import { buildAuto, fmtTime, clamp } from './model.js';
import { renderProject, abortExport, preloadFFmpeg } from './export.js';
import { probeVideo, probeAudio, fileKind } from './probe.js';
import { loadSettings, saveSettings, loadLogoFile, saveLogoFile, clearLogoFile, requestPersist } from './settings.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');
const baseName = (n) => (n || 'video').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim().slice(0, 60) || 'video';
const natural = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

const cfg = loadSettings();
const items = [];
let uid = 1;
let logo = { file: null, img: null, url: null };

function toast(msg, isErr = false, ms = 4200) {
  const d = document.createElement('div');
  d.className = 'toast' + (isErr ? ' err' : '');
  d.textContent = msg;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), ms);
}

/* ============================================================ settings UI */
function persist() { saveSettings(cfg); }

function bindRange(id, outId, key) {
  const n = $(id), o = $(outId);
  n.value = cfg[key]; o.textContent = cfg[key] + '%';
  n.addEventListener('input', () => { cfg[key] = +n.value; o.textContent = n.value + '%'; renderLogoPreview(); });
  n.addEventListener('change', persist);
}
function bindSelect(id, key, num = false) {
  const n = $(id);
  n.value = String(cfg[key]);
  n.addEventListener('change', () => { cfg[key] = num ? +n.value : n.value; persist(); if (key === 'parallel') pump(); renderLogoPreview(); });
}
function bindCheck(id, key, after) {
  const n = $(id);
  n.checked = !!cfg[key];
  n.addEventListener('change', () => { cfg[key] = n.checked; persist(); if (after) after(); });
}

bindRange('vMain', 'oMain', 'volMain');
bindRange('vVideo', 'oVideo', 'volVideo');
bindRange('lSize', 'oSize', 'logoSize');
bindRange('lOpac', 'oOpac', 'logoOpacity');
bindSelect('pattern', 'pattern');
bindSelect('quality', 'quality');
bindSelect('parallel', 'parallel', true);
bindSelect('lCorner', 'logoCorner');
bindCheck('logoOn', 'logoOn', renderLogoPreview);
bindCheck('autoStart', 'autoStart', () => { if (cfg.autoStart) for (const it of items) if (it.status === 'ready') it.status = 'queued'; items.forEach(updateRow); pump(); });
bindCheck('autoDownload', 'autoDownload');

/* ================================================================== logo */
function renderLogoPreview() {
  const has = !!logo.img;
  const img = $('logoPrev');
  $('logoPh').classList.toggle('hidden', has);
  img.classList.toggle('hidden', !has);
  $('logoRemove').classList.toggle('hidden', !has);
  $('logoSaved').classList.toggle('hidden', !has);
  $('logoBtnTxt').textContent = has ? 'লোগো বদলান' : 'লোগো দিন';
  $('logoName').textContent = has ? `${logo.file.name} · ${logo.img.naturalWidth}×${logo.img.naturalHeight}` : 'একবার দিলেই ব্রাউজারে সেভ থাকবে, বারবার আপলোড লাগবে না।';
  if (!has) return;
  img.src = logo.url;
  const fr = $('logoFrame');
  const m = 3;
  img.style.width = cfg.logoSize + '%';
  img.style.opacity = cfg.logoOpacity / 100;
  img.style.left = img.style.right = img.style.top = img.style.bottom = 'auto';
  img.style[cfg.logoCorner.endsWith('l') ? 'left' : 'right'] = m + '%';
  img.style[cfg.logoCorner.startsWith('t') ? 'top' : 'bottom'] = m + '%';
  img.style.display = cfg.logoOn ? '' : 'none';
  fr.classList.toggle('dim', !cfg.logoOn);
}

async function setLogo(file, save) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try { await img.decode(); if (!img.naturalWidth) throw 0; } catch (_) {
    URL.revokeObjectURL(url); toast('লোগো ইমেজ পড়া যায়নি', true); return false;
  }
  if (logo.url) URL.revokeObjectURL(logo.url);
  logo = { file, img, url };
  renderLogoPreview();
  if (save) {
    const ok = await saveLogoFile(file);
    toast(ok ? 'লোগো ব্রাউজারে সেভ হয়েছে — আর আপলোড করতে হবে না ✓' : 'লোগো লাগানো হয়েছে, কিন্তু ব্রাউজার সেভ করতে দিল না (প্রাইভেট মোড?)', !ok);
    if (!cfg.logoOn) { cfg.logoOn = true; $('logoOn').checked = true; persist(); renderLogoPreview(); }
    requestPersist();
  }
  return true;
}
$('in-logo').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) setLogo(f, true); });
$('logoRemove').onclick = async () => {
  if (logo.url) URL.revokeObjectURL(logo.url);
  logo = { file: null, img: null, url: null };
  await clearLogoFile();
  $('logoPrev').removeAttribute('src');
  renderLogoPreview();
  toast('সেভ করা লোগো মুছে ফেলা হয়েছে');
};
document.querySelectorAll('.ar [data-ar]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.ar [data-ar]').forEach((x) => x.classList.toggle('active', x === b));
    $('logoFrame').dataset.ar = b.dataset.ar;
  };
});

/* ================================================================= queue */
const STATUS_TXT = {
  incomplete: 'অডিও ও ভিডিও — দুটোই দিন',
  probing: 'ফাইল পরীক্ষা হচ্ছে…',
  ready: 'প্রস্তুত — "▶ শুরু" চাপুন',
  queued: 'লাইনে অপেক্ষায়…',
  canceled: 'বন্ধ করা হয়েছে',
};

function newItem() {
  const it = {
    id: uid++, audio: null, video: null, info: { audio: null, video: null }, perr: { audio: '', video: '' }, tok: { audio: 0, video: 0 },
    status: 'incomplete', pct: 0, text: '', err: '', log: '', blob: null, blobUrl: null, outName: '', ctl: null, li: null,
  };
  items.push(it);
  buildRow(it);
  updateRow(it);
  updateSummary();
  return it;
}

function buildRow(it) {
  const li = document.createElement('li');
  li.className = 'item';
  li.innerHTML = `
    <div class="no"></div>
    <div class="slots">
      <label class="slot a" data-kind="audio"><input type="file" accept="audio/*,.aac,.m4a,.mp3,.wav,.ogg,.flac,.opus" hidden>
        <span class="ic">🎵</span><span class="sx"><b class="sn"></b><small class="sm"></small></span></label>
      <label class="slot v" data-kind="video"><input type="file" accept="video/*" hidden>
        <span class="ic">🎬</span><span class="sx"><b class="sn"></b><small class="sm"></small></span></label>
    </div>
    <div class="st"><div class="bar"><div class="fill"></div></div><div class="stt"></div></div>
    <div class="acts">
      <button class="mini go" title="শুরু">▶</button>
      <button class="mini stop" title="বন্ধ করুন">■</button>
      <button class="mini retry" title="আবার চেষ্টা">↻</button>
      <a class="mini dl" title="ডাউনলোড">⬇</a>
      <button class="mini rm danger" title="সরান">✕</button>
    </div>`;
  it.li = li;
  li.querySelectorAll('.slot').forEach((slot) => {
    const kind = slot.dataset.kind;
    const input = slot.querySelector('input');
    input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; if (f) setFile(it, kind, f); });
    slot.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); slot.classList.add('over'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('over'));
    slot.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); slot.classList.remove('over');
      const files = [...e.dataTransfer.files];
      const f = files.find((x) => fileKind(x) === kind);
      if (f) setFile(it, kind, f); else if (files.length) toast(kind === 'audio' ? 'এখানে অডিও ফাইল দিন' : 'এখানে ভিডিও ফাইল দিন', true);
    });
    slot.addEventListener('click', (e) => { if (it.status === 'running') e.preventDefault(); });
  });
  li.querySelector('.go').onclick = () => { if (it.status === 'ready') { it.status = 'queued'; updateRow(it); pump(); } };
  li.querySelector('.stop').onclick = () => { if (it.ctl) abortExport(it.ctl); };
  li.querySelector('.retry').onclick = () => { if (canRun(it)) { it.status = 'queued'; it.err = ''; updateRow(it); pump(); } };
  li.querySelector('.dl').onclick = (e) => { e.preventDefault(); download(it); };
  li.querySelector('.rm').onclick = () => removeItem(it);
  $('qList').appendChild(li);
}

const canRun = (it) => !!(it.audio && it.video && it.info.audio && it.info.video);

function updateRow(it) {
  const li = it.li;
  if (!li) return;
  li.dataset.status = it.status;
  li.querySelector('.no').textContent = items.indexOf(it) + 1;
  for (const kind of ['audio', 'video']) {
    const slot = li.querySelector(`.slot.${kind === 'audio' ? 'a' : 'v'}`);
    const f = it[kind], inf = it.info[kind], pe = it.perr[kind];
    slot.classList.toggle('filled', !!f);
    slot.classList.toggle('bad', !!pe);
    slot.classList.toggle('locked', it.status === 'running');
    slot.querySelector('.sn').textContent = f ? f.name : (kind === 'audio' ? 'অডিও বাছুন / ফেলুন' : 'ভিডিও বাছুন / ফেলুন');
    let sm = '';
    if (pe) sm = pe;
    else if (f && inf) sm = kind === 'audio' ? `${fmtTime(inf.dur)} · ${fmtSize(f.size)}` : `${fmtTime(inf.dur)} · ${inf.w}×${inf.h} · ${fmtSize(f.size)}`;
    else if (f) sm = 'পরীক্ষা হচ্ছে…';
    else sm = kind === 'audio' ? 'MP3, AAC, WAV, M4A…' : 'MP4, MOV, WebM…';
    slot.querySelector('.sm').textContent = sm;
  }
  const st = it.status;
  li.querySelector('.go').classList.toggle('hidden', st !== 'ready');
  li.querySelector('.stop').classList.toggle('hidden', st !== 'running');
  li.querySelector('.retry').classList.toggle('hidden', !((st === 'error' || st === 'canceled') && canRun(it)));
  const dl = li.querySelector('.dl');
  dl.classList.toggle('hidden', st !== 'done');
  if (st === 'done') { dl.href = it.blobUrl; dl.download = it.outName; }
  li.querySelector('.rm').classList.toggle('hidden', st === 'running');
  li.querySelector('.bar').classList.toggle('hidden', !(st === 'running' || st === 'done' || st === 'queued'));
  li.querySelector('.fill').style.width = (st === 'done' ? 100 : st === 'queued' ? 0 : Math.round(it.pct * 100)) + '%';
  paintStatus(it);
  updateSummary();
}

function paintStatus(it) {
  const t = it.li.querySelector('.stt');
  const st = it.status;
  t.className = 'stt ' + st;
  if (st === 'running') {
    t.innerHTML = `<b>${Math.round(it.pct * 100)}%</b> ${esc(it.text)}`;
    it.li.querySelector('.fill').style.width = Math.round(it.pct * 100) + '%';
  } else if (st === 'done') t.textContent = it.text;
  else if (st === 'error') { t.textContent = it.err; t.title = it.log || ''; }
  else if (st === 'queued') {
    const ahead = items.filter((x) => x.status === 'queued').indexOf(it) + 1;
    t.textContent = `লাইনে অপেক্ষায় (${ahead} নম্বর)…`;
  } else t.textContent = STATUS_TXT[st] || '';
}

function updateSummary() {
  const c = { running: 0, queued: 0, done: 0, error: 0, ready: 0, other: 0 };
  for (const it of items) { if (c[it.status] !== undefined) c[it.status]++; else c.other++; }
  const parts = [];
  if (c.running) parts.push(`⚙ চলছে ${c.running}`);
  if (c.queued) parts.push(`⏳ অপেক্ষায় ${c.queued}`);
  if (c.ready) parts.push(`প্রস্তুত ${c.ready}`);
  if (c.done) parts.push(`✓ সম্পন্ন ${c.done}`);
  if (c.error) parts.push(`✗ ব্যর্থ ${c.error}`);
  if (c.other) parts.push(`অসম্পূর্ণ ${c.other}`);
  $('qSum').textContent = items.length ? `মোট ${items.length}টি · ` + (parts.join(' · ') || '—') : 'এখনো কিছু যোগ হয়নি';
  $('howto').classList.toggle('hidden', items.some((i) => i.audio || i.video));
  const busy = c.running + c.queued;
  document.title = busy ? `(${c.done}/${items.length}) AutoCut — চলছে…` : 'AutoCut — ব্যাচ ভিডিও এডিটর';
  setWake(busy > 0);
}

function removeItem(it) {
  if (it.ctl) abortExport(it.ctl);
  if (it.blobUrl) URL.revokeObjectURL(it.blobUrl);
  const i = items.indexOf(it);
  if (i >= 0) items.splice(i, 1);
  it.li.remove();
  it.status = 'removed';
  items.forEach(updateRow);
  pump();
}

function freeResult(it) {
  if (it.blobUrl) URL.revokeObjectURL(it.blobUrl);
  it.blob = null; it.blobUrl = null; it.pct = 0; it.err = ''; it.log = '';
}

async function setFile(it, kind, file) {
  if (it.status === 'running') return;
  if (fileKind(file) !== kind) { toast(kind === 'audio' ? 'এটা অডিও ফাইল নয়' : 'এটা ভিডিও ফাইল নয়', true); return; }
  if (['done', 'error', 'canceled', 'queued', 'ready'].includes(it.status)) { freeResult(it); it.status = 'incomplete'; }
  it[kind] = file; it.info[kind] = null; it.perr[kind] = '';
  const tok = ++it.tok[kind];
  evaluate(it);
  try {
    const info = kind === 'audio' ? await probeAudio(file) : await probeVideo(file);
    if (it.tok[kind] !== tok || it.status === 'removed') return;
    it.info[kind] = info;
  } catch (e) {
    if (it.tok[kind] !== tok || it.status === 'removed') return;
    it.perr[kind] = e.message || 'ফাইল পড়া যায়নি';
  }
  evaluate(it);
}

function evaluate(it) {
  if (it.status === 'running' || it.status === 'done' || it.status === 'removed') return;
  if (it.perr.audio || it.perr.video) { it.status = 'error'; it.err = it.perr.audio || it.perr.video; }
  else if (!it.audio || !it.video) it.status = 'incomplete';
  else if (!it.info.audio || !it.info.video) it.status = 'probing';
  else if (it.status !== 'queued') it.status = cfg.autoStart ? 'queued' : 'ready';
  updateRow(it);
  pump();
}

/* ---------------------------------------------------------- bulk add */
function addFiles(files) {
  const vids = [], auds = [], bad = [];
  for (const f of files) {
    const k = fileKind(f);
    if (k === 'video') vids.push(f); else if (k === 'audio') auds.push(f); else bad.push(f);
  }
  vids.sort(natural); auds.sort(natural);
  if (bad.length) toast(`${bad.length}টি ফাইল বাদ (ভিডিও/অডিও নয়)`, true);
  // প্রথমে ফাঁকা স্লটগুলো ভরি
  for (const it of items) {
    if (it.status === 'running' || it.status === 'done') continue;
    if (!it.video && vids.length) setFile(it, 'video', vids.shift());
    if (!it.audio && auds.length) setFile(it, 'audio', auds.shift());
  }
  const n = Math.max(vids.length, auds.length);
  for (let i = 0; i < n; i++) {
    const it = newItem();
    if (vids[i]) setFile(it, 'video', vids[i]);
    if (auds[i]) setFile(it, 'audio', auds[i]);
  }
  if (vids.length !== auds.length && n) toast('ভিডিও ও অডিওর সংখ্যা সমান নয় — অসম্পূর্ণ সারিতে বাকিটা দিন', true, 6000);
}
$('btnAdd').onclick = () => { const it = newItem(); it.li.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
$('in-bulk').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) addFiles(fs); });

// পুরো পেজে ফাইল ড্রপ
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('veil').classList.remove('hidden'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('veil').classList.add('hidden'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('veil').classList.add('hidden');
  const fs = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  if (fs.length) addFiles(fs);
});

/* ------------------------------------------------------------ scheduler */
function pump() {
  const max = clamp(+cfg.parallel || 1, 1, 4);
  let running = items.filter((i) => i.status === 'running').length;
  for (const it of items) {
    if (running >= max) break;
    if (it.status === 'queued' && canRun(it)) { startItem(it); running++; }
  }
  items.forEach((i) => { if (i.status === 'queued') paintStatus(i); });
  updateSummary();
}

function buildJob(it) {
  const a = it.info.audio, v = it.info.video;
  const T = a.dur;
  const useLogo = !!(cfg.logoOn && logo.img);
  const fw = cfg.logoSize / 100;
  const hf = useLogo ? (fw * v.w * logo.img.naturalHeight / logo.img.naturalWidth) / v.h : 0;
  const m = 0.03; // ধার = প্রস্থ/উচ্চতার ৩%
  const fx = clamp(cfg.logoCorner.endsWith('l') ? m : 1 - m - fw, 0, 1);
  const fy = clamp(cfg.logoCorner.startsWith('t') ? m : 1 - m - hf, 0, 1);
  const P = {
    segments: buildAuto(v.dur, T, cfg.pattern),
    vol: { video: cfg.volVideo, main: cfg.volMain, bg: 0 },
    bgLoop: { infinite: true, repeats: 1 }, bgOn: false,
    logoOn: useLogo, logo: { fx, fy, fw, opacity: cfg.logoOpacity / 100 },
  };
  return {
    videoFile: it.video, mainFile: it.audio, bgFile: null, bgDur: 0, logoImg: useLogo ? logo.img : null,
    W: v.w, H: v.h, T, srcDur: v.dur, quality: cfg.quality, P,
  };
}

async function startItem(it) {
  it.status = 'running'; it.pct = 0; it.text = 'শুরু হচ্ছে…'; it.err = '';
  it.ctl = {};
  updateRow(it);
  const ctl = it.ctl;
  try {
    const job = buildJob(it);
    const { blob, info } = await renderProject(job, {
      ctl,
      onProgress: (f) => { it.pct = f; if (it.status === 'running') paintStatus(it); },
      onStatus: (m) => { it.text = m; if (it.status === 'running') paintStatus(it); },
    });
    if (it.status === 'removed') return;
    it.blob = blob;
    it.blobUrl = URL.createObjectURL(blob);
    const n = String(items.indexOf(it) + 1).padStart(2, '0');
    it.outName = `autocut-${n}-${baseName(it.audio.name)}.mp4`;
    it.text = `✓ সম্পন্ন · ${fmtSize(blob.size)} · ${info.W}×${info.H} · ${fmtTime(job.T)}`;
    it.status = 'done';
    if (cfg.autoDownload) download(it);
  } catch (e) {
    if (it.status === 'removed') return;
    if (ctl.aborted) { it.status = 'canceled'; }
    else { console.error(e); it.status = 'error'; it.err = 'ব্যর্থ: ' + ((e && e.message) || e); it.log = (e && e.log) || ''; }
  } finally {
    it.ctl = null;
    if (it.status !== 'removed') updateRow(it);
    pump();
  }
}

function download(it) {
  if (!it.blobUrl) return;
  const a = document.createElement('a');
  a.href = it.blobUrl; a.download = it.outName;
  document.body.appendChild(a); a.click(); a.remove();
}

$('btnStartAll').onclick = () => { for (const it of items) if (it.status === 'ready') it.status = 'queued'; items.forEach(updateRow); pump(); };
$('btnDlAll').onclick = () => {
  const done = items.filter((i) => i.status === 'done');
  if (!done.length) return toast('এখনো কিছু সম্পন্ন হয়নি');
  done.forEach((it, i) => setTimeout(() => download(it), i * 500));
};
$('btnClean').onclick = () => { items.filter((i) => i.status === 'done').forEach(removeItem); };

/* -------------------------------------------------------- keep-awake etc */
let wake = null;
async function setWake(on) {
  try {
    if (on && !wake && navigator.wakeLock && !document.hidden) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!on && wake) { await wake.release(); wake = null; }
  } catch (_) {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateSummary(); });
window.addEventListener('beforeunload', (e) => {
  if (items.some((i) => i.status === 'running' || i.status === 'queued')) { e.preventDefault(); e.returnValue = ''; }
});

/* ------------------------------------------------------------------ init */
(async function init() {
  renderLogoPreview();
  newItem();
  try {
    const f = await loadLogoFile();
    if (f) await setLogo(f, false);
  } catch (_) {}
  const es = $('engineState');
  es.textContent = '⏳ ইঞ্জিন নামছে…';
  preloadFFmpeg((m) => { es.textContent = '⏳ ' + m; es.title = m; }).then(() => {
    es.textContent = '✓ ইঞ্জিন প্রস্তুত'; es.classList.add('ok');
  });
})();
