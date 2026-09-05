# pi-subagents

A pi extension that adds a `subagent` tool. The main agent delegates a task to a
named agent. The task runs in a child pi process. The answer arrives in the
conversation as a new turn.

## Use

Load the extension with `pi -e ./index.ts`, or install the package.

The `subagent` tool takes an agent name and a task text. It returns a run id at
once. The caller must not poll for the result.

The `subagent_stop` tool takes a run id and kills that child process. The
command `/subagent-stop <run id>` does the same for you.

## Agent files

An agent is one markdown file. The frontmatter states the powers of the agent.
The body is the system prompt.

```markdown
---
name: explorer
description: Reads a codebase and answers a question about it.
tools: [read, grep, find, ls]
skills: [code-review]
model: anthropic/claude-sonnet-5
maxDepth: 2
systemPromptMode: replace
---

You explore a codebase and answer one question about it.
```

The `tools` key is required. A file without it fails the launch. The `skills`
key is optional, and a file without it names no skill. See Skills. The
`systemPromptMode` key is `replace` by default; `append` keeps the pi base
prompt and adds the body. The `maxDepth` key lowers the depth limit of the tree
below this agent. See Nesting.

Agent files are read from three roots, in this order.

- `.pi/agents/` in the project
- `~/.pi/agent/agents/` for the user
- `agents/` in this package

The `name` key selects the agent. A file without that key is named after its
file stem, so `explorer.md` is the agent `explorer`. A file in an earlier root
shadows a file of the same agent name in a later root.

## Tool names

A `tools` entry is a plain tool name, never a path. Two kinds of name work.

- A pi built-in: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, and
  `powershell` on Windows.
- A name that an extension file backs. This package backs `subagent` and
  `subagent_stop`.

A child gets no ambient extensions, so a mapped name puts its extension file on
the child command line. Two mapped names from the same file load it once. A name
that is neither built in nor mapped fails the launch with an error that names
the tool and the agent, so a typo never gives you a weaker agent in silence.

## Skills

A child never sees your skill catalogue. It gets only the skills that its own
agent file names in the `skills` key, so a small task does not carry your whole
catalogue.

Skill files are read from four roots, in this order.

- `.pi/skills/` in the project
- `.agents/skills/` in the project
- `~/.pi/agent/skills/` for the user
- `~/.agents/skills/` for the user

A skill in an earlier root shadows a skill of the same name in a later root, so
a project skill wins over a user skill. A skill is a directory with a `SKILL.md`
file, as pi itself defines it. The two `.agents/skills/` roots are the
cross-client convention, so a skill that another agent installed is a skill an
agent file may name here. pi reads the same four roots.

Three skill sources of pi are left out: the ancestor directories of the working
directory, the `skills` directories of packages, and the `skills` key of the pi
settings.

Every named skill reaches the child in its system prompt, with the name, the
description and the path of the file. The child opens the file when the task
matches the description, so a launch with any skill also gets the `read` tool,
even when the agent file does not name it. The capability ceiling still applies.
A parent that may not grant `read` cannot grant it here either, so that launch
is refused rather than started with instructions the child could not open.

A skill name that neither root carries fails the launch with an error that names
the skill and the agent, so an agent never runs without the instructions it
needs. Both roots are read once, on the first call of the `subagent` tool.

## Configuration

Two JSON files hold the settings. Every key is optional in both.

- `~/.pi/agent/pi-subagents.json` for the user
- `.pi/pi-subagents.json` in the project

The project file overrides the user file, key by key. A key that the project
file leaves out keeps the user value. The project file is read only when you
trust the project, so a repository cannot raise a limit without your consent.

```json
{
  "maxDepth": 3,
  "maxConcurrency": 4,
  "timeoutMinutes": 30,
  "defaultModel": "anthropic/claude-sonnet-5",
  "agentDirs": ["/home/user/work/agents"]
}
```

A missing file gives the defaults above. A file that is not valid JSON, or that
holds a wrong value type, warns and drops out, so a typo never blocks a session.
The other file still applies. An unknown key is ignored. Both files are read
once, on the first call of the `subagent` tool.

`agentDirs` adds agent roots. They are searched after the user root and before
the bundled root. A leading `~` is expanded. `defaultModel` is used by an agent
file without a `model` key. A `timeoutMinutes` of zero means that a run has no
time limit. `maxDepth` bounds a chain of subagents. See Nesting.

## Nesting

An agent whose `tools` list holds `subagent` can split its own task. Two guards
bound the tree of processes.

