# Agents

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

## Frontmatter keys

| Key                | Required | Meaning                                                    |
| ------------------ | -------- | ---------------------------------------------------------- |
| `name`             | no       | Agent name. The file stem when the key is absent            |
| `description`      | no       | One sentence about the agent. No view reads it today        |
| `tools`            | yes      | Tool names the child may call. An empty list gives no tool  |
| `skills`           | no       | Skill names the child receives. Absent names no skill       |
| `model`            | no       | Model of the child. See `defaultModel` in the settings      |
| `maxDepth`         | no       | Depth limit below this agent. A whole number of one or more |
| `systemPromptMode` | no       | `replace` by default, or `append`                           |

A file without a `tools` key fails the launch. `replace` uses the body as the
whole system prompt. `append` keeps the pi base prompt and adds the body.

A child is started without the extensions, the skills and the context files of
the host, so `AGENTS.md` and the other context files of your project do not
reach it. Its whole instruction is the body of the agent file and the skills the
file names.

## Where agent files live

Agent files are read from three roots, in this order.

- `.pi/agents/` in the project
- `~/.pi/agent/agents/` for the user
- `agents/` in this package

The `agentDirs` setting adds more roots. They are searched after the user root
and before the bundled root. See [settings](settings.md).

The `name` key selects the agent, so `explorer.md` without a `name` key is the
agent `explorer`. A file in an earlier root shadows a file of the same agent
name in a later root. The roots are read once per session, on the first call of
the `subagent` tool or on the first `/subagent-agents`.

The bundled root carries one agent, `explorer`. It reads a codebase with
`read`, `grep`, `find` and `ls`, and it answers one question about it. A file of
the same name in an earlier root replaces it.

## Tool names

A `tools` entry is a plain tool name, never a path. Any tool of your session
works: a pi built-in such as `read` or `bash`, a tool of this package such as
`subagent`, and a tool of any other extension that your session loaded.

Every launch reads the live tool list of the session and looks the named tools
up in it. A built-in tool needs nothing more, because the child is the same pi
binary. A tool of an extension travels as the file that the list names, because
a child gets no ambient extensions. Two names from the same file load it once.

A name that no tool of your session carries fails the launch with an error that
names the tool and the agent, so a typo never gives you a weaker agent in
silence. A tool without a file, such as an SDK tool or an inline tool, fails the
launch too, because a new process cannot load it.

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
even when the agent file does not name it. The tool list of the process still
applies. A process without `read` cannot grant it here either, so that launch is
refused rather than started with instructions the child could not open.

A skill name that no root carries fails the launch with an error that names the
skill and the agent, so an agent never runs without the instructions it needs.
The four roots are read once per session, with the agent roots above.

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

The second guard is the tool list of the process. A child is started with the
`--tools` list of its agent file, so pi gives that child exactly those tools and
nothing else. Its own live tool list is therefore the set of tools it may pass
on. Every launch intersects the agent tool list with that live list. An agent
restricted to reading cannot give its own child a shell, whatever the agent file
of that child says.

A missing name means two different things by depth. Your own session sees every
tool you have, so a name it does not carry is a typo and fails the launch. Below
that, a missing name is a tool that the parent lost. It is removed from the
launch instead of failing it: the
tool answer names the removed tools, and `run.json` records them.

Two environment values carry the depth guard to a child: `PI_SUBAGENTS_DEPTH`
and `PI_SUBAGENTS_MAX_DEPTH`. A process that clears them looks like a root
process to the extension, so the guards bound an agent that follows the rules.
They are not a sandbox around an agent with a shell.
