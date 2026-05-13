import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./client.js";
import type { ClawConfig } from "./config.js";

export interface SessionFile {
  id: string;
  workdir: string;
  model: string;
  savedAt: string;
  /** First user message (truncated) used for the session list UI. */
  preview?: string;
  messages: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  savedAt: string;
  preview: string;
  messageCount: number;
}

function sessionsDir(config: ClawConfig): string {
  const dir = path.join(config.projectDir, "sessions");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function newSessionId(): string {
  // ISO-ish timestamp safe for filenames + 4 random hex chars to disambiguate.
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const rnd = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${now}-${rnd}`;
}

function deriveFirstUserPreview(messages: ChatMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content.slice(0, 80);
    if (Array.isArray(m.content)) {
      const text = m.content.find((p) => p.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      if (text) return text.text.slice(0, 80);
    }
  }
  return "(no user message)";
}

/**
 * Save the conversation as `${sessionId}.json` in the project's sessions dir.
 * If no sessionId is given, a new one is minted and returned. Pass the same id
 * back on subsequent saves within one run to keep updating the same file.
 */
export function saveSession(
  config: ClawConfig,
  messages: ChatMessage[],
  sessionId?: string
): { id: string; file: string } {
  const dir = sessionsDir(config);
  const id = sessionId ?? newSessionId();
  const file = path.join(dir, `${id}.json`);
  const data: SessionFile = {
    id,
    workdir: config.workdir,
    model: config.model,
    savedAt: new Date().toISOString(),
    preview: deriveFirstUserPreview(messages),
    messages,
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { id, file };
}

/**
 * Load a session. With no id, returns the most recently saved one (legacy
 * single-resume behavior, used by `--continue`).
 */
export function loadSession(config: ClawConfig, sessionId?: string): SessionFile | null {
  const dir = sessionsDir(config);
  if (sessionId) {
    const file = path.join(dir, `${sessionId}.json`);
    if (!fs.existsSync(file)) {
      // Also accept legacy "last.json" by exact name.
      const legacy = path.join(dir, sessionId);
      if (fs.existsSync(legacy)) return readSessionFile(legacy);
      return null;
    }
    return readSessionFile(file);
  }
  const summaries = listSessions(config);
  if (summaries.length === 0) {
    // Legacy fallback: a single last.json from before A.3.
    const legacy = path.join(dir, "last.json");
    if (fs.existsSync(legacy)) return readSessionFile(legacy);
    return null;
  }
  return readSessionFile(path.join(dir, `${summaries[0].id}.json`));
}

export function listSessions(config: ClawConfig): SessionSummary[] {
  const dir = sessionsDir(config);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "last.json")
    .map((f) => path.join(dir, f));
  const summaries: SessionSummary[] = [];
  for (const file of files) {
    const data = readSessionFile(file);
    if (!data) continue;
    summaries.push({
      id: data.id,
      savedAt: data.savedAt,
      preview: data.preview ?? "",
      messageCount: data.messages.length,
    });
  }
  summaries.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  return summaries;
}

/** Snapshot the conversation as a *new* session id (used by /fork). */
export function forkSession(config: ClawConfig, messages: ChatMessage[]): { id: string; file: string } {
  return saveSession(config, messages);
}

function readSessionFile(file: string): SessionFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    // Backfill `id` for legacy files saved before A.3.
    if (!raw.id) raw.id = path.basename(file, ".json");
    return raw as SessionFile;
  } catch {
    return null;
  }
}
