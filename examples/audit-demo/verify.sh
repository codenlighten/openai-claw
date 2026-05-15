#!/usr/bin/env bash
# verify.sh — reproduce, in under a minute, the cryptographic audit
# of a real openai-claw session.
#
# Inputs (all committed in this directory):
#   sample-session.json         — the conversation transcript
#   sample-session.attest.json  — claw's signed Merkle attestation sidecar
#   proofs/sample-session.alice.ots
#   proofs/sample-session.bob.ots
#   proofs/sample-session.finney.ots    — OpenTimestamps proofs from three
#                                 independent calendars
#
# What this script does:
#   1. Uses @smartledger.technology/openai-claw-verify to check the
#      ML-DSA-65 signature, recompute the Merkle root, and cross-
#      reference each leaf's payload hash against the session file.
#   2. (Optional) Uses the standard `ots` CLI to introspect each .ots
#      file. If `ots` is not installed the script prints how to install
#      it and skips this step.
#
# What is proven by this script:
#   - The Merkle root in the sidecar header matches the leaves shown.
#   - The header was signed by the public key embedded in the sidecar.
#   - Each leaf's payloadHash matches the session content.
#   - The .ots files are well-formed and contain a pending attestation
#     pointing at the corresponding OpenTimestamps calendar.
#
# What is NOT proven:
#   - That the AI answer was true.
#   - That the user intended every action the AI took.
#   - That the local machine was uncompromised when the session ran.
#   - That the Bitcoin block has confirmed yet (run `ots upgrade`
#     and `ots verify` after ~3 hours to chase the chain anchor).
set -euo pipefail
cd "$(dirname "$0")"

cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
dim()    { printf '\033[2m%s\033[0m\n' "$*"; }

cyan "== step 1: install the standalone verifier"
if [ ! -d node_modules ]; then
  npm init -y >/dev/null
  npm install --silent @smartledger.technology/openai-claw-verify
fi
green "  installed @smartledger.technology/openai-claw-verify"

cyan "== step 2: run the verifier against the committed fixtures"
node --input-type=module -e "
import fs from 'node:fs';
import { verifyAttestation } from '@smartledger.technology/openai-claw-verify';
const att = JSON.parse(fs.readFileSync('sample-session.attest.json', 'utf8'));
const msgs = JSON.parse(fs.readFileSync('sample-session.json', 'utf8')).messages;
const r = await verifyAttestation(att, { strict: true, sessionMessages: msgs });
console.log('  format:             ' + (r.checks.format ? 'OK' : 'FAIL'));
console.log('  leafContinuity:     ' + (r.checks.leafContinuity ? 'OK' : 'FAIL'));
console.log('  merkleRoot:         ' + (r.checks.merkleRoot ? 'OK' : 'FAIL'));
console.log('  signature:          ' + (r.checks.signature ? 'OK' : 'FAIL'));
console.log('  sessionAlignment:   ' + (r.checks.sessionAlignment ? 'OK' : 'FAIL'));
console.log('  anchorDigest:       ' + (r.checks.anchorDigest === true ? 'OK' : (r.checks.anchorDigest === false ? 'FAIL' : 'absent')));
console.log('  anchor:             ' + (r.anchor?.present ? r.anchor.type + ' (accepted by ' + (r.anchor.acceptedBy?.length ?? 0) + ' calendars)' : 'absent'));
console.log('');
console.log('  publicKeyId:        ' + att.header.publicKeyId);
console.log('  sessionId:          ' + att.header.sessionId);
console.log('  leafCount:          ' + att.header.leafCount);
console.log('  merkleRoot:         ' + att.header.merkleRoot);
console.log('');
if (!r.ok) {
  for (const reason of r.reasons) console.error('  · ' + reason);
  process.exit(1);
}
"
green "  cryptographic audit: PASS"

cyan "== step 3: inspect each .ots proof with the standard OpenTimestamps tool"
if command -v ots >/dev/null 2>&1; then
  OTS_BIN=ots
elif [ -x /tmp/ots-venv/bin/ots ]; then
  OTS_BIN=/tmp/ots-venv/bin/ots
else
  yellow "  the 'ots' CLI is not installed. Skipping standalone introspection."
  yellow "  install with one of:"
  dim    "    pipx install opentimestamps-client"
  dim    "    python3 -m venv /tmp/ots-venv && /tmp/ots-venv/bin/pip install opentimestamps-client"
  exit 0
fi
for f in proofs/sample-session.alice.ots proofs/sample-session.bob.ots proofs/sample-session.finney.ots; do
  echo
  cyan "  $f"
  "$OTS_BIN" info "$f" 2>&1 | sed 's/^/    /'
done

echo
green "== summary =="
echo "  Claw-side cryptography:    verified independently by openai-claw-verify"
echo "  OpenTimestamps proof:      well-formed, pending Bitcoin confirmation"
echo "  Run 'ots upgrade proofs/*.ots' then 'ots verify proofs/*.ots' in ~3 hours"
echo "  to chase the chain anchor."
