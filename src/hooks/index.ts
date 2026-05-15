import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ClawConfig } from "../config.js";

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionStart"
  | "SessionEnd"
  | "PreCompact"
  | "SubagentStop"
  | "Notification";

interface HookDefinition {
  event: HookEvent;
  matcher?: string; // regex string matched against tool name (for PreToolUse/PostToolUse)
  command: string;
}

interface HookOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  blocked: boolean;
}

export class HookRunner {
  private hooks: HookDefinition[] = [];
  constructor(config: ClawConfig, opts: { includeProject?: boolean } = {}) {
    this.hooks = loadHooks(config, opts.includeProject ?? true);
  }

  async run(event: HookEvent, payload: Record<string, unknown>): Promise<HookOutcome[]> {
    const matches = this.hooks.filter((h) => {
      if (h.event !== event) return false;
      if (h.matcher && payload.tool_name) {
        try {
          return new RegExp(h.matcher).test(String(payload.tool_name));
        } catch {
          return false;
        }
      }
      return true;
    });
    const outcomes: HookOutcome[] = [];
    for (const h of matches) {
      const res = spawnSync("bash", ["-c", h.command], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 30_000,
      });
      outcomes.push({
        exitCode: res.status ?? -1,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        blocked: (res.status ?? 0) === 2, // exit 2 = block, by convention
      });
    }
    return outcomes;
  }
}

function loadHooks(config: ClawConfig, includeProject: boolean): HookDefinition[] {
  const userSettings = readSettings(path.join(config.homeDir, "settings.json"));
  const projectSettings = includeProject
    ? readSettings(path.join(config.workdir, ".claw", "settings.json"))
    : {};
  const hooks: HookDefinition[] = [];
  for (const s of [userSettings, projectSettings]) {
    if (!s.hooks) continue;
    for (const [event, defs] of Object.entries<any>(s.hooks)) {
      if (!Array.isArray(defs)) continue;
      for (const d of defs) {
        if (!d?.command) continue;
        if (d.matcher) {
          try {
            new RegExp(d.matcher);
          } catch (e: any) {
            console.warn(
              `[claw] ignoring hook with invalid matcher regex ${JSON.stringify(d.matcher)}: ${e?.message ?? e}`
            );
            continue;
          }
        }
        hooks.push({ event: event as HookEvent, matcher: d.matcher, command: d.command });
      }
    }
  }
  return hooks;
}

function readSettings(p: string): any {
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}
