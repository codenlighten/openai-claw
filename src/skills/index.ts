import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { ClawConfig } from "../config.js";

export interface Skill {
  name: string;
  description: string;
  body: string;
  file: string;
}

/**
 * Skills live in <homeDir>/skills/<name>/SKILL.md or <workdir>/.claw/skills/<name>/SKILL.md.
 * The frontmatter `name` and `description` describe the skill; the body is injected as
 * additional system context when the user invokes it via /<name>.
 */
export function listSkills(config: ClawConfig): Skill[] {
  const dirs = [
    path.join(config.homeDir, "skills"),
    path.join(config.workdir, ".claw", "skills"),
  ];
  const skills: Skill[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const skillFile = path.join(dir, entry, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      try {
        const parsed = matter(fs.readFileSync(skillFile, "utf8"));
        skills.push({
          name: parsed.data?.name ?? entry,
          description: parsed.data?.description ?? "",
          body: parsed.content.trim(),
          file: skillFile,
        });
      } catch {}
    }
  }
  return skills;
}

export function findSkill(config: ClawConfig, name: string): Skill | undefined {
  return listSkills(config).find((s) => s.name === name);
}
