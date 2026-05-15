/**
 * Anchor strategies turn a session's Merkle root into a public, verifiable
 * timestamp by submitting the digest to one or more external services.
 *
 * The MVP strategy is `opentimestamps`: it POSTs the Merkle root to several
 * public OpenTimestamps calendars, stores their responses as base64 blobs,
 * and tags the sidecar so a future `claw attest export-ots <id>` can wrap
 * those bytes into a standards-compliant `.ots` file.
 *
 * Calendar responses are pending proofs — they become Bitcoin-anchored
 * automatically (no second call required) once the calendar's batched root
 * lands in a Bitcoin block (~1-3 hours). Standard tooling (`ots verify`)
 * is what finishes the chain check; claw stays out of consensus.
 */

export interface AnchorCalendarResponse {
  url: string;
  ok: boolean;
  /** base64-encoded raw response bytes from the calendar. Present when ok=true. */
  response?: string;
  /** Status code (HTTP) or short error message. Present when ok=false. */
  error?: string;
}

export interface AnchorProof {
  type: "opentimestamps-pending";
  /** hex sha256 — the digest that was actually submitted to the calendar(s). */
  digest: string;
  submittedAt: string;
  calendars: AnchorCalendarResponse[];
}

/** Public OTS calendars maintained by independent parties. */
export const DEFAULT_OTS_CALENDARS = [
  "https://alice.btc.calendar.opentimestamps.org",
  "https://bob.btc.calendar.opentimestamps.org",
  "https://finney.calendar.eternitywall.com",
];

export interface AnchorOptions {
  /** Override the calendar list (mostly for tests). */
  calendars?: string[];
  /** Custom fetch implementation (default: global fetch). Mostly for tests. */
  fetch?: typeof fetch;
  /** Per-call timeout in ms. Default 30s. */
  timeoutMs?: number;
}

/**
 * Submit a 32-byte sha256 digest to every calendar in parallel. Returns a
 * proof that records which calendars accepted the submission and what
 * they replied with. Never throws: a network-down environment still
 * produces a valid (if empty) AnchorProof so the caller can persist a
 * record of the attempt.
 */
export async function anchorOpenTimestamps(
  digestHex: string,
  opts: AnchorOptions = {}
): Promise<AnchorProof> {
  if (!/^[0-9a-fA-F]{64}$/.test(digestHex)) {
    throw new Error(`anchorOpenTimestamps: expected 64-char hex digest, got length ${digestHex.length}`);
  }
  const calendars = opts.calendars ?? DEFAULT_OTS_CALENDARS;
  const f: typeof fetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const digestBytes = hexToBytes(digestHex);

  const submitted = await Promise.all(
    calendars.map((url) => submitOne(url, digestBytes, f, timeoutMs))
  );

  return {
    type: "opentimestamps-pending",
    digest: digestHex,
    submittedAt: new Date().toISOString(),
    calendars: submitted,
  };
}

async function submitOne(
  url: string,
  digest: Uint8Array,
  f: typeof fetch,
  timeoutMs: number
): Promise<AnchorCalendarResponse> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await f(`${url.replace(/\/$/, "")}/digest`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: digest,
      signal: controller.signal,
    });
    if (!res.ok) {
      return { url, ok: false, error: `HTTP ${res.status}` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { url, ok: true, response: bytesToBase64(bytes) };
  } catch (e: any) {
    return { url, ok: false, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(t);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}
