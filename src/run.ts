import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { AgentDefinition } from "./agent-file.ts";
import type { ChildNesting } from "./nesting.ts";
import { toolArguments } from "./tools.ts";
import { assistantText } from "./transcript.ts";

export type RunStatus = "completed" | "failed" | "queued" | "running" | "stopped";

export interface RunRecord {
  id: string;
  agent: string;
  /** The model of the agent file, or null when the agent file names none. */
  model: string | null;
  /** Nesting depth of the child. A run of the user session has depth one. */
  depth: number;
  /** Tool names of the agent file that the ceiling of the parent removed. */
  removedTools: string[];
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
  /** Depth, limit and tool ceiling of this child. The tool list comes from here. */
  nesting: ChildNesting;
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

/**
 * One run, from its directory to its end. The module owns the status: the
 * caller starts, stops and waits, and never writes the record itself.
 */
export interface Run {
  id: string;
  /** Directory with the transcript and the metadata record of this run. */
  dir: string;
  /** The status of the run right now. */
  readonly status: RunStatus;
  /** True while the run can still be stopped: it waits for a slot, or it runs. */
  readonly live: boolean;
  /** True once the run has spawned a child. A queued run has none. */
  readonly started: boolean;
  /**
   * Spawn the child. A run that was stopped while it waited for a slot does
   * nothing here, and a second call does nothing.
   */
  start(): void;
  /**
   * End the run. A run that never started ends here, a running run loses its
   * child. A run that already ended does not change.
   */
  stop(why: string): void;
  /** Resolves when the run ends, whether or not a child ever ran. */
  done: Promise<RunOutcome>;
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
function childArguments(agent: AgentDefinition, tools: string[]): string[] {
  const args = [
    "--mode",
    "json",
    "--print",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    ...toolArguments(tools, agent.name),
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
 * Give a run its id, its directory and its record, and hand back the whole
 * lifecycle. The child does not run yet, so the record says "queued" until
 * start spawns it. The command line is built here, because an unknown tool name
 * must fail the launch before the run leaves a directory behind.
 */
export function createRun(options: RunOptions): Run {
  const args = childArguments(options.agent, options.nesting.tools);
  const id = randomBytes(4).toString("hex");
  const dir = join(options.runsDir, id);
  mkdirSync(dir, { recursive: true });

  const record: RunRecord = {
    id,
    agent: options.agent.name,
    model: options.agent.model ?? null,
    depth: options.nesting.depth,
    removedTools: options.nesting.removed,
    queuedAt: new Date().toISOString(),
    startedAt: undefined,
    endedAt: undefined,
    status: "queued",
  };
  writeRecord(dir, record);
  const transcript = join(dir, "transcript.jsonl");
  writeFileSync(transcript, "");

  const lines: string[] = [];
  const errors: string[] = [];
  /** Set by end, and read by finish, which owns the record. */
  let killed: { status: "failed" | "stopped"; why: string } | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  // A failed spawn emits "error" and then "close", so both handlers run. The
  // first one owns the outcome and the last write of the record.
  let finish: (ok: boolean, failure: string) => void;
  const done = new Promise<RunOutcome>((resolve) => {
    finish = (ok, failure) => {
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
  });

  /** End the run for a reason of ours: a stop by the caller, or the timeout. */
  const end = (status: "failed" | "stopped", why: string): void => {
    if (settled || killed !== undefined) return;
    killed = { status, why };

    if (child === undefined) {
      // The run still waits for a slot. It has no child to kill, so it ends
      // here, and start does nothing when the slot opens.
      finish(false, why);
      return;
    }

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

  const start = (): void => {
    if (settled || killed !== undefined || child !== undefined) return;

    record.startedAt = new Date().toISOString();
    record.status = "running";
    writeRecord(dir, record);

    const spawned = spawn(piExecutable(options.env), args, {
      cwd: options.cwd,
      // The nesting values travel to the child, which reads them when it
      // launches a child of its own.
      env: { ...options.env, ...options.nesting.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = spawned;

    // The task goes on stdin. See the comment on childArguments.
    spawned.stdin.on("error", () => {});
    spawned.stdin.end(options.task);

    spawned.stdout.setEncoding("utf8");
    spawned.stderr.setEncoding("utf8");
    spawned.stderr.on("data", (chunk: string) => errors.push(chunk));

    const reader = createInterface({ input: spawned.stdout });
    reader.on("line", (line) => {
      lines.push(line);
      appendFileSync(transcript, `${line}\n`);
    });

    // The reader flushes a last line without a newline when stdout ends, which
    // can be after the process itself is gone.
    const streamEnded = new Promise<void>((ended) => reader.on("close", () => ended()));

    spawned.on("error", (error) => finish(false, `The child did not start: ${error.message}`));
    spawned.on("close", (code) => {
      streamEnded.then(() => finish(code === 0, errors.join("").trim()));
    });

    if (options.timeoutMs > 0) {
      const limit = `${options.timeoutMs / 60_000} minutes`;
      timer = setTimeout(
        () => end("failed", `The run passed its limit of ${limit} and was killed.`),
        options.timeoutMs,
      );
    }
  };

  return {
    id,
    dir,
    get status() {
      return record.status;
    },
    get live() {
      return record.status === "queued" || record.status === "running";
    },
    get started() {
      return record.startedAt !== undefined;
    },
    start,
    stop: (why) => end("stopped", why),
    done,
  };
}
