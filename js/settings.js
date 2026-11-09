// ব্রাউজারে সেভ করা সেটিংস (localStorage) ও লোগো ফাইল (IndexedDB)।
// ব্যাচ পেজ ও ম্যানুয়াল এডিটর — দুটোই একই জায়গা থেকে পড়ে, তাই লোগো একবার দিলেই হয়।

const KEY = 'autocut.settings.v1';

export const DEFAULTS = {
  volMain: 35,        // মেইন অডিও ভলিউম %
  volVideo: 100,      // ভিডিওর নিজস্ব সাউন্ড %
  pattern: 'alt',     // alt = নরমাল → রিভার্স → নরমাল…
  quality: 'standard',
  parallel: 2,        // একসাথে কতগুলো ভিডিও রেন্ডার হবে
  autoStart: true,    // জোড়া সম্পূর্ণ হলেই শুরু
  autoDownload: true, // শেষ হলেই ডাউনলোড
  logoOn: true,
  logoSize: 18,       // লোগোর প্রস্থ (ভিডিও প্রস্থের %)
  logoOpacity: 53,    // স্বচ্ছতা %
  logoCorner: 'bl',   // bl, br, tl, tr
};

export function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...raw };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {}
}

/* ---------------- logo file in IndexedDB ---------------- */
let memLogo = null; // IndexedDB না চললে অন্তত এই ট্যাবে মনে রাখি

function openDB() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('no indexedDB'));
    const r = indexedDB.open('autocut', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  try {
    return await new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const out = fn(t.objectStore('kv'));
      t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  } finally { db.close(); }
}

export async function saveLogoFile(file) {
  memLogo = file;
  try {
    await tx('readwrite', (st) => st.put({ blob: file, name: file.name, type: file.type }, 'logo'));
    return true;
  } catch (_) { return false; }
}

export async function loadLogoFile() {
  try {
    const rec = await tx('readonly', (st) => st.get('logo'));
    if (rec && rec.blob) return new File([rec.blob], rec.name || 'logo.png', { type: rec.type || rec.blob.type });
  } catch (_) {}
  return memLogo;
}

export async function clearLogoFile() {
  memLogo = null;
  try { await tx('readwrite', (st) => st.delete('logo')); } catch (_) {}
}

/** ব্রাউজারকে বলি ডেটা যেন নিজে থেকে মুছে না ফেলে (best effort)। */
export function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
}
