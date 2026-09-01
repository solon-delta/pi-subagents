import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { AgentDefinition } from "./agent-file.ts";
import { toolArguments } from "./tools.ts";
import { assistantText } from "./transcript.ts";

export type RunStatus = "completed" | "failed" | "queued" | "running" | "stopped";

export interface RunRecord {
  id: string;
  agent: string;
  /** The model of the agent file, or null when the agent file names none. */
  model: string | null;
  /** ISO timestamps. A queued run has no start time and no end time. */
  queuedAt: string;
  startedAt: string | undefined;
  endedAt: string | undefined;
  status: RunStatus;
}

/** The message that carries a finished run back into the parent conversation. */
export function resultMessage(record: RunRecord, text: string): string {
  const head = `Subagent "${record.agent}" (run ${record.id}) ${record.status}.`;
  return text === "" ? head : `${head}\n\n${text}`;
}

export interface RunOptions {
  agent: AgentDefinition;
  task: string;
  /** Working directory of the child. */
  cwd: string;
  /** Directory that holds one subdirectory per run. */
  runsDir: string;
  env: NodeJS.ProcessEnv;
  /** Wall clock limit in milliseconds. Zero means that the run has no limit. */
  timeoutMs: number;
}

export interface RunOutcome {
  record: RunRecord;
  /** The message that goes back into the parent conversation. */
  message: string;
}

export interface PreparedRun {
  id: string;
  /** Directory with the transcript and the metadata record of this run. */
  dir: string;
  record: RunRecord;
  options: RunOptions;
  /** The command line of the child, without the executable. */
  args: string[];
}

/**
 * The path of the pi executable. The environment variable is the single test
 * seam: a test points it at a fake pi script.
 */
function piExecutable(env: NodeJS.ProcessEnv): string {
  return env.PI_SUBAGENTS_PI_BIN ?? "pi";
}

/**
 * The command line of one child run. The task text is not here: pi reads a
 * positional argument that starts with "@" as a file path, and it has no escape
 * for that, so the task goes to the child on stdin.
 */
function childArguments(agent: AgentDefinition): string[] {
  const args = [
    "--mode",
    "json",
    "--print",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    ...toolArguments(agent.tools, agent.name),
  ];

  if (agent.model !== undefined) args.push("--model", agent.model);

  // An empty body still sends the flag. A replace agent with an empty body asks
  // for an empty system prompt, not for the pi default prompt.
  const flag = agent.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt";
  args.push(flag, agent.systemPrompt);

  return args;
}

function writeRecord(dir: string, record: RunRecord): void {
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Give a run its id, its directory and its record. The child does not run yet,
 * so the record says "queued" until startRun spawns it. The command line is
 * built here, because an unknown tool name must fail the launch before the run
 * leaves a directory behind.
 */
export function prepareRun(options: RunOptions): PreparedRun {
  const args = childArguments(options.agent);
  const id = randomBytes(4).toString("hex");
  const dir = join(options.runsDir, id);
  mkdirSync(dir, { recursive: true });

  const record: RunRecord = {
    id,
    agent: options.agent.name,
    model: options.agent.model ?? null,
    queuedAt: new Date().toISOString(),
    startedAt: undefined,
    endedAt: undefined,
    status: "queued",
  };
  writeRecord(dir, record);
  writeFileSync(join(dir, "transcript.jsonl"), "");

  return { id, dir, record, options, args };
}

/**
 * Finish a run whose child never started, because the run was stopped while it
 * waited for a free slot.
 */
export function abandonRun(run: PreparedRun, why: string): RunOutcome {
  const { dir, record } = run;
  record.endedAt = new Date().toISOString();
  record.status = "stopped";
  writeRecord(dir, record);
  return { record, message: resultMessage(record, why) };
}

/** A started run. The caller kills the child through it. */
export interface RunHandle {
  /**
   * Kill the child and give the run the status. A run that already ended, and a
   * run that was stopped before, do not change.
   */
  stop(status: "failed" | "stopped", why: string): void;
  /** Resolves when the child ends. */
  done: Promise<RunOutcome>;
}

/** Start the child pi process of a prepared run. */
export function startRun(run: PreparedRun): RunHandle {
  const { args, dir, record, options } = run;
  const transcript = join(dir, "transcript.jsonl");

  record.startedAt = new Date().toISOString();
  record.status = "running";
  writeRecord(dir, record);

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

  /** Set by stop, and read by finish, which owns the record. */
  let killed: { status: "failed" | "stopped"; why: string } | undefined;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const done = new Promise<RunOutcome>((resolve) => {
    // A failed spawn emits "error" and then "close", so both handlers run. The
    // first one owns the outcome and the last write of the record.
    const finish = (ok: boolean, failure: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      record.endedAt = new Date().toISOString();
      record.status = killed?.status ?? (ok ? "completed" : "failed");
      writeRecord(dir, record);
      // A killed child says why it ended. Its partial answer is not the answer
      // to the task, so the reason replaces it.
      const text = killed?.why ?? assistantText(lines);
      resolve({ record, message: resultMessage(record, text === "" ? failure : text) });
    };

    // The reader flushes a last line without a newline when stdout ends, which
    // can be after the process itself is gone.
    const streamEnded = new Promise<void>((end) => reader.on("close", () => end()));

    child.on("error", (error) => finish(false, `The child did not start: ${error.message}`));
    child.on("close", (code) => {
      streamEnded.then(() => finish(code === 0, errors.join("").trim()));
    });
  });

  const stop = (status: "failed" | "stopped", why: string): void => {
    if (settled || killed !== undefined) return;
    killed = { status, why };
    // The record carries the status now, and not only when the child is gone.
    // A pi session that shuts down does not wait for the child to close.
    record.status = status;
    writeRecord(dir, record);
    // ponytail: SIGKILL, because a stuck child may ignore SIGTERM and a second
    // timer to escalate buys nothing here. The transcript is already on disk.
    // ponytail: one pid, not a process group. The child is not detached, so it
    // shares the process group of pi, and a group kill would kill pi too. A
    // grandchild of a nested subagent therefore survives. Give the child its
    // own group with detached, and kill the negative pid, if that shows up.
    child.kill("SIGKILL");
  };

  if (options.timeoutMs > 0) {
    const limit = `${options.timeoutMs / 60_000} minutes`;
    timer = setTimeout(
      () => stop("failed", `The run passed its limit of ${limit} and was killed.`),
      options.timeoutMs,
    );
  }

  return { stop, done };
}
