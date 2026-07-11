import { describe, expect, it } from "vitest";

// Compare-and-save semantics of save_shared_workspace_v2
// (supabase/migrations/20260701000001). The SQL itself was verified against a real
// PostgreSQL 16 instance (32-scenario smoke suite — see the PR notes); this
// model mirrors those verified semantics so the multi-device protocol
// outcomes stay pinned in fast unit tests.
class CasWorkspaceServer {
  constructor(doc) {
    this.doc = doc;
    this.revision = 1; // stands in for updated_at
  }
  pull() {
    return { data: structuredClone(this.doc), revision: this.revision };
  }
  saveV2(data, expectedRevision, validateDoc) {
    if (expectedRevision !== this.revision) {
      return { ok: false, error: "STALE_REVISION", current: this.revision };
    }
    const conflict = validateDoc ? validateDoc(data) : null;
    if (conflict) return { ok: false, error: conflict };
    this.doc = structuredClone(data);
    this.revision += 1;
    return { ok: true, revision: this.revision };
  }
}

// Same overlap rule as the app's findConflict and the SQL
// workspace_doc_booking_conflict: confirmed + not deleted + same chalet +
// interval overlap.
function docBookingConflict(data) {
  const bookings = (data.bookings || []).filter(
    (b) => b.status === "confirmed" && !b.deleted_at,
  );
  for (let i = 0; i < bookings.length; i++) {
    for (let j = i + 1; j < bookings.length; j++) {
      const a = bookings[i];
      const b = bookings[j];
      if (a.chalet_id !== b.chalet_id || a.id === b.id) continue;
      if (a.booking_date === b.booking_date && a.period_id === b.period_id) {
        return `BOOKING_CONFLICT:${a.id}:${b.id}`;
      }
    }
  }
  return null;
}

const bookingFor = (id, over = {}) => ({
  id,
  chalet_id: "ch-1",
  booking_date: "2099-06-01",
  period_id: "p-1",
  status: "confirmed",
  deleted_at: null,
  paid: 0,
  total: 900,
  ...over,
});

describe("17. concurrent workspace edits (atomic compare-and-save)", () => {
  it("the second stale writer is rejected instead of silently deleting the first writer's booking", () => {
    const server = new CasWorkspaceServer({ bookings: [] });

    // Both devices pull the same revision.
    const deviceA = server.pull();
    const deviceB = server.pull();

    // A adds booking α and saves first.
    deviceA.data.bookings.push(bookingFor("booking-alpha"));
    const saveA = server.saveV2(deviceA.data, deviceA.revision, docBookingConflict);
    expect(saveA.ok).toBe(true);

    // B adds a different booking β (different period) and saves with the
    // now-stale revision: with the OLD v1 flow this overwrote the document
    // and silently deleted α (audit AUD-002). With v2 it is rejected.
    deviceB.data.bookings.push(bookingFor("booking-beta", { period_id: "p-2" }));
    const saveB = server.saveV2(deviceB.data, deviceB.revision, docBookingConflict);
    expect(saveB).toMatchObject({ ok: false, error: "STALE_REVISION" });

    // α survived; B re-pulls, re-applies β on fresh state, and succeeds.
    const fresh = server.pull();
    expect(fresh.data.bookings.map((b) => b.id)).toEqual(["booking-alpha"]);
    fresh.data.bookings.push(bookingFor("booking-beta", { period_id: "p-2" }));
    const retry = server.saveV2(fresh.data, fresh.revision, docBookingConflict);
    expect(retry.ok).toBe(true);
    expect(server.doc.bookings).toHaveLength(2);
  });
});

describe("18. two clients attempting the same booking period", () => {
  it("cannot both land a confirmed booking for the same chalet/date/period", () => {
    const server = new CasWorkspaceServer({ bookings: [] });
    const deviceA = server.pull();
    const deviceB = server.pull();

    deviceA.data.bookings.push(bookingFor("booking-a"));
    expect(server.saveV2(deviceA.data, deviceA.revision, docBookingConflict).ok).toBe(true);

    // Same slot on device B. Stale save -> rejected (not lost, not doubled).
    deviceB.data.bookings.push(bookingFor("booking-b"));
    expect(server.saveV2(deviceB.data, deviceB.revision, docBookingConflict))
      .toMatchObject({ ok: false, error: "STALE_REVISION" });

    // Even if B blindly re-submits the same conflicting slot on the fresh
    // revision, the document-level validation rejects the save.
    const fresh = server.pull();
    fresh.data.bookings.push(bookingFor("booking-b"));
    const retry = server.saveV2(fresh.data, fresh.revision, docBookingConflict);
    expect(retry.ok).toBe(false);
    expect(retry.error).toBe("BOOKING_CONFLICT:booking-a:booking-b");

    // The cloud never contained two conflicting confirmed bookings.
    expect(server.doc.bookings.map((b) => b.id)).toEqual(["booking-a"]);
  });
});
