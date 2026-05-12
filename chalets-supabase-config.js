window.CHALETS_SUPABASE_URL = 'https://fkqidesfrtpwzjcimjoe.supabase.co';
window.CHALETS_SUPABASE_ANON_KEY = 'sb_publishable_Uks_PYr6aqY5wnNBjDjTgg_z2Ic6_al';
window.CHALETS_PRODUCTION_URL = 'https://qw1qw66-sudo.github.io/index.html/app.html';

(function patchSupabaseRedirect(){
  function getRedirectUrl(){
    var host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '') return window.CHALETS_PRODUCTION_URL;
    return window.location.origin + window.location.pathname;
  }
  function patch(){
    if (!window.supabase || !window.supabase.createClient || window.supabase.__chaletsRedirectPatched) return;
    var originalCreateClient = window.supabase.createClient;
    window.supabase.createClient = function(){
      var client = originalCreateClient.apply(this, arguments);
      if (client && client.auth && client.auth.signInWithOtp && !client.auth.__chaletsRedirectPatched) {
        var originalSignInWithOtp = client.auth.signInWithOtp.bind(client.auth);
        client.auth.signInWithOtp = function(params){
          params = params || {};
          params.options = params.options || {};
          params.options.emailRedirectTo = getRedirectUrl();
          params.options.shouldCreateUser = true;
          return originalSignInWithOtp(params);
        };
        client.auth.__chaletsRedirectPatched = true;
      }
      return client;
    };
    window.supabase.__chaletsRedirectPatched = true;
  }
  patch();
})();

(function registerChaletsServiceWorker(){
  if (!('serviceWorker' in navigator)) return;
  var scriptEl = document.currentScript;
  var swUrl = scriptEl && scriptEl.src ? new URL('sw.js', scriptEl.src).href : new URL('sw.js', window.location.origin + window.location.pathname).href;
  window.addEventListener('load', function(){
    navigator.serviceWorker.register(swUrl).catch(function(error){
      console.warn('[chalets-pwa] service worker registration failed', error);
    });
  });
})();

