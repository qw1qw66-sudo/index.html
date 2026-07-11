// chalet-setup-status — Supabase Edge Function (PREPARED, NOT DEPLOYED).
//
// Thin Deno wrapper: all logic is in handler.mjs (runtime-tested in Node/vitest).
// Browser-facing (called by the mobile setup page), so it uses the shared CORS
// allowlist. It reads ONLY the PRESENCE of secrets from the environment and
// returns booleans — it never reads, returns, logs, or fingerprints a value.
//
// Deploy (owner, staging first — NOT done by this branch):
//   supabase functions deploy chalet-setup-status

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleSetupStatus } from "./handler.mjs";
import { corsWrap } from "../_shared/cors.mjs";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

function makeDeps() {
  const env = Deno.env.toObject();
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  return {
    env,
    async auth(k: string, pin: string) {
      const { data } = await supabase.rpc("workspace_auth", { p_workspace_key: k, p_access_pin: pin }).single();
      return data ?? { ok: false, error_code: "AUTH_FAILED" };
    },
  };
}

Deno.serve((req: Request) => corsWrap(req, Deno.env.toObject(), () => handleSetupStatus(req, makeDeps())));
