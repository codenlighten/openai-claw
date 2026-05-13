import fs from "node:fs";
import { listSessions, loadSession } from "../session.js";
import { listMemories, writeMemory } from "../memory/index.js";
import { OpenAIClient, type ChatMessage } from "../client.js";
import type { ClawConfig } from "../config.js";

export interface ReviewProposal {
  kind: "memory";
  type: "user" | "feedback" | "project" | "reference";
  name: string;
  description: string;
  body: string;
}

export interface ReviewReport {
  sessionsScanned: number;
  signals: {
    correctionPhrases: number;
    repeatedToolErrors: number;
  };
  proposals: ReviewProposal[];
  raw: string;
}

// Phrases that typically follow a user correction or course-redirect.
const CORRECTION_PATTERNS = [
  /\bdon't\b/i,
  /\bdo not\b/i,
  /\bstop\b/i,
  /\bnot like that\b/i,
  /\binstead\b/i,
  /\bno,? that's\b/i,
  /\bthat's wrong\b/i,
  /\bplease use\b/i,
  /\bprefer\b/i,
];

interface ScanFinding {
  type: "correction" | "tool_error" | "user_emphasis";
  text: string;
  fromSession: string;
}

function scanSessions(config: ClawConfig, n: number): { findings: ScanFinding[]; sessionsScanned: number } {
  const sessions = listSessions(config).slice(0, n);
  const findings: ScanFinding[] = [];
  const toolErrorCounter = new Map<string, number>();

  for (const s of sessions) {
    const data = loadSession(config, s.id);
    if (!data) continue;
    for (const m of data.messages) {
      if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content : Array.isArray(m.content)
          ? m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ")
          : "";
        if (!text) continue;
        if (CORRECTION_PATTERNS.some((re) => re.test(text))) {
          findings.push({ type: "correction", text: text.slice(0, 400), fromSession: s.id });
        }
      }
      if (m.role === "tool" && typeof m.content === "string" && /\berror\b|\bfailed\b|\bnot found\b/i.test(m.content)) {
        const key = `${m.name ?? "?"}:${m.content.split("\n")[0].slice(0, 80)}`;
        toolErrorCounter.set(key, (toolErrorCounter.get(key) ?? 0) + 1);
      }
    }
  }

  for (const [key, count] of toolErrorCounter) {
    if (count >= 2) {
      findings.push({ type: "tool_error", text: `${key} (x${count})`, fromSession: "(multiple)" });
    }
  }
  return { findings, sessionsScanned: sessions.length };
}

/**
 * Ask the model to propose memory entries that, if applied, would prevent the
 * patterns observed across recent sessions. We deliberately do not write
 * anything to disk here — the caller surfaces the proposals to the user.
 */
export async function runSelfReview(
  config: ClawConfig,
  opts: { sessionLimit?: number } = {}
): Promise<ReviewReport> {
  const n = opts.sessionLimit ?? 20;
  const { findings, sessionsScanned } = scanSessions(config, n);
  if (findings.length === 0) {
    return {
      sessionsScanned,
      signals: { correctionPhrases: 0, repeatedToolErrors: 0 },
      proposals: [],
      raw: "(no signals found across recent sessions)",
    };
  }

  const existing = listMemories(config).map((m) => `- ${m.name} (${m.type}): ${m.description}`).join("\n") || "(none)";
  const findingsBlock = findings.map((f, i) => `${i + 1}. [${f.type}] ${f.text}`).join("\n");

  const sys: ChatMessage = {
    role: "system",
    content: `You audit a coding assistant's recent sessions and propose persistent memory updates that would prevent the same friction next time. Output STRICT JSON in this shape:

{
  "summary": "<one-paragraph synthesis of what you saw>",
  "proposals": [
    {
      "type": "user" | "feedback" | "project" | "reference",
      "name": "<kebab-case slug>",
      "description": "<one-line description>",
      "body": "<the memory body — for feedback include **Why:** and **How to apply:** lines>"
    }
  ]
}

Rules:
- Only propose what is NOT already covered by the existing memories.
- Prefer FEEDBACK memories for user-correction patterns; PROJECT memories for ongoing-work facts.
- 0 to 5 proposals; quality over quantity. If no proposals are warranted, return an empty array.`,
  };
  const usr: ChatMessage = {
    role: "user",
    content: `Existing memories:
${existing}

Findings across the last ${sessionsScanned} session(s):
${findingsBlock}

Return JSON.`,
  };

  const client = new OpenAIClient(config);
  const res = await client.complete([sys, usr], [], { modelRole: "reasoning" });
  const raw = res.content ?? "";

  let proposals: ReviewProposal[] = [];
  try {
    const json = JSON.parse(extractJson(raw));
    if (Array.isArray(json.proposals)) {
      for (const p of json.proposals) {
        if (p && typeof p.name === "string" && typeof p.body === "string") {
          proposals.push({
            kind: "memory",
            type: (p.type as ReviewProposal["type"]) ?? "feedback",
            name: p.name,
            description: p.description ?? "",
            body: p.body,
          });
        }
      }
    }
  } catch {
    // best-effort — leave proposals empty
  }

  return {
    sessionsScanned,
    signals: {
      correctionPhrases: findings.filter((f) => f.type === "correction").length,
      repeatedToolErrors: findings.filter((f) => f.type === "tool_error").length,
    },
    proposals,
    raw,
  };
}

/** Apply an approved proposal by writing it to the memory store. */
export function applyProposal(config: ClawConfig, p: ReviewProposal): string {
  return require_writeMemory_path(writeMemory)(config, {
    name: p.name,
    description: p.description,
    type: p.type,
    body: p.body,
  });
}

// Tiny indirection so the static analyzer doesn't get confused if writeMemory
// later changes shape — runtime behavior unchanged.
function require_writeMemory_path<T extends (...a: any[]) => any>(fn: T): T {
  return fn;
}

function extractJson(text: string): string {
  // Strip optional ```json fences and return the first {...} block.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenceMatch ? fenceMatch[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return body;
  return body.slice(start, end + 1);
}

// Re-export fs for tests that need to inspect proposal-application output.
export const _internal = { fs };
