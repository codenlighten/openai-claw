/**
 * Construct a standards-compliant OpenTimestamps `.ots` file from a single
 * calendar's pending response.
 *
 * The OTS file is a simple binary format:
 *
 *   [HEADER_MAGIC (31 bytes)]   constant per spec
 *   [VERSION (1 byte = 0x01)]
 *   [op_sha256 (1 byte = 0x08)] file-hash-op marker
 *   [digest (32 bytes)]         the message being timestamped, raw bytes
 *   [ops + attestation]         what the calendar returned, byte-for-byte
 *
 * One .ots file per calendar response is the simplest correct path: each
 * file is independently verifiable with `ots verify`. Merging into one
 * multi-branch tree would require parsing the calendar response, which we
 * deliberately avoid here — claw stays out of OTS-format internals.
 *
 * If the calendar response is empty, returns null (nothing to write).
 */
// `\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94`
const HEADER_MAGIC = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from("OpenTimestamps", "ascii"),
    Buffer.from([0x00, 0x00]),
    Buffer.from("Proof", "ascii"),
    Buffer.from([0x00]),
    Buffer.from([0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]),
]);
const OTS_VERSION = 0x01;
const OP_SHA256 = 0x08;
const DIGEST_BYTES = 32;
export function buildOtsFile(digestHex, calendarResponseBase64) {
    if (!/^[0-9a-fA-F]{64}$/.test(digestHex)) {
        throw new Error(`buildOtsFile: expected 64-char hex digest, got length ${digestHex.length}`);
    }
    const response = Buffer.from(calendarResponseBase64, "base64");
    if (response.length === 0)
        return null;
    const digest = Buffer.from(digestHex, "hex");
    return Buffer.concat([
        HEADER_MAGIC,
        Buffer.from([OTS_VERSION]),
        Buffer.from([OP_SHA256]),
        digest,
        response,
    ]);
}
/**
 * Slice an anchor's response set into one .ots file per accepted calendar.
 * Failed calendars are skipped. Returns the list of (shortName, url, bytes).
 */
export function exportOtsFiles(anchor) {
    const out = [];
    for (const cal of anchor.calendars) {
        if (!cal.ok || !cal.response)
            continue;
        const bytes = buildOtsFile(anchor.digest, cal.response);
        if (!bytes)
            continue;
        out.push({
            shortName: shortNameFor(cal.url),
            url: cal.url,
            bytes,
        });
    }
    return out;
}
function shortNameFor(url) {
    // Pull a sensible short token from the calendar host. Examples:
    //   https://alice.btc.calendar.opentimestamps.org → "alice"
    //   https://finney.calendar.eternitywall.com      → "finney"
    //   anything else                                  → first label after https://
    try {
        const host = new URL(url).host;
        const first = host.split(".")[0];
        return first || host;
    }
    catch {
        return url.replace(/[^a-z0-9]+/gi, "-").slice(0, 24);
    }
}
/** Re-export for tests / external tooling. */
export const _internal = { HEADER_MAGIC, OTS_VERSION, OP_SHA256, DIGEST_BYTES };
//# sourceMappingURL=ots-file.js.map