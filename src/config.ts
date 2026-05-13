import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ClawConfig {
  model: string;
  apiKey: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
  contextWindow: number;
  compactThreshold: number;
  permissionMode: "ask" | "acceptEdits" | "bypassPermissions" | "plan";
  allowedTools: string[];
  deniedTools: string[];
  workdir: string;
  homeDir: string;
  projectDir: string;
  memoryDir: string;
  maxTurns: number;
  maxToolResultChars: number;
}

const DEFAULTS = {
  model: "gpt-5-nano",
  contextWindow: 200_000,
  compactThreshold: 0.85,
  permissionMode: "ask" as const,
  maxTurns: 50,
  maxToolResultChars: 50_000,
};

function resolveProjectDir(workdir: string): string {
  const slug = workdir.replace(/[\/\\:]/g, "-").replace(/^-+/, "");
  return path.join(os.homedir(), ".openai-claw", "projects", slug);
}

export function loadConfig(overrides: Partial<ClawConfig> = {}): ClawConfig {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Export it in your shell or add it to your .env file."
    );
  }

  const workdir = overrides.workdir ?? process.cwd();
  const homeDir = path.join(os.homedir(), ".openai-claw");
  const projectDir = resolveProjectDir(workdir);
  const memoryDir = path.join(projectDir, "memory");

  for (const dir of [homeDir, projectDir, memoryDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // Merge with project-level + user-level settings.json if present.
  const userSettings = readJsonSafe(path.join(homeDir, "settings.json"));
  const projectSettings = readJsonSafe(path.join(workdir, ".claw", "settings.json"));

  const merged: ClawConfig = {
    model: process.env.OPENAI_CLAW_MODEL ?? userSettings.model ?? projectSettings.model ?? DEFAULTS.model,
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL ?? userSettings.baseURL ?? projectSettings.baseURL,
    maxTokens: projectSettings.maxTokens ?? userSettings.maxTokens,
    temperature: projectSettings.temperature ?? userSettings.temperature,
    contextWindow: projectSettings.contextWindow ?? userSettings.contextWindow ?? DEFAULTS.contextWindow,
    compactThreshold: projectSettings.compactThreshold ?? userSettings.compactThreshold ?? DEFAULTS.compactThreshold,
    permissionMode: projectSettings.permissionMode ?? userSettings.permissionMode ?? DEFAULTS.permissionMode,
    allowedTools: [...(userSettings.allowedTools ?? []), ...(projectSettings.allowedTools ?? [])],
    deniedTools: [...(userSettings.deniedTools ?? []), ...(projectSettings.deniedTools ?? [])],
    maxTurns: projectSettings.maxTurns ?? userSettings.maxTurns ?? DEFAULTS.maxTurns,
    maxToolResultChars: projectSettings.maxToolResultChars ?? userSettings.maxToolResultChars ?? DEFAULTS.maxToolResultChars,
    workdir,
    homeDir,
    projectDir,
    memoryDir,
    ...overrides,
  };
  return merged;
}

function readJsonSafe(p: string): any {
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function saveUserSetting<K extends keyof ClawConfig>(
  config: ClawConfig,
  key: K,
  value: ClawConfig[K]
): void {
  const p = path.join(config.homeDir, "settings.json");
  const current = readJsonSafe(p);
  current[key] = value;
  fs.writeFileSync(p, JSON.stringify(current, null, 2));
}
