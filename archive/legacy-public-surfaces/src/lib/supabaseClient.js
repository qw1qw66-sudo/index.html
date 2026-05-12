import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

export function getSupabaseConfig() {
  return {
    url: window.CHALETS_SUPABASE_URL || window.VITE_SUPABASE_URL || '',
    anonKey: window.CHALETS_SUPABASE_ANON_KEY || window.VITE_SUPABASE_ANON_KEY || ''
  };
}

export function isSupabaseConfigured() {
  const { url, anonKey } = getSupabaseConfig();
  return Boolean(
    url &&
    anonKey &&
    !url.includes('YOUR_PROJECT') &&
    !anonKey.includes('YOUR_SUPABASE') &&
    !anonKey.includes('YOUR_')
  );
}

export function createSupabaseClient() {
  const { url, anonKey } = getSupabaseConfig();
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: localStorage
    }
  });
}
