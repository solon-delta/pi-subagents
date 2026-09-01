import assert from "node:assert/strict";
import { test } from "node:test";

import { assistantText, resultMessage } from "../src/transcript.ts";

function messageEnd(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

test("the text of the last assistant message is the answer", () => {
  const text = assistantText([
    JSON.stringify({ type: "agent_start" }),
    messageEnd("first"),
    messageEnd("second"),
  ]);

  assert.equal(text, "second");
});

test("thinking and tool call parts are left out", () => {
  const line = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
      ],
    },
  });

  assert.equal(assistantText([line]), "answer");
});

test("a line that is not JSON is ignored", () => {
  assert.equal(assistantText(["not json", messageEnd("answer")]), "answer");
});

test("a stream without an assistant message has no answer", () => {
  assert.equal(assistantText([JSON.stringify({ type: "agent_start" })]), "");
});

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
