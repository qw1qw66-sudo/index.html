import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const requiredFiles = [
  'app.html',
  'src/main.js',
  'manifest.webmanifest',
  'chalets-supabase-config.js',
  'sync-cloud/index.html'
];

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) {
    throw new Error(`Missing required file: ${file}`);
  }
}

JSON.parse(readFileSync(resolve(root, 'manifest.webmanifest'), 'utf8'));

for (const file of ['src/main.js', 'chalets-supabase-config.js']) {
  const source = readFileSync(resolve(root, file), 'utf8');
  new vm.Script(source, { filename: file });
}

const appHtml = readFileSync(resolve(root, 'app.html'), 'utf8');
const requiredIds = [
  'saveBooking', 'bookingSheet', 'bkName', 'bkPhone', 'bkChalet', 'bkIn', 'bkOut',
  'bkGuests', 'bkTotal', 'bkPaid', 'bkStatus', 'bkNotes', 'syncNow', 'sendLogin'
];
for (const id of requiredIds) {
  if (!appHtml.includes(`id="${id}"`)) {
    throw new Error(`app.html is missing required id: ${id}`);
  }
}

if (!appHtml.includes('manifest.webmanifest')) throw new Error('PWA manifest link missing');
if (!appHtml.includes('@supabase/supabase-js@2')) throw new Error('Supabase client import missing');

console.log('Static build check passed');
