/*
  Chalet Booking System - Secure Supabase cloud sync
  Framework detected: plain HTML/JavaScript PWA.
  Local data detected: localStorage + IndexedDB, key chalets_app_state_v3.
  Security: data ownership uses auth.uid() through Supabase Auth + Row Level Security.
  Email alone is not accepted as identity because anyone could type another email.
*/

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const LOCAL_KEY = 'chalets_app_state_v3';
const QUEUE_KEY = 'chalets_sync_queue_v1';
const DB_NAME = 'chaletsDB';
const STORE = 'kv';
const DATA_KEY = 'chalets_app_state_v3';
const USER_DATA_TABLE = 'user_data';
const SYNC_LOG_TABLE = 'sync_log';
const STATUS_ID = 'chaletsCloudStatus';
const PANEL_ID = 'chaletsCloudPanel';

const SUPABASE_URL = window.CHALETS_SUPABASE_URL || window.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.CHALETS_SUPABASE_ANON_KEY || window.VITE_SUPABASE_ANON_KEY || '';

let supabase = null;
let session = null;
let user = null;
let applyingRemote = false;
let saveTimer = null;
let pollTimer = null;
let realtimeChannel = null;
let retryTimer = null;
let lastLocalSnapshot = localStorage.getItem(LOCAL_KEY) || '';
let nativeSetItem = localStorage.setItem.bind(localStorage);

const isDev = ['localhost', '127.0.0.1'].includes(location.hostname);
const log = (...args) => { if (isDev) console.log('[chalets-sync]', ...args); };

function addStyles(){
  const style = document.createElement('style');
  style.textContent = `
  #${STATUS_ID}{position:fixed;left:12px;bottom:12px;z-index:999999;border:1px solid #344052;background:#1b212b;color:#f6efe5;border-radius:999px;padding:9px 13px;font:12px -apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Arial;box-shadow:0 10px 30px rgba(0,0,0,.35);cursor:pointer}
  #${STATUS_ID}.ok{border-color:#73a76b;color:#73a76b}#${STATUS_ID}.warn{border-color:#d4af5f;color:#d4af5f}#${STATUS_ID}.bad{border-color:#d46a5d;color:#d46a5d}#${STATUS_ID}.off{border-color:#b8afa2;color:#b8afa2}
  #${PANEL_ID}{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.65);display:none;align-items:center;justify-content:center;padding:16px;direction:rtl}
  #${PANEL_ID}.show{display:flex}
  #${PANEL_ID} .box{width:min(500px,100%);background:#1b212b;border:1px solid #344052;border-radius:18px;padding:16px;color:#f6efe5;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Arial;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  #${PANEL_ID} h3{margin:0 0 8px;font-size:19px}#${PANEL_ID} p{margin:6px 0;color:#b8afa2;line-height:1.6}
  #${PANEL_ID} input{width:100%;padding:12px;border-radius:14px;border:1px solid #344052;background:#242c38;color:#f6efe5;margin:8px 0;font:inherit;direction:ltr;text-align:left;box-sizing:border-box}
  #${PANEL_ID} button{border:1px solid #344052;background:#242c38;color:#f6efe5;border-radius:14px;padding:10px 13px;font-weight:800;margin:4px;cursor:pointer}
  #${PANEL_ID} button.primary{border-color:#d4af5f;color:#17120a;background:linear-gradient(135deg,#f0cf82,#d4af5f)}#${PANEL_ID} button.danger{border-color:#d46a5d;color:#d46a5d}
  #${PANEL_ID} .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}#${PANEL_ID} .small{font-size:12px;color:#b8afa2}#${PANEL_ID} .ok{color:#73a76b}#${PANEL_ID} .bad{color:#d46a5d}`;
  document.head.appendChild(style);
}

function setStatus(text, type='warn'){
  let el = document.getElementById(STATUS_ID);
  if(!el){
    el = document.createElement('button');
    el.type = 'button';
    el.id = STATUS_ID;
    el.onclick = openPanel;
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = type;
}

function setMessage(text, type=''){
  const p = document.getElementById(PANEL_ID);
  const msg = p?.querySelector('#cloudMsg');
  if(msg){ msg.textContent = text || ''; msg.className = 'small ' + type; }
}

function validEmail(email){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim()); }
function nowISO(){ return new Date().toISOString(); }
function readJson(key, fallback){ try { return JSON.parse(localStorage.getItem(key) || '') || fallback; } catch { return fallback; } }
function writeJson(key, value){ nativeSetItem(key, JSON.stringify(value)); }
function readLocal(){ return readJson(LOCAL_KEY, {}); }
function readQueue(){ return readJson(QUEUE_KEY, []); }
function writeQueue(q){ writeJson(QUEUE_KEY, q || []); }
function hasUsefulData(data){ return !!(data && ((Array.isArray(data.chalets) && data.chalets.length) || (Array.isArray(data.bookings) && data.bookings.length) || data.set)); }
function cleanForCloud(data){ const c = JSON.parse(JSON.stringify(data || {})); delete c._cloud; return c; }
function markCloud(data, updatedAt, version){ const d = data || {}; d._cloud = { updated_at: updatedAt || nowISO(), version: version || d._cloud?.version || 1 }; return d; }

