// Minimal IndexedDB wrapper. Cosmetic data lives here instead of
// chrome.storage so a page only loads the few records it needs.

const DB_NAME = 'bulwark';
const DB_VERSION = 1;
const STORES = ['spec', 'gen', 'kv', 'lists'];
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

export async function getMany(store, keys) {
  if (!keys.length) return [];
  const db = await open();
  const tx = db.transaction(store, 'readonly');
  const os = tx.objectStore(store);
  const out = new Array(keys.length);
  keys.forEach((k, i) => { const r = os.get(k); r.onsuccess = () => { out[i] = r.result; }; });
  await done(tx);
  return out;
}

export async function get(store, key) {
  return (await getMany(store, [key]))[0];
}

export async function put(store, key, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  await done(tx);
}

export async function del(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

// Replaces the full content of a store in one transaction.
export async function replaceAll(store, entries) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  os.clear();
  for (const k in entries) os.put(entries[k], k);
  await done(tx);
}

export async function getAll(store) {
  const db = await open();
  const tx = db.transaction(store, 'readonly');
  const os = tx.objectStore(store);
  const keysReq = os.getAllKeys();
  const valsReq = os.getAll();
  await done(tx);
  const out = {};
  keysReq.result.forEach((k, i) => { out[k] = valsReq.result[i]; });
  return out;
}

export const kv = {
  get: (k) => get('kv', k),
  set: (k, v) => put('kv', k, v)
};
