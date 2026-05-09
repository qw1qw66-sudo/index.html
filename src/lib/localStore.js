export const LOCAL_KEY = 'chalets_app_state_v3';
export const QUEUE_KEY = 'chalets_sync_queue_v1';
export const DB_NAME = 'chaletsDB';
export const STORE = 'kv';

const nativeSetItem = localStorage.setItem.bind(localStorage);

export function nowISO() {
  return new Date().toISOString();
}

export function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || '') || fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  nativeSetItem(key, JSON.stringify(value));
}

export function readLocal() {
  return readJson(LOCAL_KEY, {});
}

export function writeLocalRaw(data) {
  const text = JSON.stringify(data || {});
  nativeSetItem(LOCAL_KEY, text);
  return text;
}

export function readQueue() {
  return readJson(QUEUE_KEY, []);
}

export function writeQueue(queue) {
  writeJson(QUEUE_KEY, queue || []);
}

export function hasUsefulData(data) {
  return !!(
    data &&
    ((Array.isArray(data.chalets) && data.chalets.length) ||
      (Array.isArray(data.bookings) && data.bookings.length) ||
      data.set)
  );
}

export function cleanForCloud(data) {
  const copy = JSON.parse(JSON.stringify(data || {}));
  delete copy._cloud;
  return copy;
}

export function markCloud(data, updatedAt, version) {
  const next = data || {};
  next._cloud = {
    updated_at: updatedAt || nowISO(),
    version: version || next._cloud?.version || 1
  };
  return next;
}

export function mergeById(remoteArr = [], localArr = []) {
  const map = new Map();
  for (const item of remoteArr || []) if (item?.id) map.set(item.id, item);
  for (const item of localArr || []) if (item?.id) map.set(item.id, { ...(map.get(item.id) || {}), ...item });
  return [...map.values()];
}

export function mergeState(remote = {}, local = {}) {
  const out = { ...remote, ...local };
  out.chalets = mergeById(remote.chalets, local.chalets);
  out.bookings = mergeById(remote.bookings, local.bookings);
  out.set = { ...(remote.set || {}), ...(local.set || {}) };
  out.theme = local.theme || remote.theme || 'dark';
  return out;
}

export function openDB() {
  return new Promise((resolve) => {
    if (!indexedDB) return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export async function writeIndexedDB(data) {
  const db = await openDB();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(data, LOCAL_KEY);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

export async function createBackupBeforeMigration() {
  const data = readLocal();
  if (!hasUsefulData(data)) return;
  const backup = { exported_at: nowISO(), data };
  nativeSetItem('chalets_backup_before_cloud_sync', JSON.stringify(backup));
}

export function exportBackupFile() {
  const data = readLocal();
  const blob = new Blob([JSON.stringify({ exported_at: nowISO(), data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chalets-cloud-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function getNativeSetItem() {
  return nativeSetItem;
}
