import fs from "node:fs";
import path from "node:path";
function sessionsDir(config) {
    const dir = path.join(config.projectDir, "sessions");
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function newSessionId() {
    // ISO-ish timestamp safe for filenames + 4 random hex chars to disambiguate.
    const now = new Date().toISOString().replace(/[:.]/g, "-");
    const rnd = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
    return `${now}-${rnd}`;
}
function deriveFirstUserPreview(messages) {
    for (const m of messages) {
        if (m.role !== "user")
            continue;
        if (typeof m.content === "string")
            return m.content.slice(0, 80);
        if (Array.isArray(m.content)) {
            const text = m.content.find((p) => p.type === "text");
            if (text)
                return text.text.slice(0, 80);
        }
    }
    return "(no user message)";
}
/**
 * Save the conversation as `${sessionId}.json` in the project's sessions dir.
 * If no sessionId is given, a new one is minted and returned. Pass the same id
 * back on subsequent saves within one run to keep updating the same file.
 */
export function saveSession(config, messages, sessionId) {
    const dir = sessionsDir(config);
    const id = sessionId ?? newSessionId();
    const file = path.join(dir, `${id}.json`);
    const data = {
        id,
        workdir: config.workdir,
        model: config.model,
        savedAt: new Date().toISOString(),
        preview: deriveFirstUserPreview(messages),
        messages,
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return { id, file };
}
/**
 * Load a session. With no id, returns the most recently saved one (legacy
 * single-resume behavior, used by `--continue`).
 */
export function loadSession(config, sessionId) {
    const dir = sessionsDir(config);
    if (sessionId) {
        const file = path.join(dir, `${sessionId}.json`);
        if (!fs.existsSync(file)) {
            // Also accept legacy "last.json" by exact name.
            const legacy = path.join(dir, sessionId);
            if (fs.existsSync(legacy))
                return readSessionFile(legacy);
            return null;
        }
        return readSessionFile(file);
    }
    const summaries = listSessions(config);
    if (summaries.length === 0) {
        // Legacy fallback: a single last.json from before A.3.
        const legacy = path.join(dir, "last.json");
        if (fs.existsSync(legacy))
            return readSessionFile(legacy);
        return null;
    }
    return readSessionFile(path.join(dir, `${summaries[0].id}.json`));
}
export function listSessions(config) {
    const dir = sessionsDir(config);
    const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json") && f !== "last.json")
        .map((f) => path.join(dir, f));
    const summaries = [];
    for (const file of files) {
        const data = readSessionFile(file);
        if (!data)
            continue;
        summaries.push({
            id: data.id,
            savedAt: data.savedAt,
            preview: data.preview ?? "",
            messageCount: data.messages.length,
        });
    }
    summaries.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
    return summaries;
}
/** Snapshot the conversation as a *new* session id (used by /fork). */
export function forkSession(config, messages) {
    return saveSession(config, messages);
}
function readSessionFile(file) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        // Backfill `id` for legacy files saved before A.3.
        if (!raw.id)
            raw.id = path.basename(file, ".json");
        return raw;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=session.js.map