-- 20260711000005_payment_reads_volatile.sql
--
-- HOTFIX. get_booking_payments (and, defensively, get_booking_payment_summary)
-- were declared STABLE, but the auth path writes: workspace_auth clears or
-- records PIN-throttle rows. PostgREST executes STABLE RPCs inside a READ-ONLY
-- transaction, so on the real project every call failed with a read-only
-- violation (surfacing as PAYMENT_CHECK_FAILED in the assistant's fail-closed
-- cancellation). Plain SQL sessions are read-write, which is why psql-based
-- tests never reproduced it.
--
-- Correct classification: VOLATILE. No logic changes. Idempotent.

begin;

alter function public.get_booking_payments(text, text, text) volatile;
alter function public.get_booking_payment_summary(text, text) volatile;

notify pgrst, 'reload schema';

commit;

-- ============================================================================
-- ROLLBACK (manual)
-- ============================================================================
-- alter function public.get_booking_payments(text, text, text) stable;
-- alter function public.get_booking_payment_summary(text, text) stable;
-- (Rolling back re-breaks ledger reads through PostgREST; do not do it there.)