The first guard is the depth. A session that you start has depth zero, its
subagent has depth one, and every level adds one. A launch at or above the limit
is refused before the process starts, and the message names the depth and the
limit. The limit comes from the environment of the process, then from
`maxDepth` in the settings, then from a default of three. An agent file with a
`maxDepth` key lowers the limit for the tree below it. A larger value is
ignored, so one agent file cannot defeat your setting.

The second guard is the capability ceiling. The ceiling is the set of tool names
that a process may grant. Your own session has no ceiling, so a first launch
grants every tool the agent file names. Every launch intersects the agent tool
list with the ceiling, and the result becomes the ceiling of the new child. An
agent restricted to reading therefore cannot give its own child a shell,
whatever the agent file of that child says. A removed tool does not fail the
launch. The tool answer names the removed tools, and `run.json` records them.

Three environment values carry the guards to a child: `PI_SUBAGENTS_DEPTH`,
`PI_SUBAGENTS_MAX_DEPTH` and `PI_SUBAGENTS_TOOL_CEILING`. A process that clears
them looks like a root process to the extension, so the guards bound an agent
that follows the rules. They are not a sandbox around an agent with a shell.

## Concurrency

`maxConcurrency` children run at the same time. A spawn above that number waits
in a queue, and the tool says that the run is queued. A run that ends frees its
slot for the next run in arrival order. The queue keeps draining after the turn
of the main agent ends.

## Stopping a run

`/subagent-stop <run id>` kills the child of that run. The run gets the
`stopped` status and keeps its transcript. A run that waits in the queue is
stopped too, and it never starts a child. An unknown run id and a run that
already ended change nothing, and the answer says so.

A run that passes `timeoutMinutes` is killed and gets the `failed` status. The
result message of a stopped run and of a timed out run states why it ended.

No child survives your pi session. Children are not detached, and the session
shutdown handler kills every live child.

## Run state

Each run gets a directory under the session directory:
`<session dir>/subagents/<session id>/<run id>/`. It holds `transcript.jsonl`
with every child event and `run.json` with the agent name, the model, the depth,
the tools the ceiling removed, the queue time, the start time, the end time, and
the status. The status is `queued`, `running`, `completed`, `failed` or
`stopped`. Nothing is deleted.

## Inspecting the runs

`/subagents` opens the fleet view: a framed window with the run list on the left
and the transcript of the selected run on the right.

```
╭─ fleet ──────────────────────────────────────────────────────────────────────╮
│ ● explorer a1b2c3d4 sonnet   │ explorer · a1b2c3d4 · sonnet · running · 2m14s│
│ ○ reviewer 7f0e91aa opus     │ Map the path a tool call takes from index.ts  │
│ ✓ writer 5ab9f412 haiku      │ to a child process.                           │
│ ✗ reviewer e81c7d30 opus     │                                               │
│ ■ explorer 9d44a0f1 sonnet   │ [tool read]                                   │
│                              │ read index.ts                                 │
╰──────────────────────────────────────────────────────────────────────────────╯
 ↑↓ select   ←→ pane   s stop   r reload   q close
```

A list row carries the status mark, the agent name, the run id and the model.
The mark is `○` queued, `●` running, `✓` completed, `✗` failed and `■` stopped,
and its colour says the same. The right pane heads the transcript with the run,
its status and how long it worked, and then the task of the run.

- `up` and `down`, or `k` and `j`, move the selection and scroll the transcript.
- `left` and `right`, or `h` and `l`, move focus between the two panes.
- `s` stops the selected run, on the same path as `/subagent-stop`.
- `r` reads the files again. The view never follows a running child on a timer.
- `q`, or `escape`, closes the view.

A terminal below 44 columns holds one pane, and the focused pane takes it. A run
that has printed nothing shows its head and an empty transcript under it.

The task text comes out of the transcript file. pi writes the task back into the
event stream as a user message, so no other file has to keep it.

`/subagent-agents` reads the agent roots and lists every agent it finds, with the
tools of each one and the root directory that carries the file. An agent file
that this extension cannot read shows its error in place of the tool list.

## Development

`make install` installs the dependencies. `make check` runs the type check.
`make test` runs every test, `make test-unit` and `make test-integration` run
one half each. `make lint` runs oxlint. Every target runs in a container, and
CI calls the same targets.

`PI_SUBAGENTS_PI_BIN` selects the pi executable. It is the seam the integration
test uses to run a fake child.
