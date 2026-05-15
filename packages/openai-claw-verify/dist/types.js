/**
 * Wire types for an openai-claw attestation sidecar. These are the only
 * inputs the verifier needs — the verifier has no dependency on claw's
 * source, on OpenAI, or on the model that produced the session.
 *
 * Bumping the format involves bumping `AttestationHeader.v` and
 * `AttestationHeader.format`; older verifiers will then refuse the new
 * sidecar with a clear "unsupported format" reason.
 */
export {};
//# sourceMappingURL=types.js.map