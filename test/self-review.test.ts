import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "User keeps correcting Bash usage.",
                  proposals: [
                    {
                      type: "feedback",
                      name: "avoid-rm-rf",
                      description: "User dislikes destructive bash",
                      body: "Don't propose `rm -rf` without explicit confirmation.\n**Why:** repeated correction in 3 sessions.",
                    },
                  ],
                }),
                tool_calls: [],
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      },
    };
    embeddings = { create: async () => ({ data: [] }) };
  },
}));

import { runSelfReview } from "../src/self-review/index.js";
import { saveSession } from "../src/session.js";
import type { ClawConfig } from "../src/config.js";
import type { ChatMessage } from "../src/client.js";

let tmp: string;
const cfg = (): ClawConfig => ({
  workdir: tmp,
  homeDir: tmp,
  projectDir: tmp,
  memoryDir: tmp,
  model: "test",
  apiKey: "x",
  allowedTools: [],
  deniedTools: [],
  contextWindow: 0,
  compactThreshold: 1,
  permissionMode: "ask",
  maxTurns: 50,
  maxToolResultChars: 50_000,
  models: {},
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-selfreview-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("self-review", () => {
  it("returns empty proposals when there are no signals", async () => {
    saveSession(cfg(), [
      { role: "user", content: "please add a logger" },
      { role: "assistant", content: "ok done" },
    ] as ChatMessage[]);
    const r = await runSelfReview(cfg());
    expect(r.proposals).toEqual([]);
  });

  it("surfaces proposals when correction phrases are present", async () => {
    saveSession(cfg(), [
      { role: "user", content: "no, don't use rm -rf here" } as ChatMessage,
      { role: "assistant", content: "got it" } as ChatMessage,
    ]);
    const r = await runSelfReview(cfg());
    expect(r.signals.correctionPhrases).toBeGreaterThan(0);
    expect(r.proposals.length).toBeGreaterThan(0);
    expect(r.proposals[0].name).toBe("avoid-rm-rf");
  });
});
