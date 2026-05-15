import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { Attestor } from "./attestor.js";
import { loadIdentity } from "./identity.js";
/**
 * One-stop session-level attestation wrapper. Sits between any UI surface
 * (one-shot, REPL, TUI) and the lower-level Attestor.
 *
 * Behaviour:
 * - No identity configured → all methods are no-ops, `enabled` is false. The
 *   UI never has to special-case the "attestation off" path.
 * - Identity configured but session is being resumed → emit a one-line
 *   warning and behave as no-op. The previous sidecar (if any) is preserved.
 * - Identity configured + fresh session → build one Attestor for the whole
 *   session; the same instance accumulates leaves across turns.
 *
 * `writeSidecar(sessionId)` is intended to be called from the same `finally`
 * block as `saveSession`. Each call overwrites the sidecar, so the file on
 * disk always reflects the *cumulative* attestation up to the last save.
 */
export class SessionAttestor {
    config;
    attestor = null;
    status;
    constructor(config, opts = {}) {
        this.config = config;
        if (opts.disabled) {
            this.status = "disabled";
            return;
        }
        const id = loadIdentity(config);
        if (!id) {
            this.status = "no-identity";
            if (!opts.quietWhenNoIdentity) {
                // Off by default; surfaced only if the caller asked for it.
                console.error(chalk.dim("[attest] no attestor identity — run `claw attest init` to start signing sessions"));
            }
            return;
        }
        if (opts.resumed) {
            this.status = "resumed";
            console.error(chalk.yellow("[attest] not attesting a resumed session — existing sidecar (if any) is preserved. Use a fresh session to start a new attestation."));
            return;
        }
        this.attestor = new Attestor(id);
        this.status = "active";
    }
    get enabled() {
        return this.status === "active";
    }
    get leafCount() {
        return this.attestor?.leafCount ?? 0;
    }
    recordUserPrompt(text) {
        this.attestor?.record("user_prompt", { content: text });
    }
    onAgentEvent(evt) {
        this.attestor?.onAgentEvent(evt);
    }
    /**
     * Emit MCP-attach / tool-offer / per-server-consent leaves for every
     * currently-connected server. Call once at session start, before the
     * agent begins running, so any subsequent mcp__-prefixed tool_call
     * leaves have the provenance triple in front of them.
     *
     * The `trustedByProject` flag carries the result of the existing
     * project-level trust gate forward into a signed permission_decision
     * leaf — so even before per-server consent UX lands in 0.6.1, the
     * mcpProvenance check has something to find.
     */
    recordMcpServers(servers, trustedByProject) {
        if (!this.attestor)
            return;
        for (const s of servers) {
            this.attestor.record("mcp_attach", {
                server: s.name,
                transport: s.fingerprint.transport,
                endpoint: s.fingerprint.endpoint,
                binarySha256: s.fingerprint.binarySha256 ?? null,
                args: s.fingerprint.args ?? null,
                envNames: s.fingerprint.envNames ?? null,
                serverVersion: s.fingerprint.serverVersion ?? null,
                fingerprintId: s.fingerprint.fingerprintId,
            });
            for (const t of s.toolOfferings) {
                this.attestor.record("mcp_tool_offered", {
                    server: s.name,
                    serverFingerprintId: s.fingerprint.fingerprintId,
                    tool: t.toolName,
                    schemaSha256: t.schemaSha256,
                    descriptionSha256: t.descriptionSha256,
                });
            }
            this.attestor.record("permission_decision", {
                kind: "mcp",
                server: s.name,
                serverFingerprintId: s.fingerprint.fingerprintId,
                consent: trustedByProject ? "yes" : "no",
                scope: "project-trust", // upgrades to "per-server" in 0.6.1
            });
        }
    }
    /**
     * Write `<sessionId>.attest.json` next to `<sessionId>.json`. Returns the
     * file path on success, or null when no sidecar was written (because the
     * attestor isn't active or finalization failed).
     */
    async writeSidecar(sessionId) {
        if (!this.attestor)
            return null;
        try {
            const attestation = await this.attestor.finalize(sessionId);
            const sidecar = path.join(this.config.projectDir, "sessions", `${sessionId}.attest.json`);
            fs.writeFileSync(sidecar, JSON.stringify(attestation, null, 2));
            return sidecar;
        }
        catch (e) {
            console.error(chalk.yellow(`[attest] could not write attestation: ${e?.message ?? e}`));
            return null;
        }
    }
}
//# sourceMappingURL=runtime.js.map