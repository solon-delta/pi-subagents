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
model: anthropic/claude-sonnet-5
systemPromptMode: replace
---

You explore a codebase and answer one question about it.
```

The `tools` key is required. A file without it fails the launch. The
`systemPromptMode` key is `replace` by default; `append` keeps the pi base
prompt and adds the body.

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
file without a `model` key. `maxConcurrency` and `timeoutMinutes` are
enforced. A `timeoutMinutes` of zero means that a run has no time limit. The
limit `maxDepth` is read, but the code that enforces it is not written yet.

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
with every child event and `run.json` with the agent name, the model, the queue
time, the start time, the end time, and the status. The status is `queued`,
`running`, `completed`, `failed` or `stopped`. Nothing is deleted.

## Development

`make install` installs the dependencies. `make check` runs the type check.
`make test` runs every test, `make test-unit` and `make test-integration` run
one half each. `make lint` runs oxlint. Every target runs in a container, and
CI calls the same targets.

`PI_SUBAGENTS_PI_BIN` selects the pi executable. It is the seam the integration
test uses to run a fake child.
