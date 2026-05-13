import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { ClawConfig, ModelRole } from "../config.js";

export interface SubagentDef {
  /** Identifier the model uses in `Task(subagent_type=...)`. */
  name: string;
  description: string;
  /** Optional whitelist of tool names this subagent may use. Undefined = inherit defaults. */
  tools?: string[];
  /** Optional model role to prefer for this subagent's turns. */
  modelRole?: ModelRole;
  /** Markdown body, injected as the system prompt. */
  body: string;
  file: string;
}

const BUILTIN: SubagentDef[] = [
  {
    name: "general-purpose",
    description: "General-purpose subagent with the full tool set. Use for open-ended multi-step tasks.",
    body: "",
    file: "(builtin)",
  },
  {
    name: "explore",
    description: "Read-only search subagent. Use for locating code, files, references.",
    tools: ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"],
    body: "",
    file: "(builtin)",
  },
];

/**
 * Discover subagent definitions. Order of precedence:
 *   1. project: <workdir>/.claw/agents/*.md (wins on name clash)
 *   2. user:    <homeDir>/agents/*.md
 *   3. builtin: general-purpose, explore
 */
export function listSubagents(config: ClawConfig): SubagentDef[] {
  const seen = new Map<string, SubagentDef>();
  for (const def of BUILTIN) seen.set(def.name, def);

  const dirs = [
    path.join(config.homeDir, "agents"),
    path.join(config.workdir, ".claw", "agents"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const file = path.join(dir, entry);
      try {
        const parsed = matter(fs.readFileSync(file, "utf8"));
        const name = parsed.data?.name ?? entry.replace(/\.md$/, "");
        const def: SubagentDef = {
          name,
          description: parsed.data?.description ?? "",
          tools: Array.isArray(parsed.data?.tools) ? parsed.data.tools : undefined,
          modelRole: parsed.data?.modelRole as ModelRole | undefined,
          body: parsed.content.trim(),
          file,
        };
        seen.set(name, def); // later overwrites earlier
      } catch {}
    }
  }
  return Array.from(seen.values());
}

export function findSubagent(config: ClawConfig, name: string): SubagentDef | undefined {
  return listSubagents(config).find((s) => s.name === name);
}
