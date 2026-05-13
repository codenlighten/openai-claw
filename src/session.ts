import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./client.js";
import type { ClawConfig } from "./config.js";

export interface SessionFile {
  workdir: string;
  model: string;
  savedAt: string;
  messages: ChatMessage[];
}

function sessionsDir(config: ClawConfig): string {
  const dir = path.join(config.projectDir, "sessions");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveSession(config: ClawConfig, messages: ChatMessage[]): string {
  const dir = sessionsDir(config);
  const file = path.join(dir, "last.json");
  const data: SessionFile = {
    workdir: config.workdir,
    model: config.model,
    savedAt: new Date().toISOString(),
    messages,
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export function loadSession(config: ClawConfig): SessionFile | null {
  const file = path.join(sessionsDir(config), "last.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SessionFile;
  } catch {
    return null;
  }
}

export function listSessions(config: ClawConfig): string[] {
  const dir = sessionsDir(config);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f));
}
