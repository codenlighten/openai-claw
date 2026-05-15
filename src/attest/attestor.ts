import { MlDsa65Suite } from "@smartledger/crypto";
import {
  canonicalJSON,
  hashLeaf,
  hashPayload,
  merkleRoot,
  type Leaf,
  type LeafKind,
  type Attestation,
  type AttestationHeader,
} from "@smartledger.technology/openai-claw-verify";
import type { AgentEvent } from "../agent.js";
import { type AttestorIdentity, publicView, ATTEST_SUITE_ID } from "./identity.js";

export const ATTESTATION_FORMAT = "openai-claw.attestation.v1" as const;
export type { Attestation, AttestationHeader, Leaf, LeafKind };

/**
 * Collects leaf events for one session and finalizes them into a signed
 * attestation. Designed to be fed both the user's input messages (call
 * `record()` manually) and the AgentEventHandler stream (call `onAgentEvent()`).
 *
 * Not all agent events become leaves — only the ones a verifier cares about
 * (user/assistant text boundaries, tool calls, tool results, permission
 * decisions, compaction events, errors). Streaming `text_delta` is ignored;
 * the final `text` event captures the assistant's reply.
 *
 * Primitives (canonical JSON, leaf hashing, Merkle root) are imported from
 * `@smartledger.technology/openai-claw-verify` so claw and any third-party
 * auditor compute byte-identical hashes from the same data.
 */
export class Attestor {
  private leaves: Leaf[] = [];
  private seq = 0;
  private startedAt = new Date().toISOString();
  private toolInputs = new Map<string, unknown>();

  constructor(private id: AttestorIdentity) {}

  record(kind: LeafKind, payload: unknown): void {
    const leaf: Leaf = {
      v: 1,
      seq: this.seq++,
      ts: new Date().toISOString(),
      kind,
      payloadHash: hashPayload(payload),
    };
    this.leaves.push(leaf);
  }

  onAgentEvent(evt: AgentEvent): boolean {
    switch (evt.type) {
      case "tool_call": {
        const d = evt.data as { name: string; input: unknown; callId?: string };
        if (d.callId) this.toolInputs.set(d.callId, d.input);
        this.record("tool_call", { name: d.name, input: d.input, callId: d.callId });
        return true;
      }
      case "tool_result": {
        const d = evt.data as { name: string; content: string; isError?: boolean; callId?: string };
        const input = d.callId ? this.toolInputs.get(d.callId) : undefined;
        this.record("tool_result", {
          name: d.name,
          input,
          content: d.content,
          isError: !!d.isError,
          callId: d.callId,
        });
        return true;
      }
      case "text":
        this.record("assistant_text", { content: evt.data as string });
        return true;
      case "compaction":
        this.record("compaction", evt.data);
        return true;
      case "error":
        this.record("error", { message: String(evt.data) });
        return true;
      default:
        return false;
    }
  }

  async finalize(sessionId: string): Promise<Attestation> {
    const leafHashes = this.leaves.map(hashLeaf);
    const root = merkleRoot(leafHashes);
    const header: AttestationHeader = {
      v: 1,
      format: ATTESTATION_FORMAT,
      sessionId,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      leafCount: this.leaves.length,
      merkleRoot: root,
      ...publicView(this.id),
    };
    const suite = new MlDsa65Suite();
    const message = Buffer.from(canonicalJSON(header), "utf8");
    const privateKey = Buffer.from(this.id.privateKey, "base64");
    const sig = await suite.sign(privateKey, message);
    return {
      header,
      leaves: this.leaves.slice(),
      signature: Buffer.from(sig).toString("base64"),
    };
  }

  get leafCount(): number {
    return this.leaves.length;
  }
}

export function expectedSuiteId(): string {
  return ATTEST_SUITE_ID;
}
