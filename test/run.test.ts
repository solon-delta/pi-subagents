import assert from "node:assert/strict";
import { test } from "node:test";

import { resultMessage } from "../src/run.ts";

test("the result message names the agent, the run id and the status", () => {
  const message = resultMessage(
    {
      id: "a1b2c3d4",
      agent: "reviewer",
      model: "m",
      queuedAt: "q",
      startedAt: "s",
      endedAt: "e",
      status: "completed",
    },
    "The diff is fine.",
  );

  assert.match(message, /reviewer/);
  assert.match(message, /a1b2c3d4/);
  assert.match(message, /completed/);
  assert.match(message, /The diff is fine\./);
});

test("a failed run says so", () => {
  const message = resultMessage(
    {
      id: "a1b2c3d4",
      agent: "reviewer",
      model: "m",
      queuedAt: "q",
      startedAt: "s",
      endedAt: "e",
      status: "failed",
    },
    "",
  );

  assert.match(message, /failed/);
});
