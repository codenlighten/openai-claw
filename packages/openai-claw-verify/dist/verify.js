import { MlDsa65Suite } from "@smartledger/crypto";
import { canonicalJSON, hashLeaf, hashPayload, sha256Hex } from "./leaf.js";
import { merkleRoot } from "./merkle.js";
const SUPPORTED_FORMATS = new Set(["openai-claw.attestation.v1"]);
const SUPPORTED_SUITES = new Set(["ml-dsa-65"]);
/**
 * Verifier for openai-claw attestation sidecars.
 *
 *   1. Header format and suite must be supported (strict mode only).
 *   2. Leaves are sequenced 0..N-1.
 *   3. Recomputed Merkle root from `attestation.leaves` matches `header.merkleRoot`.
 *   4. The signature verifies under the embedded public key over
 *      canonical-JSON(header).
 *   5. If `sessionMessages` is supplied, each user_prompt / assistant_text /
 *      tool_call payload found in the session must have a matching leaf
 *      payloadHash. Tool results are not currently aligned because claw
 *      truncates them before persisting — fix tracked upstream.
 */
export async function verifyAttestation(attestation, opts = {}) {
    const reasons = [];
    const checks = {
        format: false,
        signature: false,
        merkleRoot: false,
        leafContinuity: false,
    };
    if (!SUPPORTED_FORMATS.has(attestation.header.format)) {
        reasons.push(`unsupported format: ${attestation.header.format}`);
    }
    else {
        checks.format = true;
    }
    if (opts.strict && !SUPPORTED_SUITES.has(attestation.header.suiteId)) {
        reasons.push(`unsupported suite: ${attestation.header.suiteId}`);
    }
    let continuous = attestation.leaves.length === attestation.header.leafCount;
    for (let i = 0; i < attestation.leaves.length; i++) {
        if (attestation.leaves[i].seq !== i) {
            continuous = false;
            break;
        }
    }
    checks.leafContinuity = continuous;
    if (!continuous)
        reasons.push("leaf sequence is not 0..N-1");
    const root = merkleRoot(attestation.leaves.map(hashLeaf));
    checks.merkleRoot = root === attestation.header.merkleRoot;
    if (!checks.merkleRoot) {
        reasons.push(`merkle root mismatch: got ${root}, header ${attestation.header.merkleRoot}`);
    }
    try {
        const suite = new MlDsa65Suite();
        const pub = Buffer.from(attestation.header.publicKey, "base64");
        const sig = Buffer.from(attestation.signature, "base64");
        const message = Buffer.from(canonicalJSON(attestation.header), "utf8");
        checks.signature = await suite.verify(pub, message, sig);
        if (!checks.signature)
            reasons.push("signature did not verify");
    }
    catch (e) {
        reasons.push(`signature verification threw: ${e?.message ?? e}`);
    }
    if (opts.sessionMessages) {
        const alignment = checkSessionAlignment(attestation.leaves, opts.sessionMessages);
        checks.sessionAlignment = alignment.ok;
        if (!alignment.ok)
            reasons.push(...alignment.reasons);
    }
    // Anchor presence/digest check. We don't talk to Bitcoin here — that's
    // standard OTS tooling's job — but we do verify the anchored digest is
    // what we'd submit for THIS header.
    let anchorSummary;
    if (attestation.anchor) {
        const expected = sha256Hex(canonicalJSON(attestation.header));
        const match = expected === attestation.anchor.digest;
        checks.anchorDigest = match;
        if (!match) {
            reasons.push(`anchor digest does not match sha256(header): got ${attestation.anchor.digest}, expected ${expected}`);
        }
        anchorSummary = {
            present: true,
            type: attestation.anchor.type,
            submittedAt: attestation.anchor.submittedAt,
            acceptedBy: attestation.anchor.calendars.filter((c) => c.ok).map((c) => c.url),
        };
    }
    else {
        anchorSummary = { present: false };
    }
    // MCP provenance check. Skipped entirely when the session does not use
    // MCP-prefixed tools (which is most sessions today). When it does, we
    // require — at minimum — that every mcp__-prefixed tool_call is preceded
    // in the leaf sequence by an mcp_attach, an mcp_tool_offered, and a
    // permission_decision. We do NOT yet enforce that those leaves bind to
    // *this specific* tool call by content; that requires the session file
    // to also record MCP-attach events and is tracked for a follow-up.
    let mcpSummary;
    if (opts.sessionMessages) {
        const prov = checkMcpProvenance(attestation.leaves, opts.sessionMessages);
        if (prov.applicable) {
            checks.mcpProvenance = prov.ok;
            if (!prov.ok)
                reasons.push(...prov.reasons);
            mcpSummary = {
                serversSeen: prov.serversSeen,
                toolCallsSignedWithProvenance: prov.signed,
                toolCallsMissingProvenance: prov.missing,
            };
        }
    }
    return {
        ok: reasons.length === 0,
        reasons,
        checks,
        anchor: anchorSummary,
        mcp: mcpSummary,
    };
}
function checkSessionAlignment(leaves, messages) {
    const reasons = [];
    const expected = new Map();
    const push = (k, h) => {
        if (!expected.has(k))
            expected.set(k, []);
        expected.get(k).push(h);
    };
    for (const m of messages) {
        if (m.role === "user" && typeof m.content === "string") {
            push("user_prompt", hashPayload({ content: m.content }));
        }
        if (m.role === "assistant") {
            if (m.content && typeof m.content === "string") {
                push("assistant_text", hashPayload({ content: m.content }));
            }
            for (const tc of m.tool_calls ?? []) {
                let parsedInput = undefined;
                try {
                    parsedInput = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
                }
                catch {
                    parsedInput = tc.function.arguments;
                }
                push("tool_call", hashPayload({ name: tc.function.name, input: parsedInput, callId: tc.id }));
            }
        }
        // tool_result alignment intentionally skipped — see verify.ts header note.
    }
    const actual = new Map();
    for (const l of leaves) {
        if (!actual.has(l.kind))
            actual.set(l.kind, []);
        actual.get(l.kind).push(l.payloadHash);
    }
    for (const [kind, hashes] of expected) {
        const seen = actual.get(kind) ?? [];
        for (const h of hashes) {
            if (!seen.includes(h)) {
                reasons.push(`session has ${kind} payload not present in attestation: ${h.slice(0, 12)}…`);
            }
        }
    }
    return { ok: reasons.length === 0, reasons };
}
/**
 * Detect MCP usage in the session and verify the structural provenance
 * chain in the attestation. "Structural" here means kind-counting:
 * mcp_attach, mcp_tool_offered, and permission_decision leaves must each
 * exist with a `seq` lower than each MCP-prefixed tool_call leaf they
 * cover. Strict per-call binding is deferred until session.json itself
 * records MCP events (see whitepaper §9.8).
 */
