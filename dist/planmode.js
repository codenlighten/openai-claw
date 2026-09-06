export function planModeExtra() {
    return [
        "You are in PLAN MODE.",
        "Do not write, edit, delete, or run any mutating commands. Instead, propose a step-by-step plan and wait for the user to exit plan mode before executing.",
        "Read-only tools (Read, Grep, Glob, LS, WebFetch, WebSearch) are allowed for investigation.",
        "When the plan is ready, end your message with a single line: 'Ready for plan approval.'",
    ].join("\n");
}
/**
 * The mode to return to when plan mode is switched off, per config. Keyed by
 * the config object rather than held in a module variable so two agents in one
 * process cannot restore each other's mode.
 */
const previousModes = new WeakMap();
export function setPlanMode(config, enabled, currentMode = config.permissionMode) {
    if (enabled) {
        // Remember where the user was: leaving plan mode used to drop everyone to
        // "ask", silently discarding an acceptEdits or bypassPermissions session.
        if (currentMode !== "plan")
            previousModes.set(config, currentMode);
        config.permissionMode = "plan";
        return;
    }
    const prev = previousModes.get(config);
    config.permissionMode = !prev || prev === "plan" ? "ask" : prev;
    previousModes.delete(config);
}
//# sourceMappingURL=planmode.js.map