# pi-subagents

A pi extension that adds a `subagent` tool. The main agent delegates a task to a
named agent. The task runs in a child pi process. The answer arrives in the
conversation as a new turn.

## Features

- Agents as markdown files, with a tool list and a skill list per agent.
- A depth limit and a capability ceiling that bound a tree of subagents.
- A queue, a concurrency limit and a time limit per run.
- A transcript and a record on disk for every run.
- A fleet view and a status line that show the runs of the session.

## Use

Load the extension with `pi -e ./index.ts`, or install the package.

Write an agent file, then let the main agent call the `subagent` tool with the
agent name and a task. Watch the runs with `/subagents`.

## Documentation

- [Agents](docs/agents.md): agent files, tool names, skills and nesting.
- [Settings](docs/settings.md): the two JSON files, the keys, the run state and
  the environment values.
- [Commands](docs/commands.md): the two tools, the three slash commands and the
  fleet view.
- [Decisions](docs/adr/): the architecture decision records.

## Development

`make install` installs the dependencies. `make check` runs the type check.
`make test` runs every test, `make test-unit` and `make test-integration` run
one half each. `make lint` runs oxlint. Every target runs in a container, and
CI calls the same targets.
