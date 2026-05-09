/* Chalet Booking System - Email-only cloud sync.
   The user enters the same email on each phone. No magic link is required.
   Requires Supabase table: chalets_booking_state_email
   Columns: sync_key text primary key, email_hint text, data jsonb, updated_at timestamptz
*/

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const LOCAL_KEY = 'chalets_app_state_v3';
const DB_NAME = 'chaletsDB';
const STORE = 'kv';
const TABLE = 'chalets_booking_state_email';
const EMAIL_KEY = 'chalets_sync_email';
const SYNC_KEY = 'chalets_sync_key';
const STATUS_ID = 'chaletsCloudStatus';
const PANEL_ID = 'chaletsCloudPanel';

const url = window.CHALETS_SUPABASE_URL;
const anonKey = window.CHALETS_SUPABASE_ANON_KEY;
let supabase = null;
let syncEmail = localStorage.getItem(EMAIL_KEY) || '';
let syncKey = localStorage.getItem(SYNC_KEY) || '';
let applyingRemote = false;
let saveTimer = null;
let nativeSetItem = localStorage.setItem.bind(localStorage);
let lastLocalSnapshot = localStorage.getItem(LOCAL_KEY) || '';
let pollTimer = null;

function addStyles(){
  const style=document.createElement('style');
  style.textContent=`
  #${STATUS_ID}{position:fixed;left:12px;bottom:12px;z-index:999999;border:1px solid #344052;background:#1b212b;color:#f6efe5;border-radius:999px;padding:9px 13px;font:12px -apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Arial;box-shadow:0 10px 30px rgba(0,0,0,.35);cursor:pointer}
  #${STATUS_ID}.ok{border-color:#73a76b;color:#73a76b}#${STATUS_ID}.warn{border-color:#d4af5f;color:#d4af5f}#${STATUS_ID}.bad{border-color:#d46a5d;color:#d46a5d}
  #${PANEL_ID}{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.65);display:none;align-items:center;justify-content:center;padding:16px;direction:rtl}
  #${PANEL_ID}.show{display:flex}#${PANEL_ID} .box{width:min(480px,100%);background:#1b212b;border:1px solid #344052;border-radius:18px;padding:16px;color:#f6efe5;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Arial;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  #${PANEL_ID} h3{margin:0 0 8px;font-size:19px}#${PANEL_ID} p{margin:6px 0;color:#b8afa2;line-height:1.6}#${PANEL_ID} input{width:100%;padding:12px;border-radius:14px;border:1px solid #344052;background:#242c38;color:#f6efe5;margin:8px 0;font:inherit;direction:ltr;text-align:left}#${PANEL_ID} button{border:1px solid #344052;background:#242c38;color:#f6efe5;border-radius:14px;padding:10px 13px;font-weight:800;margin:4px;cursor:pointer}#${PANEL_ID} button.primary{border-color:#d4af5f;color:#17120a;background:linear-gradient(135deg,#f0cf82,#d4af5f)}#${PANEL_ID} button.danger{border-color:#d46a5d;color:#d46a5d}#${PANEL_ID} .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}#${PANEL_ID} .small{font-size:12px;color:#b8afa2}`;
  document.head.appendChild(style);
}

function setStatus(text,type='warn'){
  let el=document.getElementById(STATUS_ID);
  if(!el){el=document.createElement('button');el.type='button';el.id=STATUS_ID;el.onclick=openPanel;document.body.appendChild(el);}
  el.textContent=text;el.className=type;
}
function readLocal(){try{return JSON.parse(localStorage.getItem(LOCAL_KEY)||'{}')}catch{return {}}}
function writeLocal(data){applyingRemote=true;const text=JSON.stringify(data||{});nativeSetItem(LOCAL_KEY,text);lastLocalSnapshot=text;writeIndexedDB(data||{}).finally(()=>{applyingRemote=false})}
function stamp(data){const next=data||{};next._cloud={...(next._cloud||{}),updated_at:new Date().toISOString(),email:syncEmail};return next}
function clean(data){const c=JSON.parse(JSON.stringify(data||{}));if(c._cloud)delete c._cloud;return c}
function localDate(data){return data?._cloud?.updated_at||null}
function isNewer(a,b){if(!a)return false;if(!b)return true;return new Date(a).getTime()>new Date(b).getTime()}
function validEmail(e){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e||'').trim())}
async function sha256(text){const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text.trim().toLowerCase()));return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('')}

function openDB(){return new Promise(resolve=>{if(!indexedDB)return resolve(null);const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE)};req.onsuccess=()=>resolve(req.result);req.onerror=()=>resolve(null)})}
async function writeIndexedDB(data){const db=await openDB();if(!db)return;return new Promise(resolve=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(data,LOCAL_KEY);tx.oncomplete=resolve;tx.onerror=resolve})}

