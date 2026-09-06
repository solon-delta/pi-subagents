# Settings

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

A missing file gives the defaults. A file that is not valid JSON, or that holds
a wrong value type, warns and drops out, so a typo never blocks a session. The
other file still applies. An unknown key is ignored. Both files are read once,
on the first call of the `subagent` tool.

## Keys

| Key              | Default        | Meaning                                            |
| ---------------- | -------------- | -------------------------------------------------- |
| `maxDepth`       | `3`            | How deep a chain of subagents may go                |
| `maxConcurrency` | `4`            | How many children work at the same time             |
| `timeoutMinutes` | `30`           | Wall clock limit of one run. Zero means no limit    |
| `defaultModel`   | the pi default | Model of an agent file without a `model` key        |
| `agentDirs`      | `[]`           | More agent roots. A leading `~` is the home         |

An `agentDirs` root is searched after the user root and before the bundled root.
An agent file may lower `maxDepth` for the tree below it. See
[agents](agents.md).

## Concurrency

`maxConcurrency` children run at the same time. A spawn above that number waits
in a queue, and the tool says that the run is queued. A run that ends frees its
slot for the next run in arrival order. The queue keeps draining after the turn
of the main agent ends.

## Run state on disk

Each run gets a directory under the session directory:
`<session dir>/subagents/<session id>/<run id>/`. It holds `transcript.jsonl`
with every child event and `run.json` with the agent name, the model, the depth,
the tools the launch removed, the queue time, the start time, the end time, and
the status. The status is `queued`, `running`, `completed`, `failed` or
`stopped`. Nothing is deleted.

## Environment values

| Name                     | Meaning                                    |
| ------------------------ | ------------------------------------------ |
| `PI_SUBAGENTS_DEPTH`     | Depth of the current process               |
| `PI_SUBAGENTS_MAX_DEPTH` | Depth limit for the tree below the process |
| `PI_SUBAGENTS_PI_BIN`    | The pi executable a child runs             |

The extension sets the first two for every child. The tools a process may grant
are its own live tool list, not a variable. See [agents](agents.md).
`PI_SUBAGENTS_PI_BIN` selects the pi executable, and the integration test uses
it to run a fake child.
