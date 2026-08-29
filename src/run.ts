import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { AgentDefinition } from "./agent-file.ts";
import { childArguments, piExecutable } from "./child-command.ts";
import { assistantText, resultMessage, type RunRecord } from "./transcript.ts";

export interface RunOptions {
  agent: AgentDefinition;
  task: string;
  /** Working directory of the child. */
  cwd: string;
  /** Directory that holds one subdirectory per run. */
  runsDir: string;
  env: NodeJS.ProcessEnv;
}

export interface RunOutcome {
  record: RunRecord;
  /** The message that goes back into the parent conversation. */
  message: string;
}

export interface StartedRun {
  id: string;
  /** Directory with the transcript and the metadata record of this run. */
  dir: string;
  finished: Promise<RunOutcome>;
}

function writeRecord(dir: string, record: RunRecord): void {
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
}

/** Start a child pi process. Returns at once, without waiting for the child. */
export function startRun(options: RunOptions): StartedRun {
  const id = randomBytes(4).toString("hex");
  const dir = join(options.runsDir, id);
  mkdirSync(dir, { recursive: true });

  const record: RunRecord = {
    id,
    agent: options.agent.name,
    model: options.agent.model ?? null,
    startedAt: new Date().toISOString(),
    endedAt: undefined,
    status: "running",
  };
  writeRecord(dir, record);

  const transcript = join(dir, "transcript.jsonl");
  writeFileSync(transcript, "");

  const args = childArguments(options.agent);
  const child = spawn(piExecutable(options.env), args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // The task goes on stdin. See the comment on childArguments.
  child.stdin.on("error", () => {});
  child.stdin.end(options.task);

  const lines: string[] = [];
  const errors: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => errors.push(chunk));

  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    lines.push(line);
    appendFileSync(transcript, `${line}\n`);
  });

  const finished = new Promise<RunOutcome>((resolve) => {
    const finish = (ok: boolean, failure: string): RunOutcome => {
      record.endedAt = new Date().toISOString();
      record.status = ok ? "completed" : "failed";
      writeRecord(dir, record);
      const text = assistantText(lines);
      return { record, message: resultMessage(record, text === "" ? failure : text) };
    };

    // The reader flushes a last line without a newline when stdout ends, which
    // can be after the process itself is gone.
    const streamEnded = new Promise<void>((done) => reader.on("close", () => done()));

    child.on("error", (error) =>
      resolve(finish(false, `The child did not start: ${error.message}`)),
    );
    child.on("close", (code) => {
      streamEnded.then(() => resolve(finish(code === 0, errors.join("").trim())));
    });
  });

  return { id, dir, finished };
}