(function installBookingEditConflictGuard(){
  var APP_KEY = 'chalets_app_state_v5';
  var QUEUE_KEY = 'chalets_sync_queue_v2';
  var editingSnapshot = null;
  var guardInstalled = false;

  function $(id){ return document.getElementById(id); }
  function now(){ return new Date().toISOString(); }
  function uid(){ return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)); }
  function toNumber(v){ return Number(v || 0); }
  function parseDate(s){ return new Date(String(s || '') + 'T00:00:00'); }
  function nights(a,b){ if(!a || !b) return 0; return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  function activeBookings(state){ return (state.bookings || []).filter(function(b){ return !b.deleted_at; }); }
  function showToast(msg, type){
    var el = $('toast');
    if(!el){ alert(msg); return; }
    el.textContent = msg;
    el.className = 'toast on ' + (type || 'ok');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function(){ el.className = 'toast'; }, 3200);
  }
  function readState(){
    try {
      var raw = localStorage.getItem(APP_KEY);
      if(!raw) return {chalets:[], bookings:[], settings:{}, theme:'dark'};
      var parsed = JSON.parse(raw);
      parsed.chalets = parsed.chalets || [];
      parsed.bookings = parsed.bookings || [];
      parsed.settings = parsed.settings || {};
      return parsed;
    } catch(error){
      console.error('[booking-edit-guard] failed to read state', error);
      return {chalets:[], bookings:[], settings:{}, theme:'dark'};
    }
  }
  function writeState(state){ localStorage.setItem(APP_KEY, JSON.stringify(state)); }
  function readQueue(){ try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
  function writeQueue(q){ localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
  function enqueueBooking(id){
    var q = readQueue();
    q.push({type:'booking', id:id, action:'upsert', created_at:now(), retry:0});
    writeQueue(q.slice(-200));
  }
  function bookingNo(state){ return String(new Date().getFullYear()) + '-' + String(activeBookings(state).length + 1).padStart(4, '0'); }
  function formBooking(existingId){
    var state = readState();
    var old = activeBookings(state).find(function(b){ return String(b.id) === String(existingId); }) || {};
    var checkIn = $('bkIn') ? $('bkIn').value : '';
    var checkOut = $('bkOut') ? $('bkOut').value : '';
    return {
      id: old.id || existingId || uid(),
      booking_no: old.booking_no || (editingSnapshot && editingSnapshot.booking_no) || bookingNo(state),
      chalet_id: $('bkChalet') ? $('bkChalet').value : '',
      customer_name: $('bkName') ? $('bkName').value.trim() : '',
      customer_phone: $('bkPhone') ? $('bkPhone').value.trim() : '',
      check_in: checkIn,
      check_out: checkOut,
      nights: nights(checkIn, checkOut),
      guests: Math.max(1, toNumber($('bkGuests') ? $('bkGuests').value : 1)),
      total: toNumber($('bkTotal') ? $('bkTotal').value : 0),
      paid: toNumber($('bkPaid') ? $('bkPaid').value : 0),
      status: $('bkStatus') ? $('bkStatus').value : 'confirmed',
      notes: $('bkNotes') ? $('bkNotes').value.trim() : '',
      created_at: old.created_at || now(),
      updated_at: now(),
      deleted_at: null
    };
  }
  function validateBooking(b){
    if(!b.customer_name) return 'اسم العميل مطلوب';
    if(!b.customer_phone) return 'رقم الجوال مطلوب';
    if(!b.chalet_id) return 'اختر الشاليه';
    if(!b.check_in || !b.check_out) return 'اختر تاريخ الدخول والخروج';
    if(nights(b.check_in, b.check_out) <= 0) return 'تاريخ الخروج يجب أن يكون بعد الدخول';
    if(b.guests < 1) return 'عدد الضيوف لا يقل عن 1';
    if(b.paid < 0) return 'المدفوع لا يمكن أن يكون سالب';
    if(b.total < 0) return 'الإجمالي غير صحيح';
    if(b.paid > b.total && !confirm('المدفوع أكبر من الإجمالي. هل تريد المتابعة؟')) return 'تم إلغاء الحفظ';
    return '';
  }
  function overlaps(a,b){ return a.check_in < b.check_out && a.check_out > b.check_in; }
  function sameBooking(a,b){
    if(!a || !b) return false;
    if(String(a.id) === String(b.id)) return true;
    if(a.booking_no && b.booking_no && String(a.booking_no) === String(b.booking_no)) return true;
    return false;
  }
  function localConflict(state, booking){
    if(booking.status !== 'confirmed') return false;
    return activeBookings(state).some(function(b){
      return !sameBooking(b, booking) && b.chalet_id === booking.chalet_id && b.status === 'confirmed' && overlaps(b, booking);
    });
  }
  function inferEditingSnapshot(){
    var sheet = $('bookingSheet');
    if(!sheet || !sheet.classList.contains('on')) return null;
    var state = readState();
    var current = {
      chalet_id: $('bkChalet') ? $('bkChalet').value : '',
      customer_name: $('bkName') ? $('bkName').value.trim() : '',
      customer_phone: $('bkPhone') ? $('bkPhone').value.trim() : '',
      check_in: $('bkIn') ? $('bkIn').value : '',
      check_out: $('bkOut') ? $('bkOut').value : '',
      total: toNumber($('bkTotal') ? $('bkTotal').value : 0),
      paid: toNumber($('bkPaid') ? $('bkPaid').value : 0)
    };
    var found = activeBookings(state).find(function(b){
      return b.chalet_id === current.chalet_id && b.customer_phone === current.customer_phone && b.check_in === current.check_in && b.check_out === current.check_out && toNumber(b.total) === current.total && toNumber(b.paid) === current.paid;
    }) || activeBookings(state).find(function(b){
      return b.chalet_id === current.chalet_id && b.customer_name === current.customer_name && b.customer_phone === current.customer_phone && b.check_in === current.check_in && b.check_out === current.check_out;
    });
    return found ? {id: found.id, booking_no: found.booking_no} : null;
  }
  async function cloudConflict(booking){
    if(!navigator.onLine || booking.status !== 'confirmed') return false;
    if(!window.supabase || !window.supabase.createClient || !window.CHALETS_SUPABASE_URL || !window.CHALETS_SUPABASE_ANON_KEY) return false;
    var client = window.supabase.createClient(window.CHALETS_SUPABASE_URL, window.CHALETS_SUPABASE_ANON_KEY, {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storage:localStorage}});
    var sessionResult = await client.auth.getSession();
    var authUser = sessionResult && sessionResult.data && sessionResult.data.session && sessionResult.data.session.user;
    if(!authUser) return false;
    var result = await client.from('bookings').select('id, booking_no').eq('user_id', authUser.id).eq('chalet_id', booking.chalet_id).eq('status', 'confirmed').is('deleted_at', null).lt('check_in', booking.check_out).gt('check_out', booking.check_in);
    if(result.error){ console.error('[booking-edit-guard] cloud conflict check failed', result.error); return false; }
    return (result.data || []).some(function(row){ return !sameBooking(row, booking); });
  }
  async function saveFromGuard(event){
    if(!event.target || event.target.id !== 'saveBooking') return;
    if(!editingSnapshot) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    var state = readState();
    var booking = formBooking(editingSnapshot.id);
    var validation = validateBooking(booking);
    if(validation) return showToast(validation, 'bad');
    if(localConflict(state, booking)) return showToast('يوجد حجز مؤكد لنفس الشاليه في هذه الفترة. لا يمكن حفظ الحجز.', 'bad');
    if(await cloudConflict(booking)) return showToast('يوجد حجز مؤكد لنفس الشاليه في هذه الفترة. لا يمكن حفظ الحجز.', 'bad');
    var idx = state.bookings.findIndex(function(b){ return sameBooking(b, booking); });
    if(idx >= 0) state.bookings[idx] = booking;
    else state.bookings.push(booking);
    writeState(state);
    enqueueBooking(booking.id);
    showToast('تم الحفظ');
    setTimeout(function(){ window.location.reload(); }, 350);
  }
  function watchBookingSheet(){
    var sheet = $('bookingSheet');
    if(!sheet) return;
    var update = function(){
      if(sheet.classList.contains('on')) setTimeout(function(){ editingSnapshot = inferEditingSnapshot(); }, 80);
      else editingSnapshot = null;
    };
    new MutationObserver(update).observe(sheet, {attributes:true, attributeFilter:['class']});
    update();
  }
  function install(){
    if(guardInstalled) return;
    guardInstalled = true;
    watchBookingSheet();
    document.addEventListener('click', saveFromGuard, true);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();

(function installWorkspaceCodeSync(){
  var APP_KEY = 'chalets_app_state_v5';
  var DB_NAME = 'chaletsDB';
  var STORE = 'kv';
  var CODE_KEY = 'chalets_workspace_code_v1';
  var lastRendered = '';

  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function normalizeCode(value){ return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32); }
  function normalizeAccess(value){ return String(value || '').trim().slice(0, 32); }
  function toast(message, type){
    var el = $('toast');
    if(!el){ alert(message); return; }
    el.textContent = message;
    el.className = 'toast on ' + (type || 'ok');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function(){ el.className = 'toast'; }, 3200);
  }
  function readState(){ try{ var raw = localStorage.getItem(APP_KEY); return raw ? JSON.parse(raw) : null; }catch(error){ console.error('[workspace-sync] read failed', error); return null; } }
  function writeState(state){
    localStorage.setItem(APP_KEY, JSON.stringify(state));
    if(!('indexedDB' in window)) return Promise.resolve();
    return new Promise(function(resolve){
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function(){ if(!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onerror = function(){ resolve(); };
      req.onsuccess = function(){
        var db = req.result;
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(state, APP_KEY);
        tx.oncomplete = function(){ resolve(); };
        tx.onerror = function(){ resolve(); };
      };
    });
  }
  function createClient(){
    if(!window.supabase || !window.supabase.createClient) throw new Error('تعذر تحميل مكتبة Supabase');
    return window.supabase.createClient(window.CHALETS_SUPABASE_URL, window.CHALETS_SUPABASE_ANON_KEY, {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  }
  function summary(state){
    var chalets = ((state && state.chalets) || []).filter(function(x){ return !x.deleted_at; }).length;
    var bookings = ((state && state.bookings) || []).filter(function(x){ return !x.deleted_at; }).length;
    return chalets + ' شاليه / ' + bookings + ' حجز';
  }
  function setStatus(text, bad){
    var cloud = $('cloudStatusText');
    var status = $('workspaceStatus');
    var top = $('cloudTop');
    if(cloud) cloud.textContent = text;
    if(status){ status.textContent = text; status.style.color = bad ? 'var(--red)' : 'var(--muted)'; }
    if(top) top.title = text;
  }
  function inputs(){
    var code = normalizeCode($('workspaceCode') && $('workspaceCode').value);
    var accessCode = normalizeAccess($('workspaceAccessCode') && $('workspaceAccessCode').value);
    if(!code || code.length < 3) throw new Error('رمز المزامنة يجب أن يكون 3 أحرف أو أكثر');
    if(!accessCode || accessCode.length < 4) throw new Error('الرقم السري يجب أن يكون 4 أحرف/أرقام أو أكثر');
    localStorage.setItem(CODE_KEY, code);
    return {code:code, accessCode:accessCode};
  }
  function render(force){
    var card = document.querySelector('#v-settings .cloud-card');
    if(!card) return false;
    if(!force && card.querySelector('#workspaceCode')) return true;
    var savedCode = normalizeCode(localStorage.getItem(CODE_KEY) || 'ALI6');
    var state = readState();
    var html = '<h3>المزامنة السحابية ☁️</h3>'+
      '<p class="small">اربط الأجهزة بنفس رمز المزامنة والرقم السري. الرقم السري لا يُحفظ في الجهاز.</p>'+
      '<p class="small" id="workspaceStatus">'+(savedCode ? 'متصل: '+esc(savedCode) : 'محلي فقط')+'</p>'+
      '<div class="f"><label>رمز المزامنة</label><input id="workspaceCode" class="ltr" value="'+esc(savedCode)+'" placeholder="ALI6" autocomplete="off"></div>'+
      '<div class="f"><label>الرقم السري</label><input id="workspaceAccessCode" class="ltr" placeholder="••••" type="password" autocomplete="off"></div>'+
      '<button class="btn primary full" id="workspaceConnect">تحميل / ربط المساحة</button>'+
      '<div class="row" style="margin-top:10px"><button class="btn outline" id="workspacePull">تحميل من السحابة</button><button class="btn outline" id="workspacePush">رفع التعديلات</button></div>'+
      '<p class="small" id="workspaceSummary">آخر تحميل محلي: '+esc(summary(state))+'</p>'+
      '<div style="display:none"><input id="supabaseUrl" value="'+esc(window.CHALETS_SUPABASE_URL || '')+'"><input id="supabaseAnon" value="'+esc(window.CHALETS_SUPABASE_ANON_KEY || '')+'"><button id="saveCloudConfig" type="button"></button><div id="authBox"><input id="loginEmail"><button id="sendLogin" type="button"></button><p id="authMessage"></p></div><div id="loggedBox"><b id="loggedEmail"></b><button id="syncNow" type="button"></button><button id="logoutBtn" type="button"></button></div></div>';
    if(html === lastRendered && !force) return true;
    lastRendered = html;
    card.innerHTML = html;
    $('workspaceConnect').addEventListener('click', connectWorkspace);
    $('workspacePull').addEventListener('click', pullWorkspace);
    $('workspacePush').addEventListener('click', pushWorkspace);
    setStatus(savedCode ? 'متصل: '+savedCode : 'محلي فقط');
    return true;
  }
  async function pullWorkspace(){
    try{
      var input = inputs();
      setStatus('جاري التحميل من السحابة...');
      var response = await createClient().rpc('workspace_pull_state', {p_code: input.code, p_access_code: input.accessCode});
      if(response.error) throw response.error;
      if(!response.data || !response.data.ok || response.data.not_found){
        toast('المساحة غير موجودة. استخدم رفع التعديلات لإنشائها.', 'bad');
        setStatus('المساحة غير موجودة', true);
        return null;
      }
      await writeState(response.data.state);
      setStatus('متصل: '+input.code);
      toast('تم تحميل بيانات المساحة');
      setTimeout(function(){ window.location.reload(); }, 500);
      return response.data.state;
    }catch(error){
      console.error(error);
      var msg = String(error.message || error);
      toast(msg.indexOf('INVALID_ACCESS_CODE') >= 0 ? 'الرقم السري غير صحيح' : 'فشل التحميل: '+msg, 'bad');
      setStatus('فشل التحميل', true);
      return null;
    }
  }
  async function pushWorkspace(){
    try{
      var input = inputs();
      var state = readState();
      if(!state) throw new Error('لا توجد بيانات محلية للرفع');
      if(!confirm('سيتم رفع بيانات هذا الجهاز إلى المساحة '+input.code+'. هل تريد المتابعة؟')) return;
      setStatus('جاري رفع التعديلات...');
      var response = await createClient().rpc('workspace_push_state', {p_code: input.code, p_access_code: input.accessCode, p_state: state});
      if(response.error) throw response.error;
      if(!response.data || !response.data.ok) throw new Error('لم يتم تأكيد الرفع من Supabase');
      setStatus('متصل: '+input.code);
      toast(response.data.created ? 'تم إنشاء المساحة ورفع البيانات' : 'تم رفع التعديلات');
    }catch(error){
      console.error(error);
      var msg = String(error.message || error);
      toast(msg.indexOf('INVALID_ACCESS_CODE') >= 0 ? 'الرقم السري غير صحيح' : 'فشل الرفع: '+msg, 'bad');
      setStatus('فشل الرفع', true);
    }
  }
  async function connectWorkspace(){
    var state = await pullWorkspace();
    if(!state && confirm('هل تريد إنشاء المساحة من بيانات هذا الجهاز؟')) await pushWorkspace();
  }
  function install(){
    if(!render(true)) return setTimeout(install, 300);
    setInterval(function(){
      var card = document.querySelector('#v-settings .cloud-card');
      if(card && !card.querySelector('#workspaceCode')) render(true);
    }, 800);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
