import React from "react";
import { render } from "ink";
import { HookRunner } from "../../hooks/index.js";
import { App } from "./App.js";
export async function startTui(opts) {
    const hooks = new HookRunner(opts.config);
    await hooks.run("SessionStart", { workdir: opts.config.workdir });
    const ink = render(React.createElement(App, { agent: opts.agent, config: opts.config, permissions: opts.permissions, hooks: hooks, sessionAttestor: opts.sessionAttestor }));
    await ink.waitUntilExit();
    await hooks.run("SessionEnd", {});
}
//# sourceMappingURL=index.js.map