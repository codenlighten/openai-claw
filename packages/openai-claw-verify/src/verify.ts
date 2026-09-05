import { MlDsa65Suite } from "@smartledger/crypto";
import { canonicalJSON, hashLeaf, hashPayload, sha256Hex } from "./leaf.js";
import { merkleRoot } from "./merkle.js";
import type {
  Attestation,
  Leaf,
  SessionMessage,
  VerifyOptions,
  VerifyReport,
} from "./types.js";

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
export async function verifyAttestation(
  attestation: Attestation,
  opts: VerifyOptions = {}
): Promise<VerifyReport> {
  const reasons: string[] = [];
  const checks: VerifyReport["checks"] = {
    format: false,
    signature: false,
    merkleRoot: false,
    leafContinuity: false,
  };

  if (!SUPPORTED_FORMATS.has(attestation.header.format)) {
    reasons.push(`unsupported format: ${attestation.header.format}`);
  } else {
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
  if (!continuous) reasons.push("leaf sequence is not 0..N-1");

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
    if (!checks.signature) reasons.push("signature did not verify");
  } catch (e: any) {
    reasons.push(`signature verification threw: ${e?.message ?? e}`);
  }

  if (opts.sessionMessages) {
    const alignment = checkSessionAlignment(attestation.leaves, opts.sessionMessages);
    checks.sessionAlignment = alignment.ok;
    if (!alignment.ok) reasons.push(...alignment.reasons);
  }

  // Anchor presence/digest check. We don't talk to Bitcoin here — that's
  // standard OTS tooling's job — but we do verify the anchored digest is
  // what we'd submit for THIS header.
  let anchorSummary: VerifyReport["anchor"] | undefined;
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
  } else {
    anchorSummary = { present: false };
  }

  // MCP provenance check. Skipped entirely when the session does not use
  // MCP-prefixed tools (which is most sessions today). When it does, we
  // require — at minimum — that every mcp__-prefixed tool_call is preceded
  // in the leaf sequence by an mcp_attach, an mcp_tool_offered, and a
  // permission_decision. We do NOT yet enforce that those leaves bind to
  // *this specific* tool call by content; that requires the session file
  // to also record MCP-attach events and is tracked for a follow-up.
  let mcpSummary: VerifyReport["mcp"] | undefined;
  if (opts.sessionMessages) {
    const prov = checkMcpProvenance(attestation.leaves, opts.sessionMessages);
    if (prov.applicable) {
      checks.mcpProvenance = prov.ok;
      if (!prov.ok) reasons.push(...prov.reasons);
      mcpSummary = {
        serversSeen: prov.serversSeen,
        toolCallsSignedWithProvenance: prov.signed,
        toolCallsMissingProvenance: prov.missing,
        structural: true,
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

/** Leaf kinds that have a one-to-one counterpart in the session transcript. */
const ALIGNED_KINDS = ["user_prompt", "assistant_text", "tool_call"] as const;

type HashCounts = Map<string, Map<string, number>>;

function bump(counts: HashCounts, kind: string, hash: string): void {
  let byHash = counts.get(kind);
  if (!byHash) {
    byHash = new Map();
    counts.set(kind, byHash);
  }
  byHash.set(hash, (byHash.get(hash) ?? 0) + 1);
}

/**
 * Compare the session transcript against the attested leaves as MULTISETS, in
 * both directions.
 *
 * Counting matters: three identical "continue" prompts must be matched by three
 * leaves, not by one leaf found three times. Direction matters more: checking
 * only session -> attestation means a message DELETED from the transcript still
 * reports as aligned, which is precisely the tampering an audit trail exists to
 * catch. Extra leaves are expected after a compaction (the transcript is
 * rewritten by design), so that direction is reported only for uncompacted
 * sessions.
 */
function checkSessionAlignment(
  leaves: Leaf[],
  messages: SessionMessage[]
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const expected: HashCounts = new Map();
  const push = (k: string, h: string) => bump(expected, k, h);

  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") {
      push("user_prompt", hashPayload({ content: m.content }));
    }
    if (m.role === "assistant") {
      if (m.content && typeof m.content === "string") {
        push("assistant_text", hashPayload({ content: m.content }));
      }
      for (const tc of m.tool_calls ?? []) {
        let parsedInput: unknown = undefined;
        try {
          parsedInput = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          parsedInput = tc.function.arguments;
        }
        push(
          "tool_call",
          hashPayload({ name: tc.function.name, input: parsedInput, callId: tc.id })
        );
      }
    }
    // tool_result alignment intentionally skipped — see verify.ts header note.
  }

  const actual: HashCounts = new Map();
  for (const l of leaves) {
    if (!(ALIGNED_KINDS as readonly string[]).includes(l.kind)) continue;
    bump(actual, l.kind, l.payloadHash);
  }

  for (const kind of ALIGNED_KINDS) {
    const want = expected.get(kind) ?? new Map<string, number>();
    const have = actual.get(kind) ?? new Map<string, number>();
    for (const [hash, n] of want) {
      const seen = have.get(hash) ?? 0;
      if (seen < n) {
        reasons.push(
          `session has ${n - seen} ${kind} payload(s) the attestation does not record: ${hash.slice(0, 12)}…`
        );
      }
    }
  }

  // A compacted session deliberately drops messages the attestation still
  // covers, so unmatched leaves there are expected rather than suspicious.
  const compacted = leaves.some((l) => l.kind === "compaction");
  if (!compacted) {
    for (const kind of ALIGNED_KINDS) {
      const want = expected.get(kind) ?? new Map<string, number>();
      const have = actual.get(kind) ?? new Map<string, number>();
      for (const [hash, n] of have) {
        const wanted = want.get(hash) ?? 0;
        if (n > wanted) {
          reasons.push(
            `attestation records ${n - wanted} ${kind} payload(s) missing from the session transcript: ${hash.slice(0, 12)}… (transcript may have been edited)`
          );
        }
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Detect MCP usage in the session and verify the structural provenance chain in
 * the attestation. "Structural" means kind-counting: mcp_attach,
 * mcp_tool_offered and permission_decision leaves must each exist with a `seq`
 * lower than each MCP-prefixed tool_call leaf they cover.
 *
 * What this DOES NOT prove, and callers must not imply that it does: leaves
 * carry only payload hashes, so a permission_decision recording a REFUSED
 * consent satisfies the check exactly as a granted one does, and a decision
 * about an unrelated tool counts too. Strict per-call binding needs
 * session.json to record MCP events (see whitepaper §9.8).
 */
function checkMcpProvenance(
  leaves: Leaf[],
  messages: SessionMessage[]
): {
  applicable: boolean;
  ok: boolean;
  reasons: string[];
  serversSeen: number;
  signed: number;
  missing: number;
} {
  // Identify mcp__-prefixed tool calls via the session content, and
  // compute their tool_call leaf payload hashes (same algorithm as
  // checkSessionAlignment) so we can locate them in the leaf sequence.
  const mcpToolCallHashes = new Set<string>();
  const mcpServers = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const tc of m.tool_calls ?? []) {
      const name = tc.function.name;
      if (!name.startsWith("mcp__")) continue;
      // Convention: "mcp__<server>__<tool>".
      const server = name.split("__")[1];
      if (server) mcpServers.add(server);
      let parsedInput: unknown = undefined;
      try {
        parsedInput = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
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
  const reasons: string[] = [];
  for (let i = 0; i < leaves.length; i++) {
    const l = leaves[i];
    if (l.kind !== "tool_call") continue;
    if (!mcpToolCallHashes.has(l.payloadHash)) continue;
    const prior = leaves.slice(0, i);
    const hasAttach = prior.some((p) => p.kind === "mcp_attach");
    const hasOffer = prior.some((p) => p.kind === "mcp_tool_offered");
    const hasConsent = prior.some((p) => p.kind === "permission_decision");
    if (hasAttach && hasOffer && hasConsent) {
      signed++;
    } else {
      missing++;
      const lacking: string[] = [];
      if (!hasAttach) lacking.push("mcp_attach");
      if (!hasOffer) lacking.push("mcp_tool_offered");
      if (!hasConsent) lacking.push("permission_decision");
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
