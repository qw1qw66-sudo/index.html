-- 20260711000004_pgcrypto_search_path.sql
--
-- HOTFIX. On the real Supabase project pgcrypto lives in the `extensions`
-- schema, so the PIN-hashing functions — pinned to `search_path = public` by
-- the baseline/0001 — cannot resolve crypt()/gen_salt() and every real login
-- fails with SQLSTATE 42883 ("function gen_salt(unknown, integer) does not
-- exist"). Local/scratch PostgreSQL installs pgcrypto INTO public, which is
-- why CI and the integration tests never reproduced this.
--
-- Fix: append `extensions` to the search path of exactly the five functions
-- that hash or verify a PIN. Postgres tolerates a missing schema in a
-- search_path, so this is also a no-op on scratch databases where pgcrypto
-- is in public and no `extensions` schema exists. Idempotent (SET overwrites).

begin;

alter function public.get_shared_workspace(text, text)
  set search_path = public, extensions;
alter function public.save_shared_workspace(text, text, jsonb)
  set search_path = public, extensions;
alter function public.create_shared_workspace(text, text, jsonb)
  set search_path = public, extensions;
alter function public.workspace_auth(text, text)
  set search_path = public, extensions;
alter function public.save_shared_workspace_v2(text, text, jsonb, timestamptz)
  set search_path = public, extensions;

notify pgrst, 'reload schema';

commit;

-- ============================================================================
-- ROLLBACK (manual)
-- ============================================================================
-- alter function public.get_shared_workspace(text, text) set search_path = public;
-- alter function public.save_shared_workspace(text, text, jsonb) set search_path = public;
-- alter function public.create_shared_workspace(text, text, jsonb) set search_path = public;
-- alter function public.workspace_auth(text, text) set search_path = public;
-- alter function public.save_shared_workspace_v2(text, text, jsonb, timestamptz) set search_path = public;
-- (Rolling back re-breaks PIN verification on Supabase; do not do it there.)
