import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createRunRecord,
  type RunFacts,
  type RunRecord,
  readRunRecords,
} from "../src/run-record.ts";

const facts: RunFacts = {
  id: "a1b2c3d4",
  agent: "reviewer",
  model: "anthropic/claude-sonnet-5",
  depth: 1,
  removedTools: ["bash"],
};

/** A new record in its own directory. No test here starts a process. */
function newRecord() {
  const dir = mkdtempSync(join(tmpdir(), "record-"));
  return { dir, run: createRunRecord(dir, facts) };
}

/** The record as the file holds it, and not as the object holds it. */
function onDisk(dir: string): RunRecord {
  return JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
}

test("a new record is queued on disk and carries every fact", () => {
  const { dir, run } = newRecord();

  const file = onDisk(dir);
  assert.equal(file.status, "queued");
  assert.equal(file.id, "a1b2c3d4");
  assert.equal(file.agent, "reviewer");
  assert.equal(file.model, "anthropic/claude-sonnet-5");
  assert.equal(file.depth, 1);
  assert.deepEqual(file.removedTools, ["bash"]);
  assert.ok(file.queuedAt.length > 0);
  assert.equal(file.startedAt, undefined);
  assert.equal(file.endedAt, undefined);
  assert.equal(run.live, true);
});

test("a start makes the run running and stamps the start time", () => {
  const { dir, run } = newRecord();

  run.start();

  assert.equal(onDisk(dir).status, "running");
  assert.ok(onDisk(dir).startedAt);
  assert.equal(onDisk(dir).endedAt, undefined);
  assert.equal(run.live, true);
});

test("a second start changes nothing", () => {
  const { dir, run } = newRecord();

  run.start();
  const first = onDisk(dir).startedAt;
  run.start();

  assert.equal(onDisk(dir).startedAt, first);
});

test("a stop of a queued run ends it, because it has no child", () => {
  const { dir, run } = newRecord();

  run.kill("stopped");

  assert.equal(onDisk(dir).status, "stopped");
  assert.ok(onDisk(dir).endedAt);
  assert.equal(onDisk(dir).startedAt, undefined);
  assert.equal(run.live, false);
});

test("a stop of a running run writes the status before the child is gone", () => {
  const { dir, run } = newRecord();

  run.start();
  run.kill("stopped");

  // The pi session does not wait for the child, so the status must be on disk
  // now. The end time comes with the second write.
  assert.equal(onDisk(dir).status, "stopped");
  assert.equal(onDisk(dir).endedAt, undefined);
  assert.equal(run.live, false);
});

test("the close of a killed child stamps the end time and keeps the status", () => {
  const { dir, run } = newRecord();

  run.start();
  run.kill("failed");
  run.close(true);

  assert.equal(onDisk(dir).status, "failed");
  assert.ok(onDisk(dir).endedAt);
});

test("a child that closes well completes the run", () => {
  const { dir, run } = newRecord();

  run.start();
  run.close(true);

  assert.equal(onDisk(dir).status, "completed");
  assert.ok(onDisk(dir).endedAt);
  assert.equal(run.live, false);
});

test("a child that closes badly fails the run", () => {
  const { dir, run } = newRecord();

  run.start();
  run.close(false);

  assert.equal(onDisk(dir).status, "failed");
});

test("an ended run takes no more events", () => {
  const { dir, run } = newRecord();

  run.start();
  run.close(true);
  const ended = onDisk(dir);
  run.kill("stopped");
  run.close(false);
  run.start();

  assert.deepEqual(onDisk(dir), ended);
});

test("a second stop of a killed run changes nothing", () => {
  const { dir, run } = newRecord();

  run.start();
  run.kill("stopped");
  const killed = onDisk(dir);
  run.kill("failed");

  assert.deepEqual(onDisk(dir), killed);
});

/** A runs directory, and a writer that puts one run.json under it by hand. */
function newRunsDir() {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const write = (id: string, text: string | undefined): void => {
    mkdirSync(join(runsDir, id));
    if (text !== undefined) writeFileSync(join(runsDir, id, "run.json"), text);
  };
  const record = (id: string, queuedAt: string): string =>
    JSON.stringify({ ...facts, id, queuedAt, status: "completed" });
  return { runsDir, write, record };
}

test("readRunRecords reads every run directory, oldest first", () => {
  const { runsDir, write, record } = newRunsDir();
  write("bbbb", record("bbbb", "2026-01-02T00:00:00.000Z"));
  write("aaaa", record("aaaa", "2026-01-01T00:00:00.000Z"));

  const records = readRunRecords(runsDir);

  assert.deepEqual(
    records.map((found) => found.id),
    ["aaaa", "bbbb"],
  );
  assert.equal(records[0].status, "completed");
  assert.equal(records[0].startedAt, undefined);
});

test("a written record reads back through readRunRecords", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const dir = join(runsDir, facts.id);
  mkdirSync(dir);
  createRunRecord(dir, facts).start();

  const records = readRunRecords(runsDir);

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], onDisk(dir));
});

test("a directory without a readable record drops out", () => {
  const { runsDir, write, record } = newRunsDir();
  write("good", record("good", "2026-01-01T00:00:00.000Z"));
  write("none", undefined);
  write("junk", "{ not json");
  // A file of an earlier version that carries less than the schema asks for.
  write("thin", JSON.stringify({ id: "thin", agent: "reviewer", status: "completed" }));
  // A status that this version does not know.
  write("odd", JSON.stringify({ ...facts, id: "odd", queuedAt: "2026", status: "paused" }));

  assert.deepEqual(
    readRunRecords(runsDir).map((found) => found.id),
    ["good"],
  );
});

test("a missing runs directory gives no record", () => {
  assert.deepEqual(readRunRecords(join(tmpdir(), "no-such-runs-directory")), []);
});
