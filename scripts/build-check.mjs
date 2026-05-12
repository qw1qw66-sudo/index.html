import { existsSync, mkdirSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const root=process.cwd();
for(const file of ['index.html','database/shared_workspace_sync.sql','404.html','.github/workflows/pages.yml']){if(!existsSync(resolve(root,file)))throw new Error(`Missing ${file}`);}
for(const item of ['app','app.html','cloud.html','clean.html','stable.html','app-release','sync-cloud','manifest.webmanifest','sw.js']){if(existsSync(resolve(root,item)))throw new Error(`Forbidden public surface exists: ${item}`);}
const html=readFileSync(resolve(root,'index.html'),'utf8');
for(const text of ['dir="rtl"','نظام حجوزات الشاليهات','get_shared_workspace','save_shared_workspace','يوجد حجز مؤكد متعارض في نفس الشاليه والفترة.','navigator.share','backup_before_cloud_push_','lastCloudCounts','lastCloudUpdatedAt','البيانات غير كافية لحكم دقيق.','رفع التعديلات']){if(!html.includes(text))throw new Error(`index.html missing ${text}`);}
for(const text of ['onclick=','<script src=','<link rel="stylesheet"','serviceWorker','manifest.webmanifest','supabase-js','createClient','location.replace','http-equiv="refresh"']){if(html.includes(text))throw new Error(`Forbidden index text found: ${text}`);}
const workflow=readFileSync(resolve(root,'.github/workflows/pages.yml'),'utf8');
if(!workflow.includes('cp index.html dist/index.html'))throw new Error('workflow must deploy root index only');
rmSync(resolve(root,'dist'),{recursive:true,force:true});mkdirSync(resolve(root,'dist'),{recursive:true});cpSync(resolve(root,'index.html'),resolve(root,'dist/index.html'));cpSync(resolve(root,'404.html'),resolve(root,'dist/404.html'));
for(const item of ['app','archive','app-release','sync-cloud','manifest.webmanifest','sw.js']){if(existsSync(resolve(root,'dist',item)))throw new Error(`Forbidden dist item exists: ${item}`);}
console.log('Static build check passed for conflict prevention, voucher, reports, and safe upload');
