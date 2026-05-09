import { createSupabaseClient, isSupabaseConfigured } from './supabaseClient.js';
import {
  LOCAL_KEY,
  QUEUE_KEY,
  readLocal,
  writeLocalRaw,
  readQueue,
  writeQueue,
  hasUsefulData,
  cleanForCloud,
  markCloud,
  mergeState,
  writeIndexedDB,
  createBackupBeforeMigration,
  exportBackupFile,
  nowISO,
  getNativeSetItem
} from './localStore.js';

const DATA_KEY = LOCAL_KEY;
const USER_DATA_TABLE = 'user_data';
const SYNC_QUEUE_TABLE = 'sync_queue';
const SYNC_LOG_TABLE = 'sync_log';
const STATUS_ID = 'chaletsCloudStatus';
const PANEL_ID = 'chaletsCloudPanel';

let supabase = null;
let session = null;
let user = null;
let applyingRemote = false;
let saveTimer = null;
let pollTimer = null;
let realtimeChannel = null;
let retryTimer = null;
let startedAutoPull = false;
let lastLocalSnapshot = localStorage.getItem(LOCAL_KEY) || '';
let nativeSetItem = getNativeSetItem();

const isDev = ['localhost', '127.0.0.1'].includes(location.hostname);
const log = (...args) => { if (isDev) console.log('[chalets-sync]', ...args); };

function addStyles() {
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

function setStatus(text, type = 'warn') {
  let el = document.getElementById(STATUS_ID);
  if (!el) {
    el = document.createElement('button');
    el.type = 'button';
    el.id = STATUS_ID;
    el.onclick = openPanel;
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = type;
}

function setMessage(text, type = '') {
  const panel = document.getElementById(PANEL_ID);
  const msg = panel?.querySelector('#cloudMsg');
  if (msg) {
    msg.textContent = text || '';
    msg.className = 'small ' + type;
  }
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

async function writeLocal(data) {
  applyingRemote = true;
  const text = writeLocalRaw(data || {});
  lastLocalSnapshot = text;
  try {
    await writeIndexedDB(data || {});
  } finally {
    applyingRemote = false;
  }
}

function addLocalQueue(action = 'upsert') {
  const queue = readQueue();
  queue.push({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    action,
    data_key: DATA_KEY,
    created_at: nowISO(),
    retry: 0
  });
  writeQueue(queue.slice(-50));
}

async function addRemoteQueue(action, payload) {
  if (!user) return;
  try {
    await supabase.from(SYNC_QUEUE_TABLE).insert({
      user_id: user.id,
      data_key: DATA_KEY,
      payload,
      action,
      status: 'done'
    });
  } catch (error) {
    log('remote sync_queue insert failed', error);
  }
}

async function logSync(action) {
  if (!user) return;
  try {
    await supabase.from(SYNC_LOG_TABLE).insert({ user_id: user.id, action, data_key: DATA_KEY });
  } catch (error) {
    log('sync_log insert failed', error);
  }
}

async function fetchCloud() {
  if (!user) return null;
  const { data, error } = await supabase
    .from(USER_DATA_TABLE)
    .select('data,version,updated_at')
    .eq('user_id', user.id)
    .eq('data_key', DATA_KEY)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function pushLocal(reason = 'auto') {
  if (!user || applyingRemote) return;
  if (!navigator.onLine) {
    setStatus('أنت غير متصل، سيتم الحفظ محليًا ثم المزامنة لاحقًا', 'off');
    addLocalQueue('upsert');
    return;
  }

  setStatus('جاري المزامنة', 'warn');
  const current = readLocal();
  const cloud = await fetchCloud().catch(() => null);
  const nextVersion = Number(cloud?.version || current?._cloud?.version || 0) + 1;
  const payload = markCloud(current, nowISO(), nextVersion);

  await writeLocal(payload);

  const { error } = await supabase
    .from(USER_DATA_TABLE)
    .upsert({ user_id: user.id, data_key: DATA_KEY, data: cleanForCloud(payload), version: nextVersion }, { onConflict: 'user_id,data_key' });

  if (error) throw error;
  writeQueue([]);
  await addRemoteQueue(reason, cleanForCloud(payload));
  await logSync(reason);
  setStatus('تمت المزامنة', 'ok');
}

async function pullCloud({ force = false } = {}) {
  if (!user) return false;
  if (!navigator.onLine) {
    setStatus('أنت غير متصل، سيتم الحفظ محليًا ثم المزامنة لاحقًا', 'off');
    return false;
  }

  const cloud = await fetchCloud();
  if (!cloud?.data) return false;

  const local = readLocal();
  const cloudTime = cloud.updated_at;
  const localTime = local?._cloud?.updated_at;

  if (force || !hasUsefulData(local) || !localTime || new Date(cloudTime).getTime() > new Date(localTime).getTime()) {
    const next = force && hasUsefulData(local) ? mergeState(cloud.data, local) : cloud.data;
    await writeLocal(markCloud(next, cloudTime, cloud.version));
    setStatus('تمت المزامنة', 'ok');
    setTimeout(() => location.reload(), 500);
    return true;
  }

  return false;
}

async function firstSyncAfterLogin() {
  if (!user) return;
  setStatus('جاري المزامنة', 'warn');
  setMessage('جاري المزامنة');
  await createBackupBeforeMigration();

  const local = readLocal();
  const cloud = await fetchCloud();

  if (!cloud) {
    await pushLocal('first_upload');
  } else if (hasUsefulData(local)) {
    const merged = mergeState(cloud.data || {}, local);
    await writeLocal(markCloud(merged, nowISO(), Number(cloud.version || 0) + 1));
    await pushLocal('merge_upload');
  } else {
    await pullCloud({ force: true });
  }

  patchLocalStorage();
  startRealtime();
  startAutoPull();
  setMessage('تمت المزامنة', 'ok');
}

function queuePush() {
  if (!user || applyingRemote) return;
  addLocalQueue('upsert');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => processQueue(), 1200);
}

async function processQueue() {
  if (!user) return;
  if (!navigator.onLine) {
    setStatus('أنت غير متصل، سيتم الحفظ محليًا ثم المزامنة لاحقًا', 'off');
    return;
  }

  const queue = readQueue();
  if (!queue.length) return;

  try {
    await pushLocal('queued_sync');
  } catch (error) {
    console.error(error);
    setStatus('فشلت المزامنة، سنحاول مرة أخرى', 'bad');
    const next = queue.map((item) => ({ ...item, retry: Number(item.retry || 0) + 1 }));
    writeQueue(next);
    const retryMs = Math.min(30000, 1000 * Math.pow(2, Math.min(5, next[0]?.retry || 1)));
    clearTimeout(retryTimer);
    retryTimer = setTimeout(processQueue, retryMs);
  }
}

function patchLocalStorage() {
  if (!localStorage.__chaletsCloudPatched) {
    localStorage.setItem = function patchedSetItem(key, value) {
      nativeSetItem(key, value);
      if (key === LOCAL_KEY && !applyingRemote) {
        lastLocalSnapshot = String(value || '');
        queuePush();
      }
    };
    localStorage.__chaletsCloudPatched = true;
  }

  window.addEventListener('storage', (event) => {
    if (event.key === LOCAL_KEY && !applyingRemote) {
      lastLocalSnapshot = event.newValue || '';
      queuePush();
    }
  });

  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    const now = localStorage.getItem(LOCAL_KEY) || '';
    if (now !== lastLocalSnapshot && !applyingRemote) {
      lastLocalSnapshot = now;
      queuePush();
    }
  }, 1500);
}

function startRealtime() {
  if (!user) return;
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase
    .channel('chalets-user-data-' + user.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: USER_DATA_TABLE, filter: `user_id=eq.${user.id}` }, (payload) => {
      if (payload.new?.data_key === DATA_KEY) pullCloud().catch(console.error);
    })
    .subscribe();
}

