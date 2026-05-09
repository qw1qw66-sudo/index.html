const fs = require('fs');

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.CHALETS_SUPABASE_URL || '';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.CHALETS_SUPABASE_ANON_KEY || '';

const content = `// Generated during Netlify build. Do not put service_role keys here.\nwindow.CHALETS_SUPABASE_URL = ${JSON.stringify(supabaseUrl)};\nwindow.CHALETS_SUPABASE_ANON_KEY = ${JSON.stringify(supabaseAnonKey)};\nwindow.VITE_SUPABASE_URL = window.CHALETS_SUPABASE_URL;\nwindow.VITE_SUPABASE_ANON_KEY = window.CHALETS_SUPABASE_ANON_KEY;\n`;

fs.writeFileSync('chalets-supabase-config.js', content);
console.log('Generated chalets-supabase-config.js');
