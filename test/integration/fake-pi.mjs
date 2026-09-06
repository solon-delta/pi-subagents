#!/usr/bin/env node
// A fake pi executable. It records its arguments and its stdin, prints canned
// JSONL events, and exits with a chosen code. This is the single test seam.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

// The run log of the concurrency test. Each child writes one line when it
// starts and one line when it ends, and it holds the slot in between.
const log = process.env.FAKE_PI_LOG;
if (log !== undefined) appendFileSync(log, "start\n");
await setTimeout(Number(process.env.FAKE_PI_HOLD_MS ?? "0"));

const argvOut = process.env.FAKE_PI_ARGV_OUT;
if (argvOut !== undefined) writeFileSync(argvOut, JSON.stringify(process.argv.slice(2)));

// The nesting test reads the depth and the limit from here.
const envOut = process.env.FAKE_PI_ENV_OUT;
if (envOut !== undefined) writeFileSync(envOut, JSON.stringify(process.env));

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

// The stop test. The file says "ready" once the handler is up, and it says
// which signal arrived after that.
const signalOut = process.env.FAKE_PI_SIGNAL_OUT;
// The escalation test keeps the same child alive after the signal. Only
// SIGKILL ends that one.
if (signalOut !== undefined) {
  const stubborn = process.env.FAKE_PI_IGNORE_SIGTERM !== undefined;
  process.on("SIGTERM", () => {
    writeFileSync(signalOut, "SIGTERM");
    if (!stubborn) process.exit(143);
  });
  writeFileSync(signalOut, "ready");
}

// The child that never finishes. It has printed its events, so the stop test
// and the timeout test both find a transcript on disk. The wait is a timer,
// because node exits at once when nothing holds the event loop.
if (process.env.FAKE_PI_HANG !== undefined) await setTimeout(600_000);

if (log !== undefined) appendFileSync(log, "end\n");

const code = Number(process.env.FAKE_PI_EXIT ?? "0");
if (code !== 0) process.stderr.write("the fake child failed\n");
process.exit(code);