function writeLocal(data){
  applyingRemote = true;
  const text = JSON.stringify(data || {});
  nativeSetItem(LOCAL_KEY, text);
  lastLocalSnapshot = text;
  writeIndexedDB(data || {}).catch(console.error).finally(()=>{ applyingRemote = false; });
}

function mergeById(remoteArr = [], localArr = []){
  const m = new Map();
  for(const x of remoteArr || []) if(x?.id) m.set(x.id, x);
  for(const x of localArr || []) if(x?.id) m.set(x.id, { ...(m.get(x.id) || {}), ...x });
  return [...m.values()];
}

function mergeState(remote = {}, local = {}){
  const out = { ...remote, ...local };
  out.chalets = mergeById(remote.chalets, local.chalets);
  out.bookings = mergeById(remote.bookings, local.bookings);
  out.set = { ...(remote.set || {}), ...(local.set || {}) };
  out.theme = local.theme || remote.theme || 'dark';
  return out;
}

function openDB(){
  return new Promise(resolve=>{
    if(!indexedDB) return resolve(null);
    const req = indexedDB.open(DB_NAME,1);
    req.onupgradeneeded = () => { if(!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function writeIndexedDB(data){
  const db = await openDB();
  if(!db) return;
  return new Promise(resolve=>{
    const tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(data, LOCAL_KEY);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

async function createBackupBeforeMigration(){
  try {
    const data = readLocal();
    if(!hasUsefulData(data)) return;
    const backup = { exported_at: nowISO(), data };
    nativeSetItem('chalets_backup_before_cloud_sync', JSON.stringify(backup));
  } catch (e) { log('backup failed', e); }
}

function addQueue(action='upsert'){
  const q = readQueue();
  q.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), action, data_key: DATA_KEY, created_at: nowISO(), retry: 0 });
  writeQueue(q.slice(-50));
}

async function logSync(action){
  if(!user) return;
  try { await supabase.from(SYNC_LOG_TABLE).insert({ user_id: user.id, action, data_key: DATA_KEY }); } catch(e) { log('sync_log failed', e); }
}

async function fetchCloud(){
  if(!user) return null;
  const { data, error } = await supabase
    .from(USER_DATA_TABLE)
    .select('data,version,updated_at')
    .eq('user_id', user.id)
    .eq('data_key', DATA_KEY)
    .maybeSingle();
  if(error) throw error;
  return data;
}

async function pushLocal(reason='auto'){
  if(!user || applyingRemote) return;
  if(!navigator.onLine){ setStatus('Offline - محفوظ محليًا','off'); addQueue('upsert'); return; }

  setStatus('جاري المزامنة','warn');
  const current = readLocal();
  const cloud = await fetchCloud().catch(()=>null);
  const nextVersion = Number(cloud?.version || current?._cloud?.version || 0) + 1;
  const payload = markCloud(current, nowISO(), nextVersion);
  writeLocal(payload);

  const { error } = await supabase
    .from(USER_DATA_TABLE)
    .upsert({ user_id: user.id, data_key: DATA_KEY, data: cleanForCloud(payload), version: nextVersion }, { onConflict: 'user_id,data_key' });

  if(error) throw error;
  writeQueue([]);
  setStatus('تمت المزامنة','ok');
  await logSync(reason);
}

async function pullCloud({ force=false } = {}){
  if(!user) return false;
  if(!navigator.onLine){ setStatus('Offline - محفوظ محليًا','off'); return false; }

  const cloud = await fetchCloud();
  if(!cloud?.data) return false;
  const local = readLocal();
  const cloudTime = cloud.updated_at;
  const localTime = local?._cloud?.updated_at;

  if(force || !hasUsefulData(local) || !localTime || new Date(cloudTime).getTime() > new Date(localTime).getTime()){
    const merged = hasUsefulData(local) && force ? mergeState(cloud.data, local) : cloud.data;
    writeLocal(markCloud(merged, cloudTime, cloud.version));
    setStatus('تمت المزامنة','ok');
    setTimeout(()=>location.reload(),500);
    return true;
  }
  return false;
}

async function firstSyncAfterLogin(){
  if(!user) return;
  setStatus('جاري المزامنة','warn');
  setMessage('جاري المزامنة');
  await createBackupBeforeMigration();

  const local = readLocal();
  const cloud = await fetchCloud();

  if(!cloud){
    await pushLocal('first_upload');
  } else if(hasUsefulData(local)){
    const merged = mergeState(cloud.data || {}, local);
    writeLocal(markCloud(merged, nowISO(), Number(cloud.version || 0) + 1));
    await pushLocal('merge_upload');
  } else {
    await pullCloud({ force:true });
  }

  patchLocalStorage();
  startRealtime();
  startAutoPull();
  setMessage('تمت المزامنة', 'ok');
}

function queuePush(){
  if(!user || applyingRemote) return;
  addQueue('upsert');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>processQueue(), 1200);
}

async function processQueue(){
  if(!user) return;
  if(!navigator.onLine){ setStatus('فشل الاتصال، سيتم الحفظ محليًا ثم المزامنة لاحقًا','off'); return; }
  const q = readQueue();
  if(!q.length) return;
  try { await pushLocal('queued_sync'); }
  catch(e){
    console.error(e);
    setStatus('فشل الاتصال، سيتم الحفظ محليًا ثم المزامنة لاحقًا','bad');
    const next = q.map(item => ({ ...item, retry: Number(item.retry || 0) + 1 }));
    writeQueue(next);
    const retry = Math.min(30000, 1000 * Math.pow(2, Math.min(5, next[0]?.retry || 1)));
    clearTimeout(retryTimer);
    retryTimer = setTimeout(processQueue, retry);
  }
}

function patchLocalStorage(){
  if(!localStorage.__chaletsCloudPatched){
    const old = nativeSetItem;
    localStorage.setItem = function(key, value){
      old(key, value);
      if(key === LOCAL_KEY && !applyingRemote){ lastLocalSnapshot = String(value || ''); queuePush(); }
    };
    localStorage.__chaletsCloudPatched = true;
  }
  window.addEventListener('storage', e => { if(e.key === LOCAL_KEY && !applyingRemote){ lastLocalSnapshot = e.newValue || ''; queuePush(); } });
  clearInterval(pollTimer);
  pollTimer = setInterval(()=>{
    const now = localStorage.getItem(LOCAL_KEY) || '';
    if(now !== lastLocalSnapshot && !applyingRemote){ lastLocalSnapshot = now; queuePush(); }
  }, 1500);
}

function startRealtime(){
  if(!user) return;
  if(realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase
    .channel('chalets-user-data-' + user.id)
    .on('postgres_changes', { event:'*', schema:'public', table:USER_DATA_TABLE, filter:`user_id=eq.${user.id}` }, payload => {
      if(payload.new?.data_key === DATA_KEY) pullCloud().catch(console.error);
    })
    .subscribe();
}

function startAutoPull(){
  window.addEventListener('online', () => { setStatus('جاري المزامنة','warn'); processQueue().then(()=>pullCloud()).catch(console.error); });
  window.addEventListener('offline', () => setStatus('Offline - محفوظ محليًا','off'));
  window.addEventListener('focus', () => { if(user) pullCloud().catch(console.error); });
  document.addEventListener('visibilitychange', () => { if(!document.hidden && user) pullCloud().catch(console.error); });
  setInterval(()=>{ if(user && navigator.onLine) pullCloud().catch(console.error); }, 30000);
}

async function sendMagicLink(){
  const email = document.getElementById('cloudEmail')?.value?.trim();
  if(!validEmail(email)){ setMessage('أدخل إيميل صحيح','bad'); return; }
  setStatus('جاري إرسال رابط الدخول','warn');
  setMessage('جاري إرسال رابط الدخول');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: location.href.split('#')[0].split('?')[0] }
  });
  if(error){ setStatus('خطأ في تسجيل الدخول','bad'); setMessage(error.message || 'تعذر إرسال الرابط','bad'); return; }
  setStatus('تم إرسال رابط الدخول إلى بريدك','ok');
  setMessage('تم إرسال رابط الدخول إلى بريدك', 'ok');
}

async function verifyOtp(){
  const email = document.getElementById('cloudEmail')?.value?.trim();
  const token = document.getElementById('cloudOtp')?.value?.trim();
  if(!validEmail(email) || !token){ setMessage('أدخل الإيميل والرمز','bad'); return; }
  setStatus('جاري تسجيل الدخول','warn');
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type:'email' });
  if(error){ setStatus('رمز غير صحيح أو منتهي','bad'); setMessage('رمز غير صحيح أو منتهي','bad'); return; }
  session = data.session;
  user = data.user;
  setStatus('تم تسجيل الدخول','ok');
  setMessage('تم تسجيل الدخول','ok');
  await firstSyncAfterLogin();
  updatePanel();
}

