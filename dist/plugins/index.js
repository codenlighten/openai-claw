import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
// Small, hardcoded registry. Names map to git URLs. Extend or replace freely.
export const REGISTRY = {
    "pdf-skill": {
        url: "https://github.com/codenlighten/openai-claw-pdf-skill.git",
        description: "PDF table-extraction skill (placeholder registry entry)",
    },
    "security-reviewer": {
        url: "https://github.com/codenlighten/openai-claw-security-reviewer.git",
        description: "Security-review subagent (placeholder registry entry)",
    },
};
export function pluginsDir(config) {
    const dir = path.join(config.homeDir, "plugins");
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return dir;
}
export function lockfilePath(config) {
    const dir = path.join(config.workdir, ".claw");
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "plugins.lock");
}
export function readLockfile(config) {
    const file = lockfilePath(config);
    if (!fs.existsSync(file))
        return { version: 1, plugins: [] };
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return { version: 1, plugins: [] };
    }
}
function writeLockfile(config, lock) {
    fs.writeFileSync(lockfilePath(config), JSON.stringify(lock, null, 2));
}
function detectName(source) {
    if (REGISTRY[source])
        return source;
    // git URL → last path segment, drop .git
    const base = source.split("/").pop() ?? source;
    return base.replace(/\.git$/, "");
}
function resolveUrl(source) {
    return REGISTRY[source]?.url ?? source;
}
function detectProvides(pluginDir) {
    const skills = [];
    const agents = [];
    const mcp = [];
    const skillsDir = path.join(pluginDir, "skills");
    if (fs.existsSync(skillsDir)) {
        for (const e of fs.readdirSync(skillsDir)) {
            if (fs.existsSync(path.join(skillsDir, e, "SKILL.md")))
                skills.push(e);
        }
    }
    const agentsDir = path.join(pluginDir, "agents");
    if (fs.existsSync(agentsDir)) {
        for (const e of fs.readdirSync(agentsDir)) {
            if (e.endsWith(".md"))
                agents.push(e);
        }
    }
    const mcpFile = path.join(pluginDir, "mcp.json");
    if (fs.existsSync(mcpFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
            if (data?.mcpServers && typeof data.mcpServers === "object") {
                mcp.push(...Object.keys(data.mcpServers));
            }
        }
        catch { }
    }
    return { skills, agents, mcp };
}
function gitClone(url, dest) {
    const res = spawnSync("git", ["clone", "--depth", "1", url, dest], { encoding: "utf8" });
    if (res.status !== 0)
        return { ok: false, error: (res.stderr || res.stdout || "git clone failed").trim() };
    const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dest, encoding: "utf8" });
    return { ok: true, ref: (rev.stdout || "").trim() };
}
function linkIntoUserConfig(config, pluginDir, provides) {
    // Skills: symlink each skill directory into ~/.openai-claw/skills/<name>.
    if (provides.skills.length) {
        const target = path.join(config.homeDir, "skills");
        fs.mkdirSync(target, { recursive: true });
        for (const s of provides.skills) {
            const link = path.join(target, s);
            const src = path.resolve(pluginDir, "skills", s);
            try {
                fs.unlinkSync(link);
            }
            catch { }
            try {
                fs.symlinkSync(src, link, "dir");
            }
            catch {
                // fallback: copy directory contents (symlinks may be disabled)
                copyDir(src, link);
            }
        }
    }
    // Agents: symlink each .md into ~/.openai-claw/agents/.
    if (provides.agents.length) {
        const target = path.join(config.homeDir, "agents");
        fs.mkdirSync(target, { recursive: true });
        for (const a of provides.agents) {
            const link = path.join(target, a);
            const src = path.resolve(pluginDir, "agents", a);
            try {
                fs.unlinkSync(link);
            }
            catch { }
            try {
                fs.symlinkSync(src, link, "file");
            }
            catch {
                try {
                    fs.copyFileSync(src, link);
                }
                catch { }
            }
        }
    }
    // MCP: merge into ~/.openai-claw/settings.json
    if (provides.mcp.length) {
        try {
            const mcpData = JSON.parse(fs.readFileSync(path.join(pluginDir, "mcp.json"), "utf8"));
            const settingsPath = path.join(config.homeDir, "settings.json");
            const current = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
            current.mcpServers = { ...(current.mcpServers ?? {}), ...mcpData.mcpServers };
            fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2));
        }
        catch {
            // non-fatal
        }
    }
}
function unlinkFromUserConfig(config, entry) {
    for (const s of entry.provides.skills) {
        const link = path.join(config.homeDir, "skills", s);
        try {
            fs.rmSync(link, { recursive: true, force: true });
        }
        catch { }
    }
    for (const a of entry.provides.agents) {
        const link = path.join(config.homeDir, "agents", a);
        try {
            fs.rmSync(link, { force: true });
        }
        catch { }
    }
    if (entry.provides.mcp.length) {
        try {
            const settingsPath = path.join(config.homeDir, "settings.json");
            if (!fs.existsSync(settingsPath))
                return;
            const current = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
            for (const m of entry.provides.mcp) {
                if (current.mcpServers)
                    delete current.mcpServers[m];
            }
            fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2));
        }
        catch { }
    }
}
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name);
        const d = path.join(dest, e.name);
        if (e.isDirectory())
            copyDir(s, d);
        else
            fs.copyFileSync(s, d);
    }
}
export function installPlugin(config, source) {
    const name = detectName(source);
    const url = resolveUrl(source);
    const dir = path.join(pluginsDir(config), name);
    if (fs.existsSync(dir))
        return { ok: false, error: `Plugin '${name}' already installed at ${dir}. Use /plugins remove ${name} first.` };
    const cloned = gitClone(url, dir);
    if (!cloned.ok) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        catch { }
        return { ok: false, error: cloned.error };
    }
    const provides = detectProvides(dir);
    const entry = {
        name,
        source: url,
        installedAt: new Date().toISOString(),
        ref: cloned.ref,
        provides,
    };
    linkIntoUserConfig(config, dir, provides);
    const lock = readLockfile(config);
    lock.plugins = lock.plugins.filter((p) => p.name !== name).concat(entry);
    writeLockfile(config, lock);
    return { ok: true, entry };
}
export function removePlugin(config, name) {
    const lock = readLockfile(config);
    const idx = lock.plugins.findIndex((p) => p.name === name);
    if (idx < 0)
        return { ok: false, error: `Plugin '${name}' is not installed.` };
    const entry = lock.plugins[idx];
    unlinkFromUserConfig(config, entry);
    const dir = path.join(pluginsDir(config), name);
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    catch { }
    lock.plugins.splice(idx, 1);
    writeLockfile(config, lock);
    return { ok: true, entry };
}
export function listInstalled(config) {
    return readLockfile(config).plugins;
}
export function searchRegistry(query) {
    const q = query.toLowerCase();
    return Object.entries(REGISTRY)
        .filter(([name, info]) => name.toLowerCase().includes(q) || info.description.toLowerCase().includes(q))
        .map(([name, info]) => ({ name, ...info }));
}
//# sourceMappingURL=index.js.map