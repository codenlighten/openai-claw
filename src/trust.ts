import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import chalk from "chalk";
import type { ClawConfig } from "./config.js";
import { saveUserSetting } from "./config.js";

interface UserSettings {
  trustedProjects?: string[];
  [k: string]: unknown;
}

function readUserSettings(config: ClawConfig): UserSettings {
  const p = path.join(config.homeDir, "settings.json");
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8")) as UserSettings;
  } catch {
    return {};
  }
}

export function isProjectTrusted(config: ClawConfig): boolean {
  const s = readUserSettings(config);
  const list = Array.isArray(s.trustedProjects) ? s.trustedProjects : [];
  const here = path.resolve(config.workdir);
  return list.some((p) => path.resolve(p) === here);
}

export function markProjectTrusted(config: ClawConfig): void {
  const s = readUserSettings(config);
  const list = Array.isArray(s.trustedProjects) ? s.trustedProjects.slice() : [];
  const here = path.resolve(config.workdir);
  if (!list.some((p) => path.resolve(p) === here)) list.push(here);
  // saveUserSetting types its value as ClawConfig[K], which doesn't include
  // trustedProjects. Cast through any — the underlying store is plain JSON.
  saveUserSetting(config, "trustedProjects" as any, list as any);
}

export type TrustAnswer = "yes" | "once" | "no";

export type TrustPrompter = (req: {
  workdir: string;
  hooks: number;
  mcpServers: number;
}) => Promise<TrustAnswer>;

export const defaultTrustPrompter: TrustPrompter = ({ workdir, hooks, mcpServers }) => {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const counts: string[] = [];
    if (hooks > 0) counts.push(`${hooks} hook(s)`);
    if (mcpServers > 0) counts.push(`${mcpServers} MCP server(s)`);
    process.stdout.write(
      "\n" +
        chalk.yellow("⚠  This project's .claw/settings.json defines " + counts.join(" and ") + ".") +
        "\n" +
        chalk.yellow("   Hooks run arbitrary shell commands. MCP servers run arbitrary subprocesses.") +
        "\n" +
        chalk.yellow(`   Allow them in ${workdir}? `) +
        chalk.dim("[y]es (remember) / [N]o / [o]nce: ")
    );
    rl.question("", (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "y" || a === "yes") return resolve("yes");
      if (a === "o" || a === "once") return resolve("once");
      resolve("no");
    });
  });
};

export interface ProjectTrustOutcome {
  trustHooks: boolean;
  trustMcp: boolean;
}

/**
 * Read the project's settings file and, if it defines hooks or MCP servers,
 * confirm with the user before honoring them. Persists "yes" answers in the
 * user-level settings so subsequent runs are silent.
 *
 * Non-interactive callers (no TTY) get a hard deny with a stderr warning.
 */
export async function resolveProjectTrust(
  config: ClawConfig,
  opts: { interactive: boolean; prompter?: TrustPrompter } = { interactive: true }
): Promise<ProjectTrustOutcome> {
  const projSettingsPath = path.join(config.workdir, ".claw", "settings.json");
  let projSettings: any = {};
  try {
    if (fs.existsSync(projSettingsPath)) {
      projSettings = JSON.parse(fs.readFileSync(projSettingsPath, "utf8"));
    }
  } catch {
    // Malformed project settings → treat as no project-level entries.
    return { trustHooks: true, trustMcp: true };
  }

  const hookCount = countHooks(projSettings.hooks);
  const mcpCount = Object.keys(projSettings.mcpServers ?? {}).length;
  if (hookCount === 0 && mcpCount === 0) {
    return { trustHooks: true, trustMcp: true };
  }

  if (isProjectTrusted(config)) {
    return { trustHooks: true, trustMcp: true };
  }

  if (!opts.interactive) {
    console.error(
      chalk.yellow(
        `[claw] ${path.resolve(config.workdir)} defines ${hookCount} hook(s) and ${mcpCount} MCP server(s); skipping (non-interactive run). Run interactively and answer [y] to trust this project.`
      )
    );
    return { trustHooks: false, trustMcp: false };
  }

  const answer = await (opts.prompter ?? defaultTrustPrompter)({
    workdir: path.resolve(config.workdir),
    hooks: hookCount,
    mcpServers: mcpCount,
  });
  if (answer === "yes") {
    markProjectTrusted(config);
    return { trustHooks: true, trustMcp: true };
  }
  if (answer === "once") {
    return { trustHooks: true, trustMcp: true };
  }
  console.error(
    chalk.yellow(`[claw] skipping project-level hooks and MCP servers for this session.`)
  );
  return { trustHooks: false, trustMcp: false };
}

function countHooks(hooks: unknown): number {
  if (!hooks || typeof hooks !== "object") return 0;
  let n = 0;
  for (const v of Object.values(hooks as Record<string, unknown>)) {
    if (Array.isArray(v)) n += v.length;
  }
  return n;
}