function startAutoPull() {
  if (startedAutoPull) return;
  startedAutoPull = true;

  window.addEventListener('online', () => {
    setStatus('جاري المزامنة', 'warn');
    processQueue().then(() => pullCloud()).catch(console.error);
  });
  window.addEventListener('offline', () => setStatus('غير متصل', 'off'));
  window.addEventListener('focus', () => { if (user) pullCloud().catch(console.error); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && user) pullCloud().catch(console.error); });
  setInterval(() => { if (user && navigator.onLine) pullCloud().catch(console.error); }, 30000);
}

async function sendMagicLink() {
  const email = document.getElementById('cloudEmail')?.value?.trim();
  if (!validEmail(email)) {
    setMessage('أدخل بريدك لتفعيل المزامنة', 'bad');
    return;
  }

  setStatus('جاري المزامنة', 'warn');
  setMessage('جاري إرسال رمز الدخول');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: location.href.split('#')[0].split('?')[0]
    }
  });

  if (error) {
    setStatus('خطأ في المزامنة', 'bad');
    setMessage(error.message || 'فشلت المزامنة، سنحاول مرة أخرى', 'bad');
    return;
  }

  setStatus('تم إرسال رمز الدخول إلى بريدك', 'ok');
  setMessage('تم إرسال رمز الدخول إلى بريدك', 'ok');
}

