import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { ClawConfig } from "../config.js";

const EMBED_MODEL = "text-embedding-3-small";
const CHUNK_CHARS = 4000;
const CHUNK_OVERLAP = 400;
const MAX_FILE_BYTES = 256 * 1024;
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".cache"]);
const EXT_ALLOW = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs",
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml",
  ".sh", ".bash", ".zsh", ".fish",
  ".html", ".css", ".scss", ".sass",
  ".sql", ".graphql", ".proto",
]);

export interface RagChunk {
  file: string;       // path relative to workdir
  chunkIndex: number; // 0-based within the file
  text: string;
  embedding: number[];
}

export interface RagIndex {
  workdir: string;
  model: string;
  builtAt: string;
  chunks: RagChunk[];
}

function indexFile(config: ClawConfig): string {
  return path.join(config.projectDir, "index.json");
}

export function loadIndex(config: ClawConfig): RagIndex | null {
  const f = indexFile(config);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as RagIndex;
  } catch {
    return null;
  }
}

function saveIndex(config: ClawConfig, idx: RagIndex): void {
  fs.writeFileSync(indexFile(config), JSON.stringify(idx));
}

function* walkFiles(dir: string, root: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      yield* walkFiles(full, root);
      continue;
    }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!EXT_ALLOW.has(ext)) continue;
    yield full;
  }
}

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const out: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(text.length, pos + CHUNK_CHARS);
    out.push(text.slice(pos, end));
    if (end >= text.length) break;
    pos = end - CHUNK_OVERLAP;
  }
  return out;
}

/**
 * Build (or rebuild) the project's semantic index. Calls OpenAI in batches.
 * Returns the new index plus a small summary.
 */
export async function buildIndex(
  config: ClawConfig,
  onProgress?: (msg: string) => void
): Promise<{ index: RagIndex; filesIndexed: number; chunks: number }> {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });

  const files: string[] = [];
  for (const f of walkFiles(config.workdir, config.workdir)) {
    try {
      const stat = fs.statSync(f);
      if (stat.size > MAX_FILE_BYTES) continue;
      files.push(f);
    } catch {}
  }

  onProgress?.(`scanning ${files.length} file(s)…`);

  type Pending = { file: string; chunkIndex: number; text: string };
  const pending: Pending[] = [];
  for (const f of files) {
    try {
      const text = fs.readFileSync(f, "utf8");
      if (!text.trim()) continue;
      const rel = path.relative(config.workdir, f);
      const parts = chunkText(text);
      parts.forEach((p, i) => pending.push({ file: rel, chunkIndex: i, text: p }));
    } catch {}
  }

  onProgress?.(`embedding ${pending.length} chunk(s)…`);

  const BATCH = 64;
  const chunks: RagChunk[] = [];
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    const res = await client.embeddings.create({
      model: EMBED_MODEL,
      input: slice.map((p) => p.text),
    });
    if (res.data.length !== slice.length) {
      throw new Error(
        `embedding count mismatch: got ${res.data.length}, expected ${slice.length}`
      );
    }
    for (let j = 0; j < slice.length; j++) {
      chunks.push({
        file: slice[j].file,
        chunkIndex: slice[j].chunkIndex,
        text: slice[j].text,
        embedding: res.data[j].embedding,
      });
    }
    onProgress?.(`embedded ${Math.min(i + BATCH, pending.length)}/${pending.length}`);
  }

  const idx: RagIndex = {
    workdir: config.workdir,
    model: EMBED_MODEL,
    builtAt: new Date().toISOString(),
    chunks,
  };
  saveIndex(config, idx);
  return { index: idx, filesIndexed: files.length, chunks: chunks.length };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    aMag = 0,
    bMag = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag) + 1e-10);
}

export interface SearchHit {
  file: string;
  chunkIndex: number;
  score: number;
  text: string;
}

export async function semanticSearch(
  config: ClawConfig,
  query: string,
  k: number
): Promise<SearchHit[]> {
  const idx = loadIndex(config);
  if (!idx || idx.chunks.length === 0) {
    throw new Error("No semantic index. Run /index to build one.");
  }
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const res = await client.embeddings.create({ model: idx.model, input: [query] });
  const qvec = res.data[0].embedding;
  const scored = idx.chunks.map((c) => ({
    file: c.file,
    chunkIndex: c.chunkIndex,
    score: cosine(qvec, c.embedding),
    text: c.text,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
