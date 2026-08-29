# pi-subagents

A pi extension that adds a `subagent` tool. The main agent delegates a task to a
named agent. The task runs in a child pi process. The answer arrives in the
conversation as a new turn.

## Use

Load the extension with `pi -e ./index.ts`, or install the package.

The `subagent` tool takes an agent name and a task text. It returns a run id at
once. The caller must not poll for the result.

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

A file in an earlier root shadows a file of the same name in a later root. The
`subagent` tool selects an agent by file stem, so `explorer.md` is the agent
`explorer`. The `name` key only sets the name that reports use.

CI runs the same commands as the Makefile on a pinned Node version. It does not
use the container, so the Node version lives in two files.

## Run state

Each run gets a directory under the session directory:
`<session dir>/subagents/<session id>/<run id>/`. It holds `transcript.jsonl`
with every child event and `run.json` with the agent name, the model, the start
time, the end time, and the status. Nothing is deleted.

## Development

`make check` runs the type check. `make test` runs the tests. `make lint` runs
oxlint. All three run in a container.

`PI_SUBAGENTS_PI_BIN` selects the pi executable. It is the seam the integration
test uses to run a fake child.
