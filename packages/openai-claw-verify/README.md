# @smartledger.technology/openai-claw-verify

Standalone verifier for [openai-claw](https://www.npmjs.com/package/@smartledger.technology/openai-claw) attestation sidecars.

`openai-claw` is an OpenAI-powered CLI agent that — when an attestor identity is configured — writes a signed sidecar `<session-id>.attest.json` containing a Merkle root over every tool call, assistant reply, and permission decision in the session. This package is the audit-side companion: zero dependencies on OpenAI, on the model, or on claw itself. Auditors install just this.

## Install

```bash
npm install @smartledger.technology/openai-claw-verify
```

## What it checks

| check | what it proves |
|---|---|
| `format` | the sidecar is a recognized version |
| `leafContinuity` | leaves are sequenced 0..N-1 |
| `merkleRoot` | recomputing `merkleRoot(hash(leaves))` matches `header.merkleRoot` — no leaf was added, removed, or modified |
| `signature` | ML-DSA-65 (NIST FIPS-204, post-quantum) signature on `canonical-JSON(header)` verifies under the embedded public key — header is authentic |
| `sessionAlignment` (optional) | hashing the user_prompt / assistant_text / tool_call payloads found in the session file matches the leaves' `payloadHash` values — the sidecar is bound to *this* session, not a forgery |
| `anchorDigest` (when anchored) | the anchor's submitted digest equals `sha256(canonical-JSON(header))` — the anchor proves the **right** root |
| `mcpProvenance` (when MCP used) | every `mcp__`-prefixed tool call has a preceding `mcp_attach` + `mcp_tool_offered` + `permission_decision` leaf in the sealed sequence |

All hashes are sha256. Canonicalization is JCS-style (RFC 8785): sorted keys, no whitespace, ASCII-safe.

## Usage

```ts
import fs from "node:fs";
import { verifyAttestation } from "@smartledger.technology/openai-claw-verify";

const attestation = JSON.parse(fs.readFileSync("session-xyz.attest.json", "utf8"));
const sessionMessages = JSON.parse(fs.readFileSync("session-xyz.json", "utf8")).messages;

const report = await verifyAttestation(attestation, { strict: true, sessionMessages });

if (!report.ok) {
  console.error("attestation failed:");
  for (const r of report.reasons) console.error("·", r);
  process.exit(1);
}
console.log("verified.");
```

`report.checks` is an object with one boolean per check above; `report.reasons` is a list of human-readable strings describing any failures.

## Why post-quantum

ML-DSA-65 (formerly CRYSTALS-Dilithium, NIST Level 3) is the NIST FIPS-204 standard for digital signatures resistant to attack by a future cryptographically-relevant quantum computer. Choosing it now turns claw's audit log into evidence that remains valid through the classical-quantum transition — a deliberate choice for long-lived compliance, legal, and supply-chain artifacts.

## Anchoring (optional)

Sidecars produced by `claw attest anchor` carry a public-blockchain anchor in the `anchor` field. The verifier checks that the submitted digest matches the header (so the anchor proves the correct root), surfaces `acceptedBy` (the calendars that returned a proof), and reports the anchor's submission time. Full Bitcoin-chain verification is intentionally out of scope — point the `ots verify` standard tool at the calendar responses to chase the chain anchor down. The verifier's job is only to certify the *claw side* of the cryptography.

## Standalone

This package depends only on `@smartledger/crypto` (for the ML-DSA-65 signature suite) and Node 18's built-in `node:crypto` for sha256. It does **not** pull in OpenAI, ink, MCP, or any of claw's many feature dependencies. Total install footprint is small enough to drop into an air-gapped audit machine.

## License

MIT — see [LICENSE](./LICENSE).
