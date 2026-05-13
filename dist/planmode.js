export function planModeExtra() {
    return [
        "You are in PLAN MODE.",
        "Do not write, edit, delete, or run any mutating commands. Instead, propose a step-by-step plan and wait for the user to exit plan mode before executing.",
        "Read-only tools (Read, Grep, Glob, LS, WebFetch, WebSearch) are allowed for investigation.",
        "When the plan is ready, end your message with a single line: 'Ready for plan approval.'",
    ].join("\n");
}
export function setPlanMode(config, enabled) {
    config.permissionMode = enabled ? "plan" : "ask";
}
//# sourceMappingURL=planmode.js.map