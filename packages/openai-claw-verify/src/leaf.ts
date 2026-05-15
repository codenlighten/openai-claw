import { createHash } from "node:crypto";
import type { Leaf } from "./types.js";

/**
 * Canonical JSON per RFC 8785 (JCS): keys sorted lexicographically, no
 * insignificant whitespace, undefined values stripped. We only ever attest
 * plain JSON objects/arrays/strings/finite-numbers/booleans/nulls — no Dates,
 * no BigInts, no functions — so the implementation can stay small and
 * dep-free.
 *
 * Determinism is load-bearing: a different verifier on a different machine
 * MUST produce byte-identical canonical JSON, otherwise leaf hashes drift
 * and the signature fails to verify. Don't optimize without round-trip tests.
 */
export function canonicalJSON(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`canonicalJSON: non-finite number ${v}`);
    return JSON.stringify(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(serialize).join(",") + "]";
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + serialize(obj[k])).join(",") +
      "}"
    );
  }
  throw new Error(`canonicalJSON: unsupported type ${typeof v}`);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  const h = createHash("sha256");
  h.update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes));
  return h.digest("hex");
}

export function hashPayload(payload: unknown): string {
  return sha256Hex(canonicalJSON(payload));
}

export function hashLeaf(leaf: Leaf): string {
  return sha256Hex(canonicalJSON(leaf));
}
