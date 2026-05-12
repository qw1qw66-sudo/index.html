import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const requiredFiles = [
  'app.html',
  'manifest.webmanifest',
  'sw.js',
  'sync-cloud/final.html'
];

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) {
    throw new Error(`Missing required file: ${file}`);
  }
}

JSON.parse(readFileSync(resolve(root, 'manifest.webmanifest'), 'utf8'));

for (const file of ['sw.js']) {
  const source = readFileSync(resolve(root, file), 'utf8');
  new vm.Script(source, { filename: file });
}

const appHtml = readFileSync(resolve(root, 'app.html'), 'utf8');
if (!appHtml.includes('sync-cloud/final.html')) throw new Error('app.html must redirect to sync-cloud/final.html');

const finalHtml = readFileSync(resolve(root, 'sync-cloud/final.html'), 'utf8');
const requiredIds = [
  'workspaceKey', 'accessPin', 'connectBtn', 'appView', 'pushBtn',
  'chaletSheet', 'bookingSheet', 'bkName', 'bkPhone', 'bkChalet', 'bkDate',
  'bkPeriod', 'bkGuests', 'bkTotal', 'bkPaid', 'bkStatus', 'bkNotes'
];
for (const id of requiredIds) {
  if (!finalHtml.includes(`id="${id}"`)) {
    throw new Error(`sync-cloud/final.html is missing required id: ${id}`);
  }
}

const forbidden = [
  'email@example.com',
  'إرسال رابط الدخول',
  'Magic Link',
  'Supabase URL',
  'استرجاع ومزامنة',
  'شاليه الواحة',
  'شاليه الياسمين'
];
for (const text of forbidden) {
  if (finalHtml.includes(text)) {
    throw new Error(`Forbidden legacy/seed text found in final app: ${text}`);
  }
}

if (!finalHtml.includes('get_shared_workspace')) throw new Error('Final app must call get_shared_workspace RPC');
if (!finalHtml.includes('save_shared_workspace')) throw new Error('Final app must call save_shared_workspace RPC');
if (!finalHtml.includes('تم منع رفع نسخة فارغة')) throw new Error('Empty overwrite guard text missing');
if (!finalHtml.includes('لا يتم الرفع عند فتح التطبيق')) throw new Error('No-auto-push safety message missing');

console.log('Static build check passed for final sync-cloud app');
