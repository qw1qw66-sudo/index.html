/* Chalet Booking System Cloud Sync using Supabase Magic Link.

Setup:
1) Run chalets-supabase-schema.sql in Supabase SQL Editor.
2) Replace values in chalets-supabase-config.js.
3) Open cloud.html.
*/

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const LOCAL_KEY = 'chalets_app_state_v3';
const DB_NAME = 'chaletsDB';
const STORE = 'kv';
const TABLE = 'chalets_booking_state';
const STATUS_ID = 'chaletsCloudStatus';
const PANEL_ID = 'chaletsCloudPanel';

const url = window.CHALETS_SUPABASE_URL;
const anonKey = window.CHALETS_SUPABASE_ANON_KEY;
let supabase = null;
let currentUser = null;
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
function writeLocal(data){applyingRemote=true;const text=JSON.stringify(data||{});nativeSetItem(LOCAL_KEY,text);lastLocalSnapshot=text;writeIndexedDB(data||{}).catch(console.error).finally(()=>{applyingRemote=false})}
function stamp(data){const next=data||{};next._cloud={...(next._cloud||{}),updated_at:new Date().toISOString()};return next}
function clean(data){const c=JSON.parse(JSON.stringify(data||{}));if(c._cloud)delete c._cloud;return c}
function localDate(data){return data?._cloud?.updated_at||null}
function isNewer(a,b){if(!a)return false;if(!b)return true;return new Date(a).getTime()>new Date(b).getTime()}

function openDB(){return new Promise(resolve=>{if(!indexedDB)return resolve(null);const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE)};req.onsuccess=()=>resolve(req.result);req.onerror=()=>resolve(null)})}
async function writeIndexedDB(data){const db=await openDB();if(!db)return;return new Promise(resolve=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(data,LOCAL_KEY);tx.oncomplete=resolve;tx.onerror=resolve})}

async function getRemote(){
  const {data,error}=await supabase.from(TABLE).select('data,updated_at').eq('user_id',currentUser.id).maybeSingle();
  if(error)throw error;return data;
}
async function pushLocal(){
  if(!currentUser||applyingRemote)return;
  const local=stamp(readLocal());writeLocal(local);
  const {error}=await supabase.from(TABLE).upsert({user_id:currentUser.id,data:clean(local)},{onConflict:'user_id'});
  if(error)throw error;setStatus('Cloud: synced','ok');
}
async function pullRemote(){
  if(!currentUser)return false;
  const remote=await getRemote();if(!remote?.data)return false;
  if(isNewer(remote.updated_at,localDate(readLocal()))){
    const data=remote.data||{};data._cloud={updated_at:remote.updated_at};writeLocal(data);setStatus('Cloud: updated','ok');setTimeout(()=>location.reload(),700);return true;
  }
  return false;
}
async function firstSync(){
  try{const remote=await getRemote();if(!remote){await pushLocal();return}if(isNewer(remote.updated_at,localDate(readLocal())))await pullRemote();else await pushLocal();}
  catch(e){console.error(e);setStatus('Cloud: sync error','bad')}
}
function queuePush(){
  if(!currentUser||applyingRemote)return;
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>pushLocal().catch(e=>{console.error(e);setStatus('Cloud: save failed','bad')}),1200);
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
  supabase.channel('chalets-state-'+currentUser.id).on('postgres_changes',{event:'*',schema:'public',table:TABLE,filter:`user_id=eq.${currentUser.id}`},()=>pullRemote().catch(console.error)).subscribe();
}
function openPanel(){
  let p=document.getElementById(PANEL_ID);
  if(!p){p=document.createElement('div');p.id=PANEL_ID;p.innerHTML=`<div class="box"><h3>المزامنة السحابية</h3><p>اربط نظام حجوزات الشاليهات بين أكثر من جوال بنفس الإيميل.</p><div id="cloudSignedOut"><input id="cloudEmail" type="email" placeholder="email@example.com"><div class="row"><button class="primary" id="cloudMagicBtn">إرسال رابط دخول</button></div><p class="small">استخدم نفس الإيميل في كل الأجهزة.</p></div><div id="cloudSignedIn" style="display:none"><p id="cloudUser"></p><div class="row"><button class="primary" id="cloudPush">رفع بيانات هذا الجهاز</button><button id="cloudPull">تنزيل بيانات السحابة</button><button class="danger" id="cloudOut">تسجيل خروج</button></div></div><div class="row"><button id="cloudClose">إغلاق</button></div></div>`;document.body.appendChild(p);p.addEventListener('click',e=>{if(e.target===p)p.classList.remove('show')});p.querySelector('#cloudClose').onclick=()=>p.classList.remove('show');p.querySelector('#cloudMagicBtn').onclick=sendMagic;p.querySelector('#cloudPush').onclick=()=>pushLocal().then(()=>alert('تم رفع البيانات'));p.querySelector('#cloudPull').onclick=()=>pullRemote().then(()=>alert('تم فحص بيانات السحابة'));p.querySelector('#cloudOut').onclick=async()=>{await supabase.auth.signOut();currentUser=null;setStatus('Cloud: sign in needed','warn');updatePanel()};}
  updatePanel();p.classList.add('show');
}
function updatePanel(){
  const a=document.getElementById('cloudSignedOut'),b=document.getElementById('cloudSignedIn'),u=document.getElementById('cloudUser');if(!a||!b)return;
  if(currentUser){a.style.display='none';b.style.display='block';u.textContent='مسجل دخول: '+(currentUser.email||currentUser.id)}else{a.style.display='block';b.style.display='none'}
}
async function sendMagic(){
  const email=document.getElementById('cloudEmail').value.trim();if(!email)return alert('أدخل الإيميل');
  const {error}=await supabase.auth.signInWithOtp({email});if(error)return alert(error.message);alert('تم إرسال رابط الدخول. افتحه من نفس الجهاز.');
}
async function afterSignedIn(){patchLocalStorage();await firstSync();await realtime();setStatus('Cloud: synced','ok');updatePanel()}
async function init(){
  addStyles();
  if(!url||!anonKey||url.includes('YOUR_PROJECT')||anonKey.includes('YOUR_SUPABASE')){setStatus('Cloud: setup needed','warn');return}
  supabase=createClient(url,anonKey);setStatus('Cloud: checking','warn');
  const {data}=await supabase.auth.getSession();currentUser=data.session?.user||null;
  supabase.auth.onAuthStateChange(async(_event,session)=>{currentUser=session?.user||null;if(currentUser)await afterSignedIn();else setStatus('Cloud: sign in needed','warn')});
  if(currentUser)await afterSignedIn();else setStatus('Cloud: sign in needed','warn');
}
init();
