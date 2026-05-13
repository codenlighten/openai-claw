import readline from "node:readline";
import chalk from "chalk";
import type { ClawConfig } from "../config.js";
import { saveUserSetting } from "../config.js";
import type { PermissionDecision } from "../tools/types.js";

export type PermissionMode = ClawConfig["permissionMode"];

export type PermissionAnswer = "yes" | "no" | "always" | "save";

export type Prompter = (req: {
  tool: string;
  key: string;
  input: unknown;
}) => Promise<PermissionAnswer>;

interface Approval {
  pattern: string;
}

export class PermissionManager {
  private sessionAllows: Approval[] = [];
  private prompter: Prompter;
  constructor(private config: ClawConfig, prompter?: Prompter) {
    this.prompter = prompter ?? defaultReadlinePrompter();
  }

  setPrompter(p: Prompter) {
    this.prompter = p;
  }

  setMode(mode: PermissionMode) {
    this.config.permissionMode = mode;
  }

  get mode(): PermissionMode {
    return this.config.permissionMode;
  }

  async check(toolName: string, input: unknown): Promise<PermissionDecision> {
    if (this.config.permissionMode === "bypassPermissions") return { allow: true };

    const key = describe(toolName, input);

    if (matchesAny(key, this.config.deniedTools)) {
      return { allow: false, reason: `denied by config (${key})` };
    }
    if (matchesAny(key, this.config.allowedTools)) return { allow: true };
    if (matchesAny(key, this.sessionAllows.map((a) => a.pattern))) return { allow: true };

    if (this.config.permissionMode === "acceptEdits") {
      if (toolName === "Write" || toolName === "Edit") return { allow: true };
    }
    if (this.config.permissionMode === "plan") {
      return { allow: false, reason: "plan mode — propose changes instead of executing them" };
    }
    const answer = await this.prompter({ tool: toolName, key, input });
    if (answer === "yes") return { allow: true };
    if (answer === "always") {
      this.sessionAllows.push({ pattern: toolName });
      return { allow: true };
    }
    if (answer === "save") {
      this.config.allowedTools.push(toolName);
      saveUserSetting(this.config, "allowedTools", this.config.allowedTools);
      return { allow: true };
    }
    return { allow: false, reason: "user denied" };
  }
}

function describe(tool: string, input: unknown): string {
  if (tool === "Bash" && input && typeof (input as any).command === "string") {
    const cmd = (input as any).command.split(/\s+/)[0];
    return `Bash(${cmd}:*)`;
  }
  return tool;
}

// Permission rule syntax accepted by matchesAny:
//   "Read"            — exact tool name (matches the bare key "Read")
//   "Bash"            — any Bash invocation (matches "Bash(<anything>)")
//   "Bash:*"          — same as above (prefix wildcard)
//   "Bash(npm:*)"     — Bash where the first token starts with "npm"
//   "Bash(npm test)"  — exact described key
function matchesAny(key: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    if (pat === key) return true;
    if (pat.endsWith(":*")) {
      const prefix = pat.slice(0, -2);
      if (key.startsWith(prefix)) return true;
    }
    if (!pat.includes("(") && key.startsWith(pat + "(")) return true;
  }
  return false;
}

function defaultReadlinePrompter(): Prompter {
  let rl: readline.Interface | null = null;
  const get = () => {
    if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return rl;
  };
  return ({ tool, key }) =>
    new Promise((resolve) => {
      const r = get();
      process.stdout.write(
        chalk.yellow(`\n? Allow ${chalk.bold(tool)} (${key})? `) +
          chalk.dim("[y]es / [n]o / [a]lways / [s]ave: ")
      );
      r.question("", (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === "y" || a === "yes") return resolve("yes");
        if (a === "a" || a === "always") return resolve("always");
        if (a === "s" || a === "save") return resolve("save");
        resolve("no");
      });
    });
}
