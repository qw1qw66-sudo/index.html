import { existsSync, mkdirSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const requiredFiles = [
  'app/index.html',
  'app/manifest.webmanifest',
  'app/icons/icon.svg',
  'app/icons/apple-touch-icon.png',
  'database/shared_workspace_sync.sql',
  '404.html',
  '.github/workflows/pages.yml'
];

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) throw new Error(`Missing required file: ${file}`);
}

const appHtml = readFileSync(resolve(root, 'app/index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(root, 'app/manifest.webmanifest'), 'utf8'));
const sql = readFileSync(resolve(root, 'database/shared_workspace_sync.sql'), 'utf8');
const page404 = readFileSync(resolve(root, '404.html'), 'utf8');
const workflow = readFileSync(resolve(root, '.github/workflows/pages.yml'), 'utf8');

const mustContain = [
  'lang="ar"',
  'dir="rtl"',
  'viewport-fit=cover',
  'apple-mobile-web-app-capable',
  '/app/manifest.webmanifest',
  '/app/icons/apple-touch-icon.png',
  'Asia/Riyadh',
  'get_shared_workspace',
  'save_shared_workspace',
  'backup_before_cloud_push_',
  'تم إيقاف الرفع: البيانات المحلية فارغة وستحذف بيانات السحابة.',
  'أؤكد استبدال بيانات السحابة',
  'توجد نسخة أحدث في السحابة',
  'navigator.share',
  'navigator.clipboard.writeText'
];
for (const text of mustContain) {
  if (!appHtml.includes(text)) throw new Error(`app/index.html missing required text: ${text}`);
}

const forbiddenApp = [
  'signInWithOtp',
  'email@example.com',
  'Magic Link',
  'SMTP',
  'auth.uid',
  'auth.getSession',
  '.from(\'chalets\')',
  '.from("chalets")',
  'app_settings',
  'sync_log',
  'setInterval(',
  'visibilitychange',
  'Realtime',
  'localStorage.length',
  'adopt',
  'restore',
  'recovery'
];
for (const text of forbiddenApp) {
  if (appHtml.includes(text)) throw new Error(`Forbidden production app text found: ${text}`);
}

if (manifest.start_url !== '/app/') throw new Error('Manifest start_url must be /app/');
if (manifest.scope !== '/app/') throw new Error('Manifest scope must be /app/');
if (page404.includes('http-equiv="refresh"') || page404.includes('location.replace') || page404.includes('localStorage')) {
  throw new Error('404 must not redirect or scan localStorage');
}
if (!page404.includes('/app/')) throw new Error('404 must link to /app/');
if (!sql.includes('shared_workspaces')) throw new Error('SQL must create shared_workspaces');
if (!sql.includes('security definer')) throw new Error('RPC must use security definer');
if (!sql.includes('revoke all on public.shared_workspaces from anon')) throw new Error('SQL must revoke direct anon table access');
if (!sql.includes('grant execute on function public.get_shared_workspace')) throw new Error('SQL must grant RPC execute');
if (!workflow.includes('cp -R app/* dist/app/')) throw new Error('Pages workflow must copy app into dist/app');
if (!workflow.includes('path: dist')) throw new Error('Pages workflow must upload dist only');

rmSync(resolve(root, 'dist'), { recursive: true, force: true });
mkdirSync(resolve(root, 'dist/app'), { recursive: true });
cpSync(resolve(root, 'app'), resolve(root, 'dist/app'), { recursive: true });
cpSync(resolve(root, '404.html'), resolve(root, 'dist/404.html'));
const forbiddenDist = ['app.html', 'cloud.html', 'sync-cloud', 'sync-v6', 'archive'];
for (const item of forbiddenDist) {
  if (existsSync(resolve(root, 'dist', item))) throw new Error(`Forbidden deployed artifact item exists: ${item}`);
}

console.log('Static build check passed for canonical /app/ surface');
