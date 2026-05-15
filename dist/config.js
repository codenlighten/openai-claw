import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const DEFAULTS = {
    model: "gpt-5-nano",
    contextWindow: 200_000,
    compactThreshold: 0.85,
    permissionMode: "ask",
    maxTurns: 50,
    maxToolResultChars: 50_000,
    models: { cheap: "gpt-5-nano", default: "gpt-5-nano", reasoning: "gpt-5" },
};
function resolveProjectDir(workdir) {
    const slug = workdir.replace(/[\/\\:]/g, "-").replace(/^-+/, "");
    return path.join(os.homedir(), ".openai-claw", "projects", slug);
}
export function loadConfig(overrides = {}) {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if (!apiKey) {
        throw new Error("OPENAI_API_KEY is not set. Export it in your shell or add it to your .env file.");
    }
    const workdir = overrides.workdir ?? process.cwd();
    const homeDir = path.join(os.homedir(), ".openai-claw");
    const projectDir = resolveProjectDir(workdir);
    const memoryDir = path.join(projectDir, "memory");
    for (const dir of [homeDir, projectDir, memoryDir]) {
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
    }
    // Merge with project-level + user-level settings.json if present.
    const userSettings = readJsonSafe(path.join(homeDir, "settings.json"));
    const projectSettings = readJsonSafe(path.join(workdir, ".claw", "settings.json"));
    const merged = {
        model: process.env.OPENAI_CLAW_MODEL ?? userSettings.model ?? projectSettings.model ?? DEFAULTS.model,
        apiKey,
        baseURL: process.env.OPENAI_BASE_URL ?? userSettings.baseURL ?? projectSettings.baseURL,
        maxTokens: projectSettings.maxTokens ?? userSettings.maxTokens,
        temperature: projectSettings.temperature ?? userSettings.temperature,
        contextWindow: projectSettings.contextWindow ?? userSettings.contextWindow ?? DEFAULTS.contextWindow,
        compactThreshold: projectSettings.compactThreshold ?? userSettings.compactThreshold ?? DEFAULTS.compactThreshold,
        permissionMode: projectSettings.permissionMode ?? userSettings.permissionMode ?? DEFAULTS.permissionMode,
        allowedTools: [...(userSettings.allowedTools ?? []), ...(projectSettings.allowedTools ?? [])],
        deniedTools: [...(userSettings.deniedTools ?? []), ...(projectSettings.deniedTools ?? [])],
        maxTurns: projectSettings.maxTurns ?? userSettings.maxTurns ?? DEFAULTS.maxTurns,
        maxToolResultChars: projectSettings.maxToolResultChars ?? userSettings.maxToolResultChars ?? DEFAULTS.maxToolResultChars,
        models: { ...DEFAULTS.models, ...(userSettings.models ?? {}), ...(projectSettings.models ?? {}) },
        workdir,
        homeDir,
        projectDir,
        memoryDir,
        ...overrides,
    };
    return merged;
}
function readJsonSafe(p) {
    try {
        if (!fs.existsSync(p))
            return {};
        return JSON.parse(fs.readFileSync(p, "utf8"));
    }
    catch {
        return {};
    }
}
export function saveUserSetting(config, key, value) {
    const p = path.join(config.homeDir, "settings.json");
    withSettingsLock(p, () => {
        const current = readJsonSafe(p);
        current[key] = value;
        fs.writeFileSync(p, JSON.stringify(current, null, 2));
    });
}
// Two concurrent claw sessions both answering "save" can otherwise lose
// one of the writes (classic read-modify-write race). We serialize via
// an exclusive sibling lockfile with a short retry loop — no new dep.
function withSettingsLock(targetPath, fn) {
    const lockPath = targetPath + ".lock";
    const maxAttempts = 20;
    let fd = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            fd = fs.openSync(lockPath, "wx");
            break;
        }
        catch (e) {
            if (e?.code !== "EEXIST")
                throw e;
            // Sleep ~50ms synchronously without spinning.
            const until = Date.now() + 50;
            while (Date.now() < until) {
                // no-op busy-wait; acceptable for short lock waits in a CLI
            }
        }
    }
    if (fd === null) {
        // Last-resort: give up the lock and proceed. Better to risk a race
        // than to permanently block on a stale .lock.
        try {
            fs.rmSync(lockPath, { force: true });
        }
        catch { }
        return fn();
    }
    try {
        return fn();
    }
    finally {
        try {
            fs.closeSync(fd);
        }
        catch { }
        try {
            fs.rmSync(lockPath, { force: true });
        }
        catch { }
    }
}
//# sourceMappingURL=config.js.map