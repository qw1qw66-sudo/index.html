import { describe, expect, it } from "vitest";
import { extractFunctionSource } from "./helpers/extract-inline.mjs";

// Drives the REAL backupBeforePush + docHash extracted from index.html against
// a fake localStorage, proving reverse-audit R-1 (failed-upload backup churn)
// is fixed without weakening real data-loss protection.
function makeHarness() {
  const src = extractFunctionSource("docHash") + "\n" + extractFunctionSource("backupBeforePush");
  const factory = new Function(
    "deps",
    `
    let { workspaceKey, state, lastCloudUpdatedAt, lastCloudCounts, localStorage, now, log } = deps;
    let lastBackupHash = "";
    ${src}
    return {
      backupBeforePush,
      docHash,
      setWorkspace: (k) => { workspaceKey = k; },
      setState: (s) => { state = s; },
    };
    `,
  );

  const store = new Map();
  let clock = 0;
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    get length() { return store.size; },
    key: (i) => Array.from(store.keys())[i] ?? null,
  };
  const api = factory({
    workspaceKey: "WSA",
    state: { chalets: [], bookings: [] },
    lastCloudUpdatedAt: "2026-01-01T00:00:00Z",
    lastCloudCounts: { chalets: 0, bookings: 0 },
    localStorage,
    // Unique increasing timestamp so distinct backups get distinct keys.
    now: () => `2026-01-01T00:00:${String(clock++).padStart(2, "0")}.000Z`,
    log: () => {},
  });
  const backupCount = () =>
    Array.from(store.keys()).filter((k) => k.indexOf("backup_before_cloud_push_") === 0).length;
  return { ...api, backupCount, store };
}

describe("4. backup ring deduplicates identical failed-upload backups", () => {
  it("a successful (first) backup is created", () => {
    const h = makeHarness();
    h.setState({ chalets: [{ id: "c1" }], bookings: [] });
    h.backupBeforePush();
    expect(h.backupCount()).toBe(1);
  });

  it("ten retries of the SAME document create at most one backup (no churn)", () => {
    const h = makeHarness();
    h.setState({ chalets: [{ id: "c1" }], bookings: [{ id: "b1" }] });
    for (let i = 0; i < 10; i++) h.backupBeforePush();
    expect(h.backupCount()).toBe(1);
  });

  it("different documents each still receive a distinct backup", () => {
    const h = makeHarness();
    h.setState({ chalets: [], bookings: [{ id: "b1" }] });
    h.backupBeforePush();
    h.setState({ chalets: [], bookings: [{ id: "b1" }, { id: "b2" }] });
    h.backupBeforePush();
    h.setState({ chalets: [], bookings: [{ id: "b1" }, { id: "b2" }, { id: "b3" }] });
    h.backupBeforePush();
    expect(h.backupCount()).toBe(3);
  });

  it("the ten-backup retention rule still holds across distinct documents", () => {
    const h = makeHarness();
    for (let i = 0; i < 15; i++) {
      h.setState({ chalets: [], bookings: Array.from({ length: i + 1 }, (_, j) => ({ id: "b" + j })) });
      h.backupBeforePush();
    }
    expect(h.backupCount()).toBe(10);
  });

  it("changing the workspace key produces a distinct backup (hash includes the key)", () => {
    const h = makeHarness();
    const doc = { chalets: [], bookings: [{ id: "b1" }] };
    h.setState(doc);
    h.backupBeforePush();
    h.setWorkspace("WSB");
    h.setState(doc);
    h.backupBeforePush();
    expect(h.backupCount()).toBe(2);
  });
});
