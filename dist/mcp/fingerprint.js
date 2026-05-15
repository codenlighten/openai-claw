import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
export function computeFingerprint(input) {
    if (input.config.type === "http") {
        const fp = {
            transport: "http",
            name: input.name,
            endpoint: input.config.url,
            serverVersion: input.serverInfo?.version,
            fingerprintId: "",
        };
        fp.fingerprintId = idFor(fp);
        return fp;
    }
    // stdio
    const stdioConfig = input.config;
    const resolved = resolveBinary(stdioConfig.command);
    const binarySha256 = resolved ? sha256OfFile(resolved) ?? undefined : undefined;
    const envNames = Object.keys({
        ...process.env,
        ...(stdioConfig.env ?? {}),
    }).sort();
    const fp = {
        transport: "stdio",
        name: input.name,
        endpoint: resolved ?? stdioConfig.command,
        binarySha256,
        args: stdioConfig.args ?? [],
        envNames,
        serverVersion: input.serverInfo?.version,
        fingerprintId: "",
    };
    fp.fingerprintId = idFor(fp);
    return fp;
}
/**
 * Resolve a stdio command to an absolute path. If the command is already
 * absolute we use it as-is; otherwise consult `which` via the shell.
 */
function resolveBinary(command) {
    if (command.startsWith("/")) {
        return fs.existsSync(command) ? command : null;
    }
    try {
        const out = execFileSync("/bin/sh", ["-c", `command -v ${shellQuote(command)}`], {
            encoding: "utf8",
            timeout: 1000,
        }).trim();
        return out.length > 0 && fs.existsSync(out) ? out : null;
    }
    catch {
        return null;
    }
}
function sha256OfFile(path) {
    try {
        const buf = fs.readFileSync(path);
        return createHash("sha256").update(buf).digest("hex");
    }
    catch {
        return null;
    }
}
/**
 * 16-char base64url fingerprint over the entire deterministic record. This
 * is what the consent store uses as a key and what `claw mcp list` shows.
 */
function idFor(fp) {
    const canonical = JSON.stringify({
        transport: fp.transport,
        endpoint: fp.endpoint,
        binarySha256: fp.binarySha256 ?? null,
        args: fp.args ?? null,
        envNames: fp.envNames ?? null,
        serverVersion: fp.serverVersion ?? null,
    }, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value).sort().reduce((acc, k) => { acc[k] = value[k]; return acc; }, {})
        : value);
    return createHash("sha256")
        .update(canonical)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
        .slice(0, 16);
}
function shellQuote(s) {
    // Conservative — only allow [A-Za-z0-9._/-]; reject anything else by
    // returning a non-resolvable token. Avoids passing shell metacharacters
    // into `command -v`.
    return /^[A-Za-z0-9._/-]+$/.test(s) ? s : "__claw_invalid_command__";
}
//# sourceMappingURL=fingerprint.js.map