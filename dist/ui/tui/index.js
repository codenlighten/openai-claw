import React from "react";
import { render } from "ink";
import { HookRunner } from "../../hooks/index.js";
import { App } from "./App.js";
export async function startTui(opts) {
    // ink puts stdin into raw mode; without a TTY it throws from inside a React
    // effect, which surfaces as a component stack trace rather than a cause.
    if (!process.stdin.isTTY) {
        throw new Error("the TUI needs an interactive terminal (stdin is not a TTY) — run `claw -p \"...\"` for non-interactive use");
    }
    const hooks = new HookRunner(opts.config);
    await hooks.run("SessionStart", { workdir: opts.config.workdir });
    const ink = render(React.createElement(App, { agent: opts.agent, config: opts.config, permissions: opts.permissions, hooks: hooks, sessionAttestor: opts.sessionAttestor }));
    await ink.waitUntilExit();
    await hooks.run("SessionEnd", {});
}
//# sourceMappingURL=index.js.map