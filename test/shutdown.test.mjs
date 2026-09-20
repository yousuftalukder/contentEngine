import { test } from "node:test";
import assert from "node:assert/strict";
import { startEngine, waitFor } from "./harness.mjs";

// Render sends SIGTERM before it replaces an instance or spins one down. Whatever the worker was running at that moment
// must go back to the queue at once, not sit RUNNING until the stale-lock sweep gives up on it three quarters of an hour
// later — after every deploy that froze a lane for most of an hour. Windows has no SIGTERM to deliver, so this runs
// where the engine actually lives.
test("a worker told to stop hands its running jobs back to the queue", { skip: process.platform === "win32" && "no SIGTERM on Windows" }, async () => {
  const eng = await startEngine();
  try {
    const { worker } = await eng.api("GET", "/health");
    await eng.query(`INSERT INTO jobs (id, type, status, payload, queue, locked_by, locked_at, attempts) VALUES ('held-1', 'INGEST_SOURCE', 'RUNNING', '{}', 'ingest', $1, now(), 1)`, [worker]);
    await eng.query(`INSERT INTO jobs (id, type, status, payload, queue, locked_by, locked_at, attempts) VALUES ('held-2', 'INGEST_SOURCE', 'RUNNING', '{}', 'ingest', 'another-worker', now(), 1)`);

    process.kill(eng.pid, "SIGTERM");
    const mine = await waitFor(async () => { const [j] = await eng.query(`SELECT status, locked_by, attempts FROM jobs WHERE id='held-1'`); return j.status === "PENDING" && j; }, { timeout: 15000, what: "the job to be handed back" });
    assert.equal(mine.locked_by, null);
    assert.equal(mine.attempts, 0, "the interrupted attempt is not charged against the job");
    const [theirs] = await eng.query(`SELECT status, locked_by FROM jobs WHERE id='held-2'`);
    assert.equal(theirs.status, "RUNNING", "another worker's job is not touched");
  } finally { await eng.stop(); }
});
