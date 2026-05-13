import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
export class HookRunner {
    hooks = [];
    constructor(config) {
        this.hooks = loadHooks(config);
    }
    async run(event, payload) {
        const matches = this.hooks.filter((h) => {
            if (h.event !== event)
                return false;
            if (h.matcher && payload.tool_name) {
                try {
                    return new RegExp(h.matcher).test(String(payload.tool_name));
                }
                catch {
                    return false;
                }
            }
            return true;
        });
        const outcomes = [];
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
function loadHooks(config) {
    const userSettings = readSettings(path.join(config.homeDir, "settings.json"));
    const projectSettings = readSettings(path.join(config.workdir, ".claw", "settings.json"));
    const hooks = [];
    for (const s of [userSettings, projectSettings]) {
        if (!s.hooks)
            continue;
        for (const [event, defs] of Object.entries(s.hooks)) {
            if (!Array.isArray(defs))
                continue;
            for (const d of defs) {
                if (!d?.command)
                    continue;
                hooks.push({ event: event, matcher: d.matcher, command: d.command });
            }
        }
    }
    return hooks;
}
function readSettings(p) {
    try {
        if (!fs.existsSync(p))
            return {};
        return JSON.parse(fs.readFileSync(p, "utf8"));
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=index.js.map