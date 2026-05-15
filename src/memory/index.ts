import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { ClawConfig } from "../config.js";

export interface MemoryEntry {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  body: string;
  file: string;
}

// Memory names become filenames inside memoryDir, so reject anything that
// could escape the directory (path separators, parent refs, leading dot).
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function safeMemoryName(name: string): string {
  if (!SAFE_NAME.test(name) || name.includes("..")) {
    throw new Error(`invalid memory name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function listMemories(config: ClawConfig): MemoryEntry[] {
  const dir = config.memoryDir;
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
  const entries: MemoryEntry[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const parsed = matter(fs.readFileSync(full, "utf8"));
      const fm = parsed.data ?? {};
      entries.push({
        name: fm.name ?? f.replace(/\.md$/, ""),
        description: fm.description ?? "",
        type: (fm.metadata?.type ?? fm.type ?? "project") as MemoryEntry["type"],
        body: parsed.content.trim(),
        file: full,
      });
    } catch {
      // skip malformed
    }
  }
  return entries;
}

export function writeMemory(
  config: ClawConfig,
  entry: { name: string; description: string; type: MemoryEntry["type"]; body: string }
): string {
  safeMemoryName(entry.name);
  const file = path.join(config.memoryDir, `${entry.name}.md`);
  const frontmatter = matter.stringify(entry.body, {
    name: entry.name,
    description: entry.description,
    metadata: { type: entry.type },
  });
  fs.writeFileSync(file, frontmatter);
  updateIndex(config);
  return file;
}

export function deleteMemory(config: ClawConfig, name: string): boolean {
  safeMemoryName(name);
  const file = path.join(config.memoryDir, `${name}.md`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  updateIndex(config);
  return true;
}

function updateIndex(config: ClawConfig): void {
  const entries = listMemories(config);
  const lines = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `- [${e.name}](${path.basename(e.file)}) — ${e.description}`);
  const idx = path.join(config.memoryDir, "MEMORY.md");
  fs.writeFileSync(idx, lines.join("\n") + "\n");
}
