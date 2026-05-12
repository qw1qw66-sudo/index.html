import { existsSync, mkdirSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const requiredFiles = [
  'index.html',
  'database/shared_workspace_sync.sql',
  '404.html',
  '.github/workflows/pages.yml'
];

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) throw new Error(`Missing required file: ${file}`);
}

const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const sql = readFileSync(resolve(root, 'database/shared_workspace_sync.sql'), 'utf8');
const page404 = readFileSync(resolve(root, '404.html'), 'utf8');
const workflow = readFileSync(resolve(root, '.github/workflows/pages.yml'), 'utf8');

const mustContain = [
  'lang="ar"',
  'dir="rtl"',
  'نظام حجوزات الشاليهات',
  'Debug Log',
  'DOMContentLoaded',
  'addEventListener',
  'get_shared_workspace',
  'save_shared_workspace',
  'canonicalEmptyDataModel',
  'fetch(',
  '/rest/v1/rpc/',
  'Pull button clicked',
  'Create empty workspace button clicked',
  'app shell remains closed'
];
for (const text of mustContain) {
  if (!indexHtml.includes(text)) throw new Error(`index.html missing required text: ${text}`);
}

const forbiddenIndex = [
  'onclick=',
  'onchange=',
  'onsubmit=',
  'serviceWorker',
  'manifest.webmanifest',
  'supabase-js',
  'createClient',
  'location.replace',
  'http-equiv="refresh"',
  '<script src=',
  '<link rel="stylesheet"',
  'setInterval(',
  'localStorage',
  'indexedDB'
];
for (const text of forbiddenIndex) {
  if (indexHtml.includes(text)) throw new Error(`Forbidden root index text found: ${text}`);
}

if (!sql.includes('pin_hash')) throw new Error('SQL must store pin_hash');
if (!sql.includes('crypt(')) throw new Error('SQL must use pgcrypto crypt');
if (!sql.includes('security definer')) throw new Error('RPC must use security definer');
if (!sql.includes('set search_path = public')) throw new Error('RPC must set search_path');
if (!sql.includes('revoke all on table public.shared_workspaces from anon')) throw new Error('SQL must revoke direct anon table access');
if (!sql.includes('grant execute on function public.get_shared_workspace')) throw new Error('SQL must grant get RPC execute');
if (!sql.includes('grant execute on function public.save_shared_workspace')) throw new Error('SQL must grant save RPC execute');

if (page404.includes('http-equiv="refresh"') || page404.includes('location.replace') || page404.includes('localStorage')) {
  throw new Error('404 must not redirect or scan localStorage');
}

if (!workflow.includes('cp index.html dist/index.html')) throw new Error('Pages workflow must copy root index into dist');
if (!workflow.includes('cp 404.html dist/404.html')) throw new Error('Pages workflow must copy 404 alongside index');
if (workflow.includes('cp -R app') || workflow.includes('cp app-release') || workflow.includes('cp clean.html') || workflow.includes('cp stable.html') || workflow.includes('cp sync-cloud')) {
  throw new Error('Pages workflow must not copy old public surfaces');
}
if (!workflow.includes('path: dist')) throw new Error('Pages workflow must upload dist only');

rmSync(resolve(root, 'dist'), { recursive: true, force: true });
mkdirSync(resolve(root, 'dist'), { recursive: true });
cpSync(resolve(root, 'index.html'), resolve(root, 'dist/index.html'));
cpSync(resolve(root, '404.html'), resolve(root, 'dist/404.html'));
const forbiddenDist = [
  'app',
  'app.html',
  'cloud.html',
  'clean.html',
  'stable.html',
  'app-release',
  'sync-cloud',
  'sync-v6',
  'archive',
  'manifest.webmanifest',
  'sw.js',
  'chalets-cloud-sync.js',
  'chalets-supabase-config.js'
];
for (const item of forbiddenDist) {
  if (existsSync(resolve(root, 'dist', item))) throw new Error(`Forbidden deployed artifact item exists: ${item}`);
}

console.log('Static build check passed for clean root /index.html surface');
