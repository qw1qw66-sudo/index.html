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
