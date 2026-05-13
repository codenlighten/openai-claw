import React from "react";
import { render } from "ink";
import type { Agent } from "../../agent.js";
import type { ClawConfig } from "../../config.js";
import type { PermissionManager } from "../../permissions/index.js";
import { HookRunner } from "../../hooks/index.js";
import { App } from "./App.js";

export async function startTui(opts: {
  agent: Agent;
  config: ClawConfig;
  permissions: PermissionManager;
}): Promise<void> {
  const hooks = new HookRunner(opts.config);
  await hooks.run("SessionStart", { workdir: opts.config.workdir });
  const ink = render(
    <App agent={opts.agent} config={opts.config} permissions={opts.permissions} hooks={hooks} />
  );
  await ink.waitUntilExit();
  await hooks.run("SessionEnd", {});
}