async function logout(){
  await supabase.auth.signOut();
  session = null;
  user = null;
  writeQueue([]);
  setStatus('Local only','warn');
  setMessage('تم تسجيل الخروج. البيانات المحلية محفوظة ولم تُحذف.', 'ok');
  updatePanel();
}

function openPanel(){
  let p = document.getElementById(PANEL_ID);
  if(!p){
    p = document.createElement('div');
    p.id = PANEL_ID;
    p.innerHTML = `<div class="box">
      <h3>المزامنة السحابية</h3>
      <p>أدخل الإيميل، ثم افتح رابط الدخول أو أدخل الرمز من البريد. بعد التحقق مرة واحدة ستتم المزامنة تلقائيًا بين الأجهزة.</p>
      <div id="cloudSignedOut">
        <input id="cloudEmail" type="email" placeholder="email@example.com" autocomplete="email">
        <input id="cloudOtp" type="text" inputmode="numeric" placeholder="رمز التحقق إن وصل كرمز">
        <div class="row">
          <button class="primary" id="cloudSend">إرسال رابط الدخول</button>
          <button id="cloudVerify">تأكيد الرمز</button>
        </div>
      </div>
      <div id="cloudSignedIn" style="display:none">
        <p id="cloudUser"></p>
        <div class="row">
          <button class="primary" id="cloudSyncNow">مزامنة الآن</button>
          <button id="cloudDownload">تنزيل من السحابة</button>
          <button class="danger" id="cloudLogout">تسجيل خروج</button>
        </div>
      </div>
      <p id="cloudMsg" class="small"></p>
      <p class="small">الأمان: لا يتم ربط البيانات بمجرد كتابة الإيميل فقط؛ يجب تحقق Supabase أولًا، والملكية تعتمد على auth.uid().</p>
      <div class="row"><button id="cloudClose">إغلاق</button></div>
    </div>`;
    document.body.appendChild(p);
    p.addEventListener('click', e => { if(e.target === p) p.classList.remove('show'); });
    p.querySelector('#cloudClose').onclick = () => p.classList.remove('show');
    p.querySelector('#cloudSend').onclick = () => sendMagicLink().catch(console.error);
    p.querySelector('#cloudVerify').onclick = () => verifyOtp().catch(console.error);
    p.querySelector('#cloudSyncNow').onclick = () => processQueue().then(()=>pushLocal('manual_sync')).catch(e=>{ console.error(e); setMessage('فشل الاتصال، سيتم الحفظ محليًا ثم المزامنة لاحقًا','bad'); });
    p.querySelector('#cloudDownload').onclick = () => pullCloud({ force:true }).catch(console.error);
    p.querySelector('#cloudLogout').onclick = () => logout().catch(console.error);
  }
  updatePanel();
  p.classList.add('show');
}

