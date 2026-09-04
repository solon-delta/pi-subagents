import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunStatus } from "../src/run-record.ts";
import { statusLine } from "../src/status-line.ts";

test("no run leaves the line away", () => {
  assert.equal(statusLine([]), undefined);
});

test("a finished run alone leaves the line away", () => {
  assert.equal(statusLine(["completed", "failed", "stopped"]), undefined);
});

test("a queued run counts as work", () => {
  assert.equal(statusLine(["queued"]), "subagents: 1 working, 0 done");
});

test("mixed states count the working runs and the finished runs", () => {
  const states: RunStatus[] = ["running", "queued", "completed", "failed", "stopped"];

  assert.equal(statusLine(states), "subagents: 2 working, 3 done");
});

test("the line stays on one row of a narrow terminal", () => {
  const states: RunStatus[] = Array.from({ length: 40 }, () => "running");
  const line = statusLine([...states, "completed"]);

  assert.equal(line, "subagents: 40 working, 1 done");
  assert.ok(line !== undefined && line.length <= 40);
  assert.ok(line !== undefined && !line.includes("\n"));
});
