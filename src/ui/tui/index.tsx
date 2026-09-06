import React from "react";
import { render } from "ink";
import type { Agent } from "../../agent.js";
import type { ClawConfig } from "../../config.js";
import type { PermissionManager } from "../../permissions/index.js";
import type { SessionAttestor } from "../../attest/index.js";
import { HookRunner } from "../../hooks/index.js";
import { App } from "./App.js";

export async function startTui(opts: {
  agent: Agent;
  config: ClawConfig;
  permissions: PermissionManager;
  sessionAttestor?: SessionAttestor;
}): Promise<void> {
  // ink puts stdin into raw mode; without a TTY it throws from inside a React
  // effect, which surfaces as a component stack trace rather than a cause.
  if (!process.stdin.isTTY) {
    throw new Error(
      "the TUI needs an interactive terminal (stdin is not a TTY) — run `claw -p \"...\"` for non-interactive use"
    );
  }
  const hooks = new HookRunner(opts.config);
  await hooks.run("SessionStart", { workdir: opts.config.workdir });
  const ink = render(
    <App
      agent={opts.agent}
      config={opts.config}
      permissions={opts.permissions}
      hooks={hooks}
      sessionAttestor={opts.sessionAttestor}
    />
  );
  await ink.waitUntilExit();
  await hooks.run("SessionEnd", {});
}