async function getRemote(){
  const {data,error}=await supabase.from(TABLE).select('data,updated_at').eq('sync_key',syncKey).maybeSingle();
  if(error)throw error;return data;
}
async function pushLocal(){
  if(!syncKey||applyingRemote)return;
  const local=stamp(readLocal());writeLocal(local);
  const {error}=await supabase.from(TABLE).upsert({sync_key:syncKey,email_hint:syncEmail.slice(0,3)+'***',data:clean(local)},{onConflict:'sync_key'});
  if(error)throw error;setStatus('Cloud: synced','ok');
}
async function pullRemote(){
  if(!syncKey)return false;
  const remote=await getRemote();if(!remote?.data)return false;
  if(isNewer(remote.updated_at,localDate(readLocal()))){
    const data=remote.data||{};data._cloud={updated_at:remote.updated_at,email:syncEmail};writeLocal(data);setStatus('Cloud: updated','ok');setTimeout(()=>location.reload(),700);return true;
  }
  return false;
}
async function firstSync(){
  try{const remote=await getRemote();if(!remote){await pushLocal();return}if(isNewer(remote.updated_at,localDate(readLocal())))await pullRemote();else await pushLocal();}
  catch(e){console.error(e);setStatus('Cloud: sync error','bad')}
}
function queuePush(){
  if(!syncKey||applyingRemote)return;
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>pushLocal().catch(e=>{console.error(e);setStatus('Cloud: save failed','bad')}),1000);
}
function patchLocalStorage(){
  if(!localStorage.__chaletsCloudPatched){
    const old=nativeSetItem;
    localStorage.setItem=function(key,value){old(key,value);if(key===LOCAL_KEY&&!applyingRemote){lastLocalSnapshot=String(value||'');queuePush();}};
    localStorage.__chaletsCloudPatched=true;
  }
  window.addEventListener('storage',e=>{if(e.key===LOCAL_KEY&&!applyingRemote){lastLocalSnapshot=e.newValue||'';queuePush();}});
  clearInterval(pollTimer);
  pollTimer=setInterval(()=>{const now=localStorage.getItem(LOCAL_KEY)||'';if(now!==lastLocalSnapshot&&!applyingRemote){lastLocalSnapshot=now;queuePush();}},1500);
}
async function realtime(){
  supabase.channel('chalets-email-'+syncKey).on('postgres_changes',{event:'*',schema:'public',table:TABLE,filter:`sync_key=eq.${syncKey}`},()=>pullRemote().catch(console.error)).subscribe();
}
async function activateEmail(email){
  const e=String(email||'').trim().toLowerCase();
  if(!validEmail(e))return alert('أدخل إيميل صحيح');
  syncEmail=e;syncKey=await sha256('chalets:'+e);
  localStorage.setItem(EMAIL_KEY,syncEmail);localStorage.setItem(SYNC_KEY,syncKey);
  setStatus('Cloud: syncing','warn');
  patchLocalStorage();await firstSync();await realtime();setStatus('Cloud: synced','ok');updatePanel();
}
function openPanel(){
  let p=document.getElementById(PANEL_ID);
  if(!p){p=document.createElement('div');p.id=PANEL_ID;p.innerHTML=`<div class="box"><h3>المزامنة السحابية</h3><p>اكتب نفس الإيميل في كل جوال، وتبدأ المزامنة مباشرة بدون رابط دخول.</p><input id="cloudEmail" type="email" placeholder="email@example.com"><div class="row"><button class="primary" id="cloudStart">تفعيل المزامنة الآن</button><button id="cloudPull">تنزيل من السحابة</button><button class="danger" id="cloudForget">نسيان الإيميل</button></div><p id="cloudInfo" class="small"></p><div class="row"><button id="cloudClose">إغلاق</button></div></div>`;document.body.appendChild(p);p.addEventListener('click',e=>{if(e.target===p)p.classList.remove('show')});p.querySelector('#cloudClose').onclick=()=>p.classList.remove('show');p.querySelector('#cloudStart').onclick=()=>activateEmail(p.querySelector('#cloudEmail').value);p.querySelector('#cloudPull').onclick=()=>pullRemote().then(()=>alert('تم فحص السحابة'));p.querySelector('#cloudForget').onclick=()=>{localStorage.removeItem(EMAIL_KEY);localStorage.removeItem(SYNC_KEY);syncEmail='';syncKey='';setStatus('Cloud: email needed','warn');updatePanel()};}
  updatePanel();p.classList.add('show');
}
function updatePanel(){const p=document.getElementById(PANEL_ID);if(!p)return;const inp=p.querySelector('#cloudEmail'),info=p.querySelector('#cloudInfo');if(inp)inp.value=syncEmail||'';if(info)info.textContent=syncEmail?'مفعل على: '+syncEmail:'أدخل إيميل واحد تستخدمه على كل الأجهزة.';}
async function init(){
  addStyles();
  if(!url||!anonKey||url.includes('YOUR_PROJECT')||anonKey.includes('YOUR_SUPABASE')){setStatus('Cloud: setup needed','warn');return}
  supabase=createClient(url,anonKey);patchLocalStorage();
  if(syncEmail&&syncKey){setStatus('Cloud: syncing','warn');await firstSync();await realtime();setStatus('Cloud: synced','ok')}else setStatus('Cloud: email needed','warn');
}
init();
