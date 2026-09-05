import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildOtsFile,
  exportOtsFiles,
  type AnchorProof,
} from "../src/attest/index.js";

const DIGEST = "ab".repeat(32);

// Public OTS spec header.
const HEADER_HEX =
  "004f70656e54696d657374616d70730000" + // "\x00OpenTimestamps\x00\x00"
  "50726f6f6600" + // "Proof\x00"
  "bf89e2e884e89294"; // magic 8 bytes

describe("buildOtsFile", () => {
  it("emits header + version + op_sha256 + digest + response bytes", () => {
    const response = Buffer.from([0xaa, 0xbb, 0xcc]);
    const out = buildOtsFile(DIGEST, response.toString("base64"))!;
    expect(out).toBeTruthy();
    const hex = out.toString("hex");
    // Header at the start.
    expect(hex.startsWith(HEADER_HEX)).toBe(true);
    // Version byte 0x01.
    const afterHeader = hex.slice(HEADER_HEX.length);
    expect(afterHeader.slice(0, 2)).toBe("01");
    // op_sha256 marker 0x08.
    expect(afterHeader.slice(2, 4)).toBe("08");
    // 32 raw digest bytes.
    expect(afterHeader.slice(4, 4 + 64)).toBe(DIGEST);
    // Response bytes appended verbatim.
    expect(afterHeader.slice(4 + 64)).toBe(response.toString("hex"));
  });

  it("rejects malformed digests", () => {
    expect(() => buildOtsFile("not-hex", "AA==")).toThrow(/64-char hex/);
  });

  it("returns null for an empty response", () => {
    expect(buildOtsFile(DIGEST, "")).toBeNull();
  });
});

describe("exportOtsFiles", () => {
  const anchor: AnchorProof = {
    type: "opentimestamps-pending",
    digest: DIGEST,
    submittedAt: "2026-01-01T00:00:00Z",
    calendars: [
      {
        url: "https://alice.btc.calendar.opentimestamps.org",
        ok: true,
        response: Buffer.from([0x01, 0x02]).toString("base64"),
      },
      {
        url: "https://bob.btc.calendar.opentimestamps.org",
        ok: false,
        error: "HTTP 503",
      },
      {
        url: "https://finney.calendar.eternitywall.com",
        ok: true,
        response: Buffer.from([0x03]).toString("base64"),
      },
    ],
  };

  it("emits one file per accepted calendar; skips failures", () => {
    const out = exportOtsFiles(anchor);
    expect(out.map((e) => e.shortName).sort()).toEqual(["alice", "finney"]);
    expect(out.find((e) => e.shortName === "alice")?.bytes.length).toBeGreaterThan(40);
  });

  it("returns an empty list when all calendars failed", () => {
    const failed: AnchorProof = {
      ...anchor,
      calendars: anchor.calendars.map((c) => ({ ...c, ok: false, response: undefined })),
    };
    expect(exportOtsFiles(failed)).toEqual([]);
  });

  it("each file starts with the standard OTS header magic", () => {
    const out = exportOtsFiles(anchor);
    for (const e of out) {
      expect(e.bytes.toString("hex").startsWith(HEADER_HEX)).toBe(true);
    }
  });
});

describe("digest binding", () => {
  // The whole audit chain hangs on this: the digest embedded in every .ots
  // file must be the one that was signed, or the timestamp proves nothing
  // about this attestation. `ots verify -d <digest>` is how an auditor checks
  // it, so the bytes at that offset are load-bearing.
  const DIGEST_OFFSET = 31 + 1 + 1; // magic + version + file-hash op

  it("embeds the anchored digest at the spec offset in every exported file", () => {
    const digest = "9016c1a763c824acde2337915d1341a8cd68feb0c4f3965dd068c816e2b25edd";
    const anchor = {
      type: "opentimestamps-pending" as const,
      digest,
      submittedAt: "2026-01-01T00:00:00Z",
      calendars: [
        { url: "https://alice.btc.calendar.opentimestamps.org", ok: true, response: Buffer.from("aaaa").toString("base64") },
        { url: "https://bob.btc.calendar.opentimestamps.org", ok: true, response: Buffer.from("bbbb").toString("base64") },
      ],
    };
    const exports = exportOtsFiles(anchor);
    expect(exports).toHaveLength(2);
    for (const e of exports) {
      const embedded = e.bytes.subarray(DIGEST_OFFSET, DIGEST_OFFSET + 32).toString("hex");
      expect(embedded).toBe(digest);
    }
  });

  it("the committed demo proofs carry the digest their sidecar anchored", () => {
    const attestation = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "examples/audit-demo/sample-session.attest.json"), "utf8")
    );
    const proofsDir = path.join(process.cwd(), "examples/audit-demo/proofs");
    const files = fs.readdirSync(proofsDir).filter((f) => f.endsWith(".ots"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const bytes = fs.readFileSync(path.join(proofsDir, f));
      const embedded = bytes.subarray(DIGEST_OFFSET, DIGEST_OFFSET + 32).toString("hex");
      expect(embedded, `${f} digest`).toBe(attestation.anchor.digest);
    }
  });

  it("the anchored digest is sha256 of the signed header's canonical JSON", async () => {
    const { canonicalJSON, sha256Hex } = await import("@smartledger.technology/openai-claw-verify");
    const attestation = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "examples/audit-demo/sample-session.attest.json"), "utf8")
    );
    expect(attestation.anchor.digest).toBe(sha256Hex(canonicalJSON(attestation.header)));
  });
});
