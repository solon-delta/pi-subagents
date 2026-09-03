# The agent catalogue and the skill catalogue stay separate

`src/agents.ts` and `src/skills.ts` have the same outline: walk a list of roots,
build a `Map` in shadowing order, and look a name up or throw with the sorted
available names. A merge onto one generic catalogue module looks obvious, and we
rejected it in September 2026.

## Considered options

We measured the overlap before we decided. The two modules share eight lines of
body: four for the first-wins loop, and four for the get-or-throw. Everything
around those eight lines differs.

- Reading one root. `agents.ts` calls `readdirSync`, filters `.md`, reads each
  file and parses it. `skills.ts` makes one call to `loadSkillsFromDir`.
- A missing root. `agents.ts` needs a `try`/`catch`. `skills.ts` gets an empty
  list and needs nothing.
- The stored value. `agents.ts` stores `AgentDefinition | Error` and keys a
  failed parse by the file stem, so a bad agent file stays visible in the list.
  `skills.ts` has no such case.
- The name. An agent names itself in its frontmatter. A skill takes its name
  from the library.
- The lookup. `agentCatalogue.get` takes one name and merges the default model.
  `skillCatalogue.promptBlock` takes a list, names the calling agent in its
  error, and formats a prompt block.

A generic `collect<T>(roots, load)` is nine lines with its signature and doc
comment. It removes four lines from each caller, and each caller then needs a
wrapper that yields name and item pairs. The change adds a file, adds an
indirection, and adds lines.

## Consequences

The eight shared lines stay duplicated on purpose. A change to the shadowing
rule has to be made twice, in `discoverAgents` and in `discoverSkills`. Both
copies are three lines long and both have their own tests, so the cost of that
is small and visible.

Reopen this if a third catalogue appears, or if the two lookups grow rules that
have to agree with each other.
