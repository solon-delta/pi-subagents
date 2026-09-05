import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createTranscript, parseTranscript, readTranscript } from "../src/transcript.ts";

function messageEnd(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/** A transcript in a fresh directory, and the path of its file. */
function open() {
  const dir = mkdtempSync(join(tmpdir(), "transcript-"));
  return { transcript: createTranscript(dir), file: join(dir, "transcript.jsonl") };
}

/** Feed every line of a stream and read the answer. */
function answerOf(lines: string[]): string {
  const { transcript } = open();
  for (const line of lines) transcript.line(line);
  return transcript.answer();
}

test("the text of the last assistant message is the answer", () => {
  const text = answerOf([
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

  assert.equal(answerOf([line]), "answer");
});

test("a line that is not JSON is ignored", () => {
  assert.equal(answerOf(["not json", messageEnd("answer")]), "answer");
});

test("a stream without an assistant message has no answer", () => {
  assert.equal(answerOf([JSON.stringify({ type: "agent_start" })]), "");
});

test("a new transcript is an empty file", () => {
  const { file } = open();

  assert.equal(readFileSync(file, "utf8"), "");
});

test("every line reaches the file, including a line that is not JSON", () => {
  const { transcript, file } = open();

  transcript.line("not json");
  transcript.line(messageEnd("answer"));

  assert.equal(readFileSync(file, "utf8"), `not json\n${messageEnd("answer")}\n`);
});

test("the reader gives one row per line of every assistant message", () => {
  const read = parseTranscript(`${messageEnd("first\nsecond")}\n${messageEnd("third")}\n`);

  assert.deepEqual(read.rows, ["first", "second", "", "third"]);
});

test("the first user message is the task and stays out of the rows", () => {
  const task = JSON.stringify({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: "the task" }] },
  });

  const read = parseTranscript(`${task}\n${messageEnd("the answer")}\n`);

  assert.equal(read.task, "the task");
  assert.deepEqual(read.rows, ["the answer"]);
});

test("a user message of plain text is a task too", () => {
  const task = JSON.stringify({ type: "message_end", message: { role: "user", content: "do it" } });

  assert.equal(parseTranscript(task).task, "do it");
});

test("the task of a run that printed nothing is empty", () => {
  assert.equal(parseTranscript("").task, "");
});

test("the reader names a tool call and drops a thinking part", () => {
  const line = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "toolCall", id: "1", name: "read", arguments: {} },
      ],
    },
  });

  assert.deepEqual(parseTranscript(line).rows, ["[tool read]"]);
});

test("a run that printed nothing has no row", () => {
  assert.deepEqual(parseTranscript("").rows, []);
  assert.deepEqual(parseTranscript(`${JSON.stringify({ type: "agent_start" })}\n`).rows, []);
});

test("readTranscript of a run without a file gives no row", () => {
  assert.deepEqual(readTranscript(mkdtempSync(join(tmpdir(), "transcript-"))), {
    task: "",
    rows: [],
  });
});

test("readTranscript reads the file that the writer made", () => {
  const dir = mkdtempSync(join(tmpdir(), "transcript-"));
  const transcript = createTranscript(dir);

  transcript.line(messageEnd("the answer"));

  assert.deepEqual(readTranscript(dir).rows, ["the answer"]);
});
