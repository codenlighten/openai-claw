import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { MlDsa65Suite } from "@smartledger/crypto";
import type { ClawConfig } from "../config.js";

export const ATTEST_SUITE_ID = "ml-dsa-65";

export interface AttestorIdentity {
  suiteId: string;
  createdAt: string;
  /** Base64-encoded public key bytes. */
  publicKey: string;
  /** Base64-encoded private key bytes. NEVER returned by any public API — only `identityFile()`. */
  privateKey: string;
  /** Short stable fingerprint of the public key, used in attestation headers + filenames. */
  publicKeyId: string;
}

function keysDir(config: ClawConfig): string {
  const dir = path.join(config.homeDir, "keys");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function identityFile(config: ClawConfig): string {
  return path.join(keysDir(config), "attestor.json");
}

export function identityExists(config: ClawConfig): boolean {
  return fs.existsSync(identityFile(config));
}

/**
 * Generate a fresh ML-DSA-65 keypair and persist it to ~/.openai-claw/keys/attestor.json
 * (mode 0600). The file is the identity — back it up off-machine. We do NOT
 * support passphrase-encryption in the MVP; the only protection is filesystem
 * permissions, which is the same posture as ~/.ssh/id_ed25519. A later phase
 * can layer mnemonic recovery + at-rest encryption.
 */
export async function createIdentity(config: ClawConfig): Promise<AttestorIdentity> {
  if (identityExists(config)) {
    throw new Error(
      `Attestor identity already exists at ${identityFile(config)}. Run 'claw attest rotate' to replace it.`
    );
  }
  const suite = new MlDsa65Suite();
  const kp = await suite.generateKeypair();
  const id: AttestorIdentity = {
    suiteId: ATTEST_SUITE_ID,
    createdAt: new Date().toISOString(),
    publicKey: Buffer.from(kp.publicKey).toString("base64"),
    privateKey: Buffer.from(kp.privateKey).toString("base64"),
    publicKeyId: fingerprint(kp.publicKey),
  };
  fs.writeFileSync(identityFile(config), JSON.stringify(id, null, 2), { mode: 0o600 });
  return id;
}

export function loadIdentity(config: ClawConfig): AttestorIdentity | null {
  if (!identityExists(config)) return null;
  return JSON.parse(fs.readFileSync(identityFile(config), "utf8")) as AttestorIdentity;
}

/**
 * Public-key-only view safe to embed in attestation sidecars and share.
 */
export function publicView(id: AttestorIdentity): {
  suiteId: string;
  publicKey: string;
  publicKeyId: string;
  createdAt: string;
} {
  return {
    suiteId: id.suiteId,
    publicKey: id.publicKey,
    publicKeyId: id.publicKeyId,
    createdAt: id.createdAt,
  };
}

function fingerprint(pub: Uint8Array): string {
  // SHA-256 over the public key, base64url-truncated. 16 chars ≈ 96 bits —
  // enough to be globally unique for identification, short enough to be
  // shown in CLI status.
  const h = createHash("sha256").update(Buffer.from(pub)).digest();
  return h
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
    .slice(0, 16);
}