async function verifyOtp() {
  const email = document.getElementById('cloudEmail')?.value?.trim();
  const token = document.getElementById('cloudOtp')?.value?.trim();
  if (!validEmail(email) || !token) {
    setMessage('أدخل البريد والرمز', 'bad');
    return;
  }

  setStatus('جاري المزامنة', 'warn');
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error) {
    setStatus('خطأ في المزامنة', 'bad');
    setMessage('رمز غير صحيح أو منتهي', 'bad');
    return;
  }

  session = data.session;
  user = data.user;
  setStatus('تم تسجيل الدخول', 'ok');
  setMessage('تم تسجيل الدخول', 'ok');
  await firstSyncAfterLogin();
  updatePanel();
}

async function logout() {
  await supabase.auth.signOut();
  session = null;
  user = null;
  writeQueue([]);
  setStatus('محلي فقط', 'warn');
  setMessage('تم تسجيل الخروج. البيانات المحلية محفوظة ولم تُحذف.', 'ok');
  updatePanel();
}

function openPanel() {
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `<div class="box">
      <h3>المزامنة السحابية</h3>
      <p>أدخل بريدك لتفعيل المزامنة. بعد التحقق مرة واحدة، تتم المزامنة تلقائيًا بين الأجهزة.</p>
      <div id="cloudSignedOut">
        <input id="cloudEmail" type="email" placeholder="email@example.com" autocomplete="email">
        <input id="cloudOtp" type="text" inputmode="numeric" placeholder="رمز الدخول إن وصل كرمز">
        <div class="row">
          <button class="primary" id="cloudSend">إرسال رمز الدخول</button>
          <button id="cloudVerify">تأكيد الرمز</button>
        </div>
      </div>
      <div id="cloudSignedIn" style="display:none">
        <p id="cloudUser"></p>
        <div class="row">
          <button class="primary" id="cloudSyncNow">مزامنة الآن</button>
          <button id="cloudDownload">تنزيل من السحابة</button>
          <button id="cloudBackup">تصدير نسخة</button>
          <button class="danger" id="cloudLogout">تسجيل خروج</button>
        </div>
      </div>
      <p id="cloudMsg" class="small"></p>
      <p class="small">الأمان: البريد وحده لا يفتح البيانات. يجب التحقق من البريد، والملكية تعتمد على auth.uid().</p>
      <div class="row"><button id="cloudClose">إغلاق</button></div>
    </div>`;
    document.body.appendChild(panel);
    panel.addEventListener('click', (event) => { if (event.target === panel) panel.classList.remove('show'); });
    panel.querySelector('#cloudClose').onclick = () => panel.classList.remove('show');
    panel.querySelector('#cloudSend').onclick = () => sendMagicLink().catch(console.error);
    panel.querySelector('#cloudVerify').onclick = () => verifyOtp().catch(console.error);
    panel.querySelector('#cloudSyncNow').onclick = () => processQueue().then(() => pushLocal('manual_sync')).catch((error) => {
      console.error(error);
      setMessage('فشلت المزامنة، سنحاول مرة أخرى', 'bad');
    });
    panel.querySelector('#cloudDownload').onclick = () => pullCloud({ force: true }).catch(console.error);
    panel.querySelector('#cloudBackup').onclick = () => exportBackupFile();
    panel.querySelector('#cloudLogout').onclick = () => logout().catch(console.error);
  }

  updatePanel();
  panel.classList.add('show');
}

function updatePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  const signedOut = panel.querySelector('#cloudSignedOut');
  const signedIn = panel.querySelector('#cloudSignedIn');
  const userEl = panel.querySelector('#cloudUser');

  if (user) {
    signedOut.style.display = 'none';
    signedIn.style.display = 'block';
    userEl.textContent = 'مسجل دخول: ' + (user.email || user.id);
  } else {
    signedOut.style.display = 'block';
    signedIn.style.display = 'none';
  }
}

export async function startChaletsCloudSync() {
  addStyles();

  if (!isSupabaseConfigured()) {
    setStatus('محلي فقط', 'warn');
    return;
  }

  supabase = createSupabaseClient();
  patchLocalStorage();

  if (!navigator.onLine) setStatus('غير متصل', 'off');
  else setStatus('محلي فقط', 'warn');

  const { data } = await supabase.auth.getSession();
  session = data.session;
  user = session?.user || null;

  supabase.auth.onAuthStateChange(async (event, newSession) => {
    session = newSession;
    user = newSession?.user || null;
    if (user) {
      setStatus(event === 'SIGNED_IN' ? 'تم تسجيل الدخول' : 'جاري المزامنة', 'ok');
      await firstSyncAfterLogin().catch((error) => {
        console.error(error);
        setStatus('فشلت المزامنة، سنحاول مرة أخرى', 'bad');
      });
    } else {
      setStatus('محلي فقط', 'warn');
    }
    updatePanel();
  });

  if (user) await firstSyncAfterLogin();
  else if (readQueue().length) setStatus('محلي فقط', 'warn');
}
