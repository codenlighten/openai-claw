# openai-claw audit demo

This directory is a self-contained, reproducible cryptographic audit of a real `openai-claw` session.

A stranger with this directory and a Node.js install can verify the entire chain of evidence in under a minute, with no claw runtime, no OpenAI account, and no SmartLedger dependency beyond `@smartledger.technology/openai-claw-verify` (~11 kB).

## Run it

```bash
git clone https://github.com/codenlighten/openai-claw.git
cd openai-claw/examples/audit-demo
./verify.sh
```

Optional, for full standards-compliant OpenTimestamps introspection:

```bash
# install the official Python OTS client
pipx install opentimestamps-client
# or:
python3 -m venv /tmp/ots-venv && /tmp/ots-venv/bin/pip install opentimestamps-client
```

## What's in here

| File | Role |
|---|---|
| `sample-session.json` | The complete conversation transcript from a real claw session: a user prompt to write `hello.py` and read it back, followed by the agent's tool calls and the model's final reply. |
| `sample-session.attest.json` | The signed Merkle attestation sidecar that claw produced alongside the session. Contains six leaves (one user prompt, two tool calls, two tool results, one assistant text), the Merkle root, an ML-DSA-65 (NIST FIPS-204, post-quantum) signature over the header, and an anchor record from three OpenTimestamps calendars. |
| `proofs/sample-session.alice.ots` | Standards-compliant `.ots` proof from `alice.btc.calendar.opentimestamps.org`. |
| `proofs/sample-session.bob.ots` | Same, from `bob.btc.calendar.opentimestamps.org`. |
| `proofs/sample-session.finney.ots` | Same, from `finney.calendar.eternitywall.com`. |
| `verify.sh` | The reproducible audit script. |

Three calendars from three independent operators — any one of them being honest is enough.

## What `verify.sh` proves

1. **The session existed at or before a Bitcoin block time.** The sha256 of the signed attestation header is in the merge queue of three OpenTimestamps calendars right now. Within ~3 hours of when this artifact was generated, that digest is folded into the calendar's daily Merkle root, which is then committed to Bitcoin via an OP_RETURN transaction. Run `ots upgrade proofs/*.ots && ots verify proofs/*.ots` to chase the chain.
2. **The leaves match the deterministic Merkle root.** Recomputing `merkleRoot(sha256(canonical-JSON(leaf)))` from `sample-session.attest.json` produces the exact value the header was signed over.
3. **The Merkle root was signed by the local ML-DSA-65 identity.** The signature in the sidecar verifies under the public key embedded in the same sidecar.
4. **The `.ots` files are independently parseable by the standard OpenTimestamps tool.** `ots info` recognizes the header magic, the file hash op, the digest, and the pending attestation pointing at each calendar's URL — claw is not in the verification path.
5. **The audit-side package verifies without trusting the runtime agent.** `@smartledger.technology/openai-claw-verify` has no dependency on claw, OpenAI, or the model that produced the session.

## What `verify.sh` does NOT prove

This honesty is what makes the project defensible:

1. **The AI's answer was correct.** Verification proves the agent made these calls and produced this text. It does not prove the text was true.
2. **The user intended every action the AI took.** Verification proves the agent did what is in the sidecar. It does not prove the user wanted it.
3. **The terminal environment was clean.** If the local machine was compromised at the time of the session, the attestor could have been fed false data. The signature would still verify.
4. **The model was honest internally.** Verification covers the I/O boundary. It says nothing about model behavior, alignment, hallucination, or intent.
5. **The Bitcoin block has confirmed yet.** Initially the OTS proofs are pending. They become Bitcoin-anchored automatically within ~3 hours via the calendars' aggregation tree. Run `ots upgrade` to fetch the upgraded proof, then `ots verify`.

## The architecture in one diagram

```
            user prompt    tool calls    tool results    assistant text
                  \           |              |               /
                   \          |              |              /
                    +---------+ leaves +-----+-------------+
                                  |
                                  v
                          deterministic Merkle root
                                  |
                                  v
                         signed by ML-DSA-65 key
                            (NIST FIPS-204)
                                  |
                                  v
                       sha256(canonical-JSON(header))
                                  |
                  +---------------+--------------+
                  v               v              v
              alice.btc        bob.btc       finney
              calendar         calendar     calendar
                  \               |              /
                   \              v             /
                    \    each calendar's daily merge
                     \            |            /
                      v           v           v
                            Bitcoin block
                          (~3 hours later)
```

## Versions used to produce this demo

- `@smartledger.technology/openai-claw` 0.4.1
- `@smartledger.technology/openai-claw-verify` 0.2.0
- `@smartledger/crypto` (ML-DSA-65 suite) 2.0.0
- OpenTimestamps protocol via `pip install opentimestamps-client` for introspection

The artifacts in this directory will continue to verify against future verifier versions as long as the v1 format remains supported (it's an explicit `header.format` field — bumping it produces a clear "unsupported format" error in older clients rather than silent drift).
