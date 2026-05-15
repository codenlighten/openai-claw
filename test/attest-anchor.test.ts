import { describe, it, expect } from "vitest";
import { anchorOpenTimestamps, DEFAULT_OTS_CALENDARS } from "../src/attest/index.js";

function mockFetch(map: Record<string, { status: number; body?: Uint8Array; throws?: any }>): typeof fetch {
  return (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    const m = map[url];
    if (!m) throw new Error(`mockFetch: unexpected url ${url}`);
    if (m.throws) throw m.throws;
    return {
      ok: m.status >= 200 && m.status < 300,
      status: m.status,
      async arrayBuffer() {
        return m.body ? m.body.buffer.slice(m.body.byteOffset, m.body.byteOffset + m.body.byteLength) : new ArrayBuffer(0);
      },
    } as Response;
  }) as any;
}

describe("anchorOpenTimestamps", () => {
  const digest = "a".repeat(64);

  it("rejects malformed digests", async () => {
    await expect(anchorOpenTimestamps("not-hex")).rejects.toThrow(/64-char hex/);
    await expect(anchorOpenTimestamps("ab".repeat(31))).rejects.toThrow(/64-char hex/);
  });

  it("submits to every calendar and captures successful responses", async () => {
    const fakeResponse = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const calendars = ["https://cal1.test", "https://cal2.test"];
    const fetch = mockFetch({
      "https://cal1.test/digest": { status: 200, body: fakeResponse },
      "https://cal2.test/digest": { status: 200, body: fakeResponse },
    });
    const proof = await anchorOpenTimestamps(digest, { calendars, fetch });
    expect(proof.digest).toBe(digest);
    expect(proof.type).toBe("opentimestamps-pending");
    expect(proof.calendars).toHaveLength(2);
    for (const c of proof.calendars) {
      expect(c.ok).toBe(true);
      expect(Buffer.from(c.response!, "base64").length).toBe(4);
    }
  });

  it("records partial failure without throwing", async () => {
    const calendars = ["https://cal1.test", "https://cal2.test"];
    const fetch = mockFetch({
      "https://cal1.test/digest": { status: 200, body: new Uint8Array([0xab]) },
      "https://cal2.test/digest": { status: 503 },
    });
    const proof = await anchorOpenTimestamps(digest, { calendars, fetch });
    expect(proof.calendars[0].ok).toBe(true);
    expect(proof.calendars[1].ok).toBe(false);
    expect(proof.calendars[1].error).toMatch(/503/);
  });

  it("records network errors without throwing", async () => {
    const calendars = ["https://cal1.test"];
    const fetch = mockFetch({
      "https://cal1.test/digest": { status: 0, throws: new Error("ECONNREFUSED") },
    });
    const proof = await anchorOpenTimestamps(digest, { calendars, fetch });
    expect(proof.calendars[0].ok).toBe(false);
    expect(proof.calendars[0].error).toMatch(/ECONNREFUSED/);
  });

  it("default calendar list is non-empty and points at OTS infrastructure", () => {
    expect(DEFAULT_OTS_CALENDARS.length).toBeGreaterThanOrEqual(2);
    for (const url of DEFAULT_OTS_CALENDARS) {
      expect(url).toMatch(/^https:\/\//);
    }
  });
});