function updatePanel(){
  const p = document.getElementById(PANEL_ID);
  if(!p) return;
  const out = p.querySelector('#cloudSignedOut');
  const inn = p.querySelector('#cloudSignedIn');
  const userEl = p.querySelector('#cloudUser');
  if(user){
    out.style.display = 'none';
    inn.style.display = 'block';
    userEl.textContent = 'مسجل دخول: ' + (user.email || user.id);
  } else {
    out.style.display = 'block';
    inn.style.display = 'none';
  }
}

async function init(){
  addStyles();
  if(!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes('YOUR_PROJECT') || SUPABASE_ANON_KEY.includes('YOUR_SUPABASE')){
    setStatus('Cloud: setup needed','warn');
    return;
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, storage:localStorage }
  });

  patchLocalStorage();
  if(!navigator.onLine) setStatus('Offline - محفوظ محليًا','off');
  else setStatus('Local only','warn');

  const { data } = await supabase.auth.getSession();
  session = data.session;
  user = session?.user || null;

  supabase.auth.onAuthStateChange(async (event, newSession) => {
    session = newSession;
    user = newSession?.user || null;
    if(user){
      setStatus(event === 'SIGNED_IN' ? 'تم تسجيل الدخول' : 'جاري المزامنة', 'ok');
      await firstSyncAfterLogin().catch(e=>{ console.error(e); setStatus('فشل الاتصال، سيتم الحفظ محليًا ثم المزامنة لاحقًا','bad'); });
    } else {
      setStatus('Local only','warn');
    }
    updatePanel();
  });

  if(user) await firstSyncAfterLogin();
  else if(readQueue().length) setStatus('Local only - بانتظار الدخول','warn');
}

init().catch(e => { console.error(e); setStatus('خطأ في المزامنة','bad'); });