function checkMcpProvenance(leaves, messages) {
    // Identify mcp__-prefixed tool calls via the session content, and
    // compute their tool_call leaf payload hashes (same algorithm as
    // checkSessionAlignment) so we can locate them in the leaf sequence.
    const mcpToolCallHashes = new Set();
    const mcpServers = new Set();
    for (const m of messages) {
        if (m.role !== "assistant")
            continue;
        for (const tc of m.tool_calls ?? []) {
            const name = tc.function.name;
            if (!name.startsWith("mcp__"))
                continue;
            // Convention: "mcp__<server>__<tool>".
            const server = name.split("__")[1];
            if (server)
                mcpServers.add(server);
            let parsedInput = undefined;
            try {
                parsedInput = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
            }
            catch {
                parsedInput = tc.function.arguments;
            }
            mcpToolCallHashes.add(hashPayload({ name, input: parsedInput, callId: tc.id }));
        }
    }
    if (mcpServers.size === 0) {
        return { applicable: false, ok: true, reasons: [], serversSeen: 0, signed: 0, missing: 0 };
    }
    // For each MCP-prefixed tool_call leaf, scan earlier leaves for the
    // required provenance triple (attach + offer + consent).
    let signed = 0;
    let missing = 0;
    const reasons = [];
    for (let i = 0; i < leaves.length; i++) {
        const l = leaves[i];
        if (l.kind !== "tool_call")
            continue;
        if (!mcpToolCallHashes.has(l.payloadHash))
            continue;
        const prior = leaves.slice(0, i);
        const hasAttach = prior.some((p) => p.kind === "mcp_attach");
        const hasOffer = prior.some((p) => p.kind === "mcp_tool_offered");
        const hasConsent = prior.some((p) => p.kind === "permission_decision");
        if (hasAttach && hasOffer && hasConsent) {
            signed++;
        }
        else {
            missing++;
            const lacking = [];
            if (!hasAttach)
                lacking.push("mcp_attach");
            if (!hasOffer)
                lacking.push("mcp_tool_offered");
            if (!hasConsent)
                lacking.push("permission_decision");
            reasons.push(`mcp tool_call at seq=${l.seq} lacks ${lacking.join(", ")} before it`);
        }
    }
    return {
        applicable: true,
        ok: missing === 0,
        reasons,
        serversSeen: mcpServers.size,
        signed,
        missing,
    };
}
//# sourceMappingURL=verify.js.map