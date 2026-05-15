import { MlDsa65Suite } from "@smartledger/crypto";
import { canonicalJSON, hashLeaf, hashPayload } from "./leaf.js";
import { merkleRoot } from "./merkle.js";
import { ATTESTATION_FORMAT } from "./attestor.js";
const SUPPORTED_FORMATS = new Set([ATTESTATION_FORMAT]);
const SUPPORTED_SUITES = new Set(["ml-dsa-65"]);
/**
 * Re-derives the Merkle root from `attestation.leaves`, verifies it matches
 * `header.merkleRoot`, then verifies the signature over canonical-JSON(header).
 * If session messages are supplied, also asserts that each leaf's payloadHash
 * is consistent with the session content (otherwise we trust the leaves as-is).
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
    // Leaf sequence must be 0..N-1 in order.
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
    // Recompute Merkle root.
    const root = merkleRoot(attestation.leaves.map(hashLeaf));
    checks.merkleRoot = root === attestation.header.merkleRoot;
    if (!checks.merkleRoot) {
        reasons.push(`merkle root mismatch: got ${root}, header ${attestation.header.merkleRoot}`);
    }
    // Verify signature.
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
    // Optional: cross-check leaves against the session content.
    if (opts.sessionMessages) {
        const alignment = checkSessionAlignment(attestation.leaves, opts.sessionMessages);
        checks.sessionAlignment = alignment.ok;
        if (!alignment.ok)
            reasons.push(...alignment.reasons);
    }
    return {
        ok: reasons.length === 0,
        reasons,
        checks,
    };
}
/**
 * Walks the session message log and the leaf log in parallel, asserting the
 * tool-call / tool-result / assistant-text leaves' payloadHash matches what
 * the session actually says. The order is loose: we count event kinds, not
 * absolute positions, because the agent may emit multiple tool calls per
 * assistant turn before settling on a text reply.
 */
function checkSessionAlignment(leaves, messages) {
    const reasons = [];
    const expectedHashes = new Map();
    // Hashes we expect to see across all leaves of each kind, in encounter order.
    const push = (k, h) => {
        if (!expectedHashes.has(k))
            expectedHashes.set(k, []);
        expectedHashes.get(k).push(h);
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
        if (m.role === "tool") {
            // Tool result content is truncated by the agent before being persisted —
            // we can only check that *some* tool_result leaf with this exact content
            // exists. Skip hashing input (we don't know which call's input it was).
            // For now: don't enforce alignment on tool_result hashes, because the
            // Attestor records pre-truncation content and the session stores
            // post-truncation. A future revision should record both, or have the
            // truncator emit a "truncation" leaf so verification is exact.
        }
    }
    const actual = new Map();
    for (const l of leaves) {
        if (!actual.has(l.kind))
            actual.set(l.kind, []);
        actual.get(l.kind).push(l.payloadHash);
    }
    for (const [kind, expected] of expectedHashes) {
        const seen = actual.get(kind) ?? [];
        // Every expected hash must appear in the leaves' hashes for that kind.
        for (const h of expected) {
            if (!seen.includes(h)) {
                reasons.push(`session has ${kind} payload not present in attestation: ${h.slice(0, 12)}…`);
            }
        }
    }
    return { ok: reasons.length === 0, reasons };
}
//# sourceMappingURL=verify.js.map