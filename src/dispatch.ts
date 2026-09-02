import { agentCatalogue } from "./agents.ts";
import { childNesting, inheritedNesting } from "./nesting.ts";
import { createRunQueue } from "./queue.ts";
import { createRun, type Run, type RunRecord } from "./run.ts";
import { loadSettings, settingsFiles } from "./settings.ts";

/**
 * What the dispatch module needs from the host. Every fact is a plain value or
 * a plain function, so a test supplies its own host.
 */
export interface Host {
  /** Working directory of the parent session. It is read again on every launch. */
  cwd(): string;
  /** Home directory of the user. */
  home: string;
  /** The pi agent directory, which holds the user settings file. */
  agentDir: string;
  /** True when the user trusts the project, which opens the project settings. */
  projectTrusted: boolean;
  /** Directory that holds one subdirectory per run. It is read on every launch. */
  runsDir(): string;
  env: NodeJS.ProcessEnv;
  notify(message: string, level: "error" | "warning"): void;
  /** Carry a finished run back into the parent conversation. */
  sendResult(message: string, record: RunRecord): void;
}

export interface Launch {
  id: string;
  /** Directory with the transcript and the metadata record of this run. */
  dir: string;
  /** "running" when a slot was free, "queued" when every slot was taken. */
  status: "queued" | "running";
  /** The answer of the tool call, for the model that asked for the run. */
  text: string;
}

export interface Dispatcher {
  /** Launch one agent on one task. The child works after this returns. */
  dispatch(agent: string, task: string): Launch;
  /**
   * Kill the child of one run. Returns the sentence that the caller shows. An
   * unknown run and a run that already ended change nothing.
   */
  stop(runId: string): string;
  /** Kill the child of every live run. The session shutdown handler calls this. */
  stopAll(): void;
}

const STOPPED = "The run was stopped before it finished.";
const SHUTDOWN = "The run was stopped by the end of the pi session.";

/**
 * One dispatcher per session. It reads the settings once, because the caller
 * builds it on the first tool call, when the project trust decision is settled.
 * A changed settings file needs a new session.
 */
export function createDispatcher(host: Host): Dispatcher {
  const loaded = loadSettings(settingsFiles(host.agentDir, host.cwd(), host.projectTrusted));
  if (loaded.warning !== undefined) host.notify(loaded.warning, "warning");
  const settings = loaded.settings;
  // The agent files are read here, next to the settings, and not on every
  // launch. A new agent file needs a new session, like a changed setting.
  const catalogue = agentCatalogue(settings, host.cwd(), host.home);
  // The environment of the process never changes, so the nesting of this
  // process is read once. Every launch measures itself against it.
  const parent = inheritedNesting(host.env, settings.maxDepth);

  // The queue outlives the parent turn, so a queued run still starts later.
  const queue = createRunQueue(settings.maxConcurrency);
  // Every run of the session, by id. A finished run stays here, so that a stop
  // can tell an unknown run from a run that already ended.
  const runs = new Map<string, Run>();

  /** Stop one run for one reason. Both public stops go through this. */
  const stopRun = (runId: string, why: string): string => {
    const run = runs.get(runId);
    if (run === undefined) return `No subagent run "${runId}" in this session. Nothing changed.`;

    const before = run.status;
    if (before !== "queued" && before !== "running") {
      return `Subagent run ${runId} already ${before}. Nothing changed.`;
    }

    run.stop(why);
    return before === "queued"
      ? `Stopped queued subagent run ${runId}.`
      : `Stopped subagent run ${runId}.`;
  };

  return {
    dispatch(name, task) {
      // The working directory of the session can move between two tool calls,
      // so the launch reads it now and not when the dispatcher was built.
      const cwd = host.cwd();
      const agent = catalogue.get(name);
      // The depth refuses a launch here, before the run makes a directory.
      const nesting = childNesting(parent, agent);
      const run = createRun({
        agent,
        nesting,
        task,
        cwd,
        runsDir: host.runsDir(),
        env: host.env,
        timeoutMs: settings.timeoutMinutes * 60_000,
      });
      runs.set(run.id, run);

      void run.done.then(
        (outcome) => host.sendResult(outcome.message, outcome.record),
        (error: Error) => host.notify(`Subagent run ${run.id} was lost: ${error.message}`, "error"),
      );

      // A run that was stopped in the queue does nothing in start, and its done
      // promise is already settled, so the slot opens again at once.
      queue.add(() => {
        run.start();
        return run.done.then(() => {});
      });

      // The run says itself whether a slot was free.
      const queued = run.status === "queued";
      const head = queued
        ? `Queued subagent "${agent.name}" as run ${run.id}. It starts when a slot is free.`
        : `Started subagent "${agent.name}" as run ${run.id}.`;
      // The caller must know that its child is weaker than the agent file says.
      const narrowed =
        nesting.removed.length === 0
          ? ""
          : ` This process may not grant ${nesting.removed.join(", ")}, so the run does not have that.`;

      return {
        id: run.id,
        dir: run.dir,
        status: queued ? "queued" : "running",
        text: `${head}${narrowed} Do not poll for the result.`,
      };
    },

    stop(runId) {
      return stopRun(runId, STOPPED);
    },

    stopAll() {
      // A queued run is stopped too. It would otherwise start a child while the
      // session goes away.
      for (const runId of runs.keys()) stopRun(runId, SHUTDOWN);
    },
  };
}
