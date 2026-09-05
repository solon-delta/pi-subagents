# Tools and commands

The extension adds two tools for the main agent and three slash commands for
you.

## Tools

`subagent` takes an agent name and a task text. It starts a child pi process and
returns a run id at once. The main agent must not poll for the result. The
answer arrives in the conversation as a new turn.

`subagent_stop` takes a run id and kills that child process.

## `/subagent-stop <run id>`

`/subagent-stop <run id>` kills the child of that run. The run gets the
`stopped` status and keeps its transcript. A run that waits in the queue is
stopped too, and it never starts a child. An unknown run id and a run that
already ended change nothing, and the answer says so. A call without a run id
prints an example.

Two other events end a run. A run that passes `timeoutMinutes` is killed and
gets the `failed` status. The end of your pi session kills every live child,
because no child is detached. The result message of a stopped run and of a timed
out run states why it ended.

## `/subagents`

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

## `/subagent-agents`

`/subagent-agents` reads the agent roots and lists every agent it finds, with
the tools of each one and the root directory that carries the file. An agent
file that this extension cannot read shows its error in place of the tool list.
See [agents](agents.md).

## Status line

A line above the editor counts the runs of the session, for example
`subagents: 2 working, 5 done`. A queued run counts as working. The line stays
away while no run works.

## Terminal only

`/subagents` and `/subagent-agents` draw a window, so they need the terminal
interface of pi. Another mode gets a warning instead.
