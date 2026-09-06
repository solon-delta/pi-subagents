import type { AgentDefinition } from "./agent-file.ts";
import { type AgentCatalogue, agentCatalogue } from "./agents.ts";
import {
  type ChildNesting,
  childNesting,
  inheritedNesting,
  type Nesting,
  type ToolSource,
} from "./nesting.ts";
import { createRunQueue } from "./queue.ts";
import { createRun, type Run, type RunRecord, type RunStatus } from "./run.ts";
import { loadSettings, settingsFiles } from "./settings.ts";
import { skillCatalogue } from "./skills.ts";
import { statusLine } from "./status-line.ts";

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
  /**
   * The tools of this pi session, with the file of each one. It is read on
   * every launch, because an extension may register a tool at any time.
   */
  tools(): ToolSource[];
  env: NodeJS.ProcessEnv;
  notify(message: string, level: "error" | "warning"): void;
  /** Carry a finished run back into the parent conversation. */
  sendResult(message: string, record: RunRecord): void;
  /** Show the one status line, or take it away when the text is undefined. */
  showStatus(line: string | undefined): void;
}

export interface Launch {
  id: string;
  /** Directory with the transcript and the metadata record of this run. */
  dir: string;
  /**
   * The status of the run at the moment of the launch: "running" when a slot
   * was free, "queued" when every slot was taken.
   */
  status: RunStatus;
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
  /**
   * The text that names the agents this process can start, for the system
   * prompt of one turn. The empty text when there is nothing to announce.
   */
  promptBlock(): string;
}

const STOPPED = "The run was stopped before it finished.";
const SHUTDOWN = "The run was stopped by the end of the pi session.";

/** The three characters that would break the shape of the block. */
function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The system prompt block that names every agent this process can start, in the
 * shape of the `<available_skills>` block of pi. An agent that a launch would
 * refuse is left out, so the model never plans a run that cannot happen. The
 * `/subagent-agents` command still shows the user the reason of each one.
 */
function agentsBlock(catalogue: AgentCatalogue, parent: Nesting, tools: ToolSource[]): string {
  if (parent.depth >= parent.limit) {
    return (
      `This process runs at subagent depth ${parent.depth}, which is its limit of ` +
      `${parent.limit}, so the subagent tool cannot start an agent here.`
    );
  }

  const lines: string[] = [];
  for (const entry of catalogue.entries()) {
    let agent: AgentDefinition;
    let nesting: ChildNesting;
    try {
      // An unusable file throws here, and an agent that this process may not
      // grant throws below. Both are left out of the block.
      agent = catalogue.get(entry.name);
      nesting = childNesting(parent, agent, tools);
    } catch {
      continue;
    }

    lines.push("  <agent>");
    lines.push(`    <name>${escapeXml(agent.name)}</name>`);
    lines.push(`    <description>${escapeXml(agent.description)}</description>`);
    // The effective list, after the live tool list of this session narrowed it.
    lines.push(`    <tools>${nesting.tools.join(", ")}</tools>`);
    if (agent.skills.length > 0) lines.push(`    <skills>${agent.skills.join(", ")}</skills>`);
    lines.push("  </agent>");
  }

  if (lines.length === 0) return "";

  return [
    "The following agents can be started as subagents, each in its own pi process.",
    "The subagent tool starts one of them by name and gives it the task text.",
    "",
    "<available_agents>",
    ...lines,
    "</available_agents>",
  ].join("\n");
}

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
  // The skill roots are read here too, for the same reason.
  const skills = skillCatalogue(host.cwd(), host.home);
  // The environment of the process never changes, so the nesting of this
  // process is read once. Every launch measures itself against it.
  const parent = inheritedNesting(host.env, settings.maxDepth);

  // The queue outlives the parent turn, so a queued run still starts later.
  const queue = createRunQueue(settings.maxConcurrency);
  // Every run of the session, by id. A finished run stays here, so that a stop
  // can tell an unknown run from a run that already ended.
  const runs = new Map<string, Run>();

  /** Tell the host what the runs of the session say now. */
  const refresh = (): void => {
    host.showStatus(statusLine([...runs.values()].map((run) => run.status)));
  };

  /** Stop one run for one reason. Both public stops go through this. */
  const stopRun = (runId: string, why: string): string => {
    const run = runs.get(runId);
    if (run === undefined) return `No subagent run "${runId}" in this session. Nothing changed.`;

    if (!run.live) return `Subagent run ${runId} already ${run.status}. Nothing changed.`;

    const queued = !run.started;
    run.stop(why);
    refresh();
    return queued ? `Stopped queued subagent run ${runId}.` : `Stopped subagent run ${runId}.`;
  };

  return {
    dispatch(name, task) {
      // The working directory of the session can move between two tool calls,
      // so the launch reads it now and not when the dispatcher was built.
      const cwd = host.cwd();
      const agent = catalogue.get(name);
      // The depth and the tool list both refuse a launch here, before the run
      // makes a directory.
      const nesting = childNesting(parent, agent, host.tools());
      // A skill name that no root carries fails the launch here too, while
      // nothing is on disk yet.
      const skillsBlock = skills.promptBlock(agent.skills, agent.name);
      const run = createRun({
        agent,
        nesting,
        skillsBlock,
        task,
        cwd,
        runsDir: host.runsDir(),
        env: host.env,
        timeoutMs: settings.timeoutMinutes * 60_000,
      });
      runs.set(run.id, run);

      void run.done.then(
        (outcome) => {
          refresh();
          host.sendResult(outcome.message, outcome.record);
        },
        (error: Error) => host.notify(`Subagent run ${run.id} was lost: ${error.message}`, "error"),
      );

      // A run that was stopped in the queue does nothing in start, and its done
      // promise is already settled, so the slot opens again at once.
      queue.add(() => {
        run.start();
        // A run that waited for a slot works now, and the line says so.
        refresh();
        return run.done.then(() => {});
      });

      // The run says itself whether a slot was free.
      const queued = !run.started;
      // A run that started took its refresh in the callback above.
      if (queued) refresh();
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
        status: run.status,
        text: `${head}${narrowed} Do not poll for the result.`,
      };
    },

    stop(runId) {
      return stopRun(runId, STOPPED);
    },

    promptBlock() {
      // The tool list is read again here, as a launch does, because an
      // extension may register a tool after this dispatcher was built.
      return agentsBlock(catalogue, parent, host.tools());
    },

    stopAll() {
      // A queued run is stopped too. It would otherwise start a child while the
      // session goes away.
      for (const runId of runs.keys()) stopRun(runId, SHUTDOWN);
    },
  };
}
