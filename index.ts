import { homedir } from "node:os";
import { join } from "node:path";

import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { agentCatalogue } from "./src/agents.ts";
import { createDispatcher, type Dispatcher } from "./src/dispatch.ts";
import { agentsView, inspectorView, type View } from "./src/inspector.ts";
import { loadSettings, settingsFiles } from "./src/settings.ts";

/**
 * Show one view until a key closes it. The component is a plain object, so this
 * extension needs no TUI class of the host. The chat above keeps a few rows, so
 * the user still sees where the session stands.
 */
async function showView(ctx: ExtensionContext, view: View): Promise<void> {
  // A custom component needs a terminal. Every other mode gets a sentence.
  if (ctx.mode !== "tui") {
    ctx.ui.notify("This command needs the terminal interface of pi.", "warning");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const height = (): number => Math.max(8, tui.terminal.rows - 4);
    // A key needs the same width that the last draw used, or it would scroll
    // against a pane split that the screen never showed.
    let drawn = tui.terminal.columns;

    return {
      render: (width: number) => {
        drawn = width;
        return view.render(theme, width, height());
      },
      handleInput: (data: string) => {
        if (view.key(data, drawn, height())) done();
        else tui.requestRender();
      },
      invalidate: () => {},
    };
  });
}

const DESCRIPTION = [
  "Delegate a task to a named subagent that runs in its own pi process.",
  "The tool returns a run id at once and the child works in the background.",
  "Do not poll for the result. The answer arrives on its own as a new turn.",
].join(" ");

/** The directory that holds one subdirectory per run of this session. */
function runsDir(ctx: ExtensionContext): string {
  return join(ctx.sessionManager.getSessionDir(), "subagents", ctx.sessionManager.getSessionId());
}

export default function (pi: ExtensionAPI) {
  /**
   * The dispatcher of the session. The first tool call builds it, because the
   * project trust decision is settled by then, and it keeps the queue of the
   * session, which drains after the parent turn ends.
   */
  let dispatcher: Dispatcher | undefined;
  /**
   * The context of the tool call that runs now. pi gives a fresh one to every
   * call, so the host below reads this variable instead of holding the first
   * context of the session.
   */
  let current: ExtensionContext;
  const sessionDispatcher = (ctx: ExtensionContext): Dispatcher => {
    current = ctx;
    dispatcher ??= createDispatcher({
      cwd: () => current.cwd,
      home: homedir(),
      agentDir: getAgentDir(),
      projectTrusted: ctx.isProjectTrusted(),
      runsDir: () => runsDir(current),
      // The live tool list of this session. pi narrows it for every child it
      // starts, so it is also the ceiling that the parent of this process
      // granted. A tool of pi itself carries an angle bracket path here.
      tools: () =>
        pi.getAllTools().map((tool) => ({ name: tool.name, path: tool.sourceInfo.path })),
      env: process.env,
      notify: (message, level) => current.ui.notify(message, level),
      showStatus: (line) => {
        current.ui.setWidget("subagents", line === undefined ? undefined : [line]);
      },
      sendResult: (message, record) => {
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: message,
            display: true,
            details: record,
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      },
    });
    return dispatcher;
  };

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: DESCRIPTION,
    parameters: Type.Object({
      agent: Type.String({ description: "Name of the agent file to run" }),
      task: Type.String({ description: "The complete task text for the subagent" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const launch = sessionDispatcher(ctx).dispatch(params.agent, params.task);

      return {
        content: [{ type: "text", text: launch.text }],
        details: { runId: launch.id, dir: launch.dir, status: launch.status },
      };
    },
  });

  pi.registerTool({
    name: "subagent_stop",
    label: "Stop subagent",
    description: "Stop a running subagent by its run id. The child process is killed.",
    parameters: Type.Object({
      runId: Type.String({ description: "The run id that the subagent tool returned" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return {
        content: [{ type: "text", text: sessionDispatcher(ctx).stop(params.runId) }],
        details: { runId: params.runId },
      };
    },
  });

  pi.registerCommand("subagent-stop", {
    description: "Stop a running subagent by its run id",
    handler: async (args, ctx) => {
      const runId = args.trim();
      const text =
        runId === ""
          ? "Give a run id. Example /subagent-stop a1b2c3d4."
          : sessionDispatcher(ctx).stop(runId);
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("subagents", {
    description: "Inspect the subagent runs of this session and read their transcripts",
    handler: async (_args, ctx) => {
      const stop = (runId: string): void => {
        // A session that launched nothing has no dispatcher and no run either,
        // so the view finds nothing to stop and this returns.
        if (dispatcher === undefined) return;
        // The call points the dispatcher at the context of this command first,
        // so the status line of the session lands in the right place.
        ctx.ui.notify(sessionDispatcher(ctx).stop(runId), "info");
      };
      await showView(ctx, inspectorView(runsDir(ctx), stop));
    },
  });

  pi.registerCommand("subagent-agents", {
    description: "List the agents of every root, with the tools and the root of each one",
    handler: async (_args, ctx) => {
      // The catalogue is read here and not taken from the dispatcher: a command
      // may come before the first tool call, and the dispatcher would then
      // freeze the settings while the project trust decision is still open.
      const loaded = loadSettings(settingsFiles(getAgentDir(), ctx.cwd, ctx.isProjectTrusted()));
      const catalogue = agentCatalogue(loaded.settings, ctx.cwd, homedir());
      await showView(ctx, agentsView(catalogue.entries()));
    },
  });

  // Every live run takes its stop here. The pi process exits right after this
  // handler, so each child gets the SIGTERM and never the SIGKILL that follows
  // it. A child that ignores SIGTERM outlives the session.
  pi.on("session_shutdown", () => dispatcher?.stopAll());
}
