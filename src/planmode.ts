/**
 * Plan mode: the assistant proposes a plan but is forbidden from running mutating tools
 * until the user exits plan mode. Enforcement happens in the permission manager — see
 * PermissionManager.check() — and via the system prompt extras.
 */
import type { ClawConfig } from "./config.js";

export function planModeExtra(): string {
  return [
    "You are in PLAN MODE.",
    "Do not write, edit, delete, or run any mutating commands. Instead, propose a step-by-step plan and wait for the user to exit plan mode before executing.",
    "Read-only tools (Read, Grep, Glob, LS, WebFetch, WebSearch) are allowed for investigation.",
    "When the plan is ready, end your message with a single line: 'Ready for plan approval.'",
  ].join("\n");
}

export function setPlanMode(config: ClawConfig, enabled: boolean): void {
  config.permissionMode = enabled ? "plan" : "ask";
}
