#!/usr/bin/env node
// A fake pi executable. It records its arguments and its stdin, prints canned
// JSONL events, and exits with a chosen code. This is the single test seam.
import { readFileSync, writeFileSync } from "node:fs";

const argvOut = process.env.FAKE_PI_ARGV_OUT;
if (argvOut !== undefined) writeFileSync(argvOut, JSON.stringify(process.argv.slice(2)));

const stdinOut = process.env.FAKE_PI_STDIN_OUT;
if (stdinOut !== undefined) writeFileSync(stdinOut, readFileSync(0, "utf8"));

const answer = process.env.FAKE_PI_ANSWER ?? "The task is done.";
const events = [
  { type: "session", version: 3, id: "fake", cwd: process.cwd() },
  { type: "agent_start" },
  {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: answer }] },
  },
  { type: "agent_end" },
];
for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);

const code = Number(process.env.FAKE_PI_EXIT ?? "0");
if (code !== 0) process.stderr.write("the fake child failed\n");
process.exit(code);
