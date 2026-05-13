import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
function loadNotifyConfig(config) {
    const user = readJson(path.join(config.homeDir, "settings.json"));
    const proj = readJson(path.join(config.workdir, ".claw", "settings.json"));
    const merged = { ...(user?.notifications ?? {}), ...(proj?.notifications ?? {}) };
    if (!merged.desktop && !merged.slack && !merged.ntfy)
        return null;
    return merged;
}
export async function notify(config, evt) {
    const cfg = loadNotifyConfig(config);
    if (!cfg)
        return;
    const min = cfg.minDurationSec ?? 30;
    if (evt.durationSec !== undefined && evt.durationSec < min)
        return;
    const calls = [];
    if (cfg.desktop)
        calls.push(sendDesktop(evt));
    if (cfg.slack?.webhook)
        calls.push(sendSlack(cfg.slack.webhook, evt));
    if (cfg.ntfy?.url)
        calls.push(sendNtfy(cfg.ntfy, evt));
    await Promise.allSettled(calls);
}
async function sendDesktop(evt) {
    const title = `claw: ${evt.title}`;
    const body = evt.body.slice(0, 200);
    return new Promise((resolve) => {
        if (os.platform() === "darwin") {
            const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
            const p = spawn("osascript", ["-e", script], { stdio: "ignore" });
            p.on("close", () => resolve());
            p.on("error", () => resolve());
            return;
        }
        if (os.platform() === "linux") {
            const p = spawn("notify-send", [title, body], { stdio: "ignore" });
            p.on("close", () => resolve());
            p.on("error", () => resolve()); // missing binary is non-fatal
            return;
        }
        resolve();
    });
}
async function sendSlack(webhook, evt) {
    try {
        await fetch(webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: `*claw — ${evt.title}*\n${evt.body}` }),
        });
    }
    catch {
        // notifications never crash the agent
    }
}
async function sendNtfy(cfg, evt) {
    try {
        const headers = { Title: `claw — ${evt.title}` };
        if (cfg.priority === "high")
            headers.Priority = "high";
        await fetch(cfg.url, { method: "POST", headers, body: evt.body });
    }
    catch { }
}
function readJson(p) {
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