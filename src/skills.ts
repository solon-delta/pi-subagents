import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";

/** The cross-client root that every skill-aware agent reads. */
const SHARED_DIR = join(".agents", "skills");

/**
 * The four roots, in shadowing order: the two project roots, then the two user
 * roots. pi itself reads the same four, so a skill that pi finds is a skill
 * that an agent file may name.
 */
function skillRoots(cwd: string, home: string): string[] {
  return [
    join(cwd, CONFIG_DIR_NAME, "skills"),
    join(cwd, SHARED_DIR),
    join(home, CONFIG_DIR_NAME, "agent", "skills"),
    join(home, SHARED_DIR),
  ];
}

/**
 * Map a skill name to its skill. An earlier root shadows a later one. A missing
 * root gives no skills.
 */
export function discoverSkills(roots: string[]): Map<string, Skill> {
  const skills = new Map<string, Skill>();

  for (const root of roots) {
    for (const skill of loadSkillsFromDir({ dir: root, source: "path" }).skills) {
      if (!skills.has(skill.name)) skills.set(skill.name, skill);
    }
  }

  return skills;
}

export interface SkillCatalogue {
  /**
   * The system prompt block for these skill names, or the empty text for an
   * agent that names none. A name that no root carries throws.
   */
  promptBlock(names: string[], agentName: string): string;
}

/**
 * Read every root once, next to the agent files. A skill that you write after
 * this call is invisible until the next session.
 */
export function skillCatalogue(cwd: string, home: string): SkillCatalogue {
  const skills = discoverSkills(skillRoots(cwd, home));

  return {
    promptBlock(names, agentName) {
      if (names.length === 0) return "";

      const chosen = names.map((name) => {
        const skill = skills.get(name);
        if (skill === undefined) {
          const available = [...skills.keys()].sort().join(", ");
          throw new Error(
            `Unknown skill "${name}" in agent "${agentName}". Available skills: ${available}`,
          );
        }
        // The agent file named this skill itself, so the flag that hides a
        // skill from a catalogue of many has nothing to say here.
        return { ...skill, disableModelInvocation: false };
      });

      return formatSkillsForPrompt(chosen);
    },
  };
}
