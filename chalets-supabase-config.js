// Supabase connection values for Chalet Booking System cloud sync.
// Public anon key only. Never put service_role key in frontend code.

window.CHALETS_SUPABASE_URL = 'https://fkqidesfrtpwzjcimjoe.supabase.co';
window.CHALETS_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZrcWlkZXNmcnRwd3pqY2ltam9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzMzg1NzMsImV4cCI6MjA5MzkxNDU3M30.SkBzDQcimh43fz2g4Gkt8gL52dQF-2oU7_rF_uI-sus';

// Safety patch: never let Magic Link redirect to localhost in production emails.
// If the app is opened from Gmail or a local preview, the auth redirect is forced to GitHub Pages.
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

// Register the PWA service worker. This is intentionally non-blocking; the booking app must still work
// if registration fails on a browser/private mode that restricts service workers.
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

// Hotfix guard for booking edit conflict false positives.
// The current app keeps core functions inside src/main.js IIFE. Until they are extracted into modules,
// this guard intercepts only EDIT saves, preserves the edited booking identity, and ignores the same
// booking by id or booking_no during local/cloud conflict checks.
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
  function nights(a,b){
    if(!a || !b) return 0;
    return Math.round((parseDate(b) - parseDate(a)) / 86400000);
  }
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
    } catch(e){
      console.error('[booking-edit-guard] failed to read state', e);
      return {chalets:[], bookings:[], settings:{}, theme:'dark'};
    }
  }
  function writeState(state){ localStorage.setItem(APP_KEY, JSON.stringify(state)); }
  function readQueue(){
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch(e){ return []; }
  }
  function writeQueue(q){ localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
  function enqueueBooking(id, action){
    var q = readQueue();
    q.push({type:'booking', id:id, action:action || 'upsert', created_at:now(), retry:0});
    writeQueue(q.slice(-200));
  }
  function bookingNo(state){
    return String(new Date().getFullYear()) + '-' + String(activeBookings(state).length + 1).padStart(4, '0');
  }
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
      return !sameBooking(b, booking) &&
        b.chalet_id === booking.chalet_id &&
        b.status === 'confirmed' &&
        overlaps(b, booking);
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
      return b.chalet_id === current.chalet_id &&
        b.customer_phone === current.customer_phone &&
        b.check_in === current.check_in &&
        b.check_out === current.check_out &&
        toNumber(b.total) === current.total &&
        toNumber(b.paid) === current.paid;
    }) || activeBookings(state).find(function(b){
      return b.chalet_id === current.chalet_id &&
        b.customer_name === current.customer_name &&
        b.customer_phone === current.customer_phone &&
        b.check_in === current.check_in &&
        b.check_out === current.check_out;
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
    var result = await client
      .from('bookings')
      .select('id, booking_no, check_in, check_out')
      .eq('user_id', authUser.id)
      .eq('chalet_id', booking.chalet_id)
      .eq('status', 'confirmed')
      .is('deleted_at', null)
      .lt('check_in', booking.check_out)
      .gt('check_out', booking.check_in);
    if(result.error){
      console.error('[booking-edit-guard] cloud conflict check failed', result.error);
      return false;
    }
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
    enqueueBooking(booking.id, 'upsert');
    showToast('تم الحفظ');
    setTimeout(function(){ window.location.reload(); }, 350);
  }
  function watchBookingSheet(){
    var sheet = $('bookingSheet');
    if(!sheet) return;
    var update = function(){
      if(sheet.classList.contains('on')){
        setTimeout(function(){ editingSnapshot = inferEditingSnapshot(); }, 80);
      } else {
        editingSnapshot = null;
      }
    };
    new MutationObserver(update).observe(sheet, {attributes:true, attributeFilter:['class']});
    update();
  }
  function install(){
    if(guardInstalled) return;
    guardInstalled = true;
    watchBookingSheet();
    document.addEventListener('click', saveFromGuard, true);
    console.info('[booking-edit-guard] installed');
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
