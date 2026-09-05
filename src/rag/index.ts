import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import OpenAI from "openai";
import type { ClawConfig } from "../config.js";

const EMBED_MODEL = "text-embedding-3-small";
/** Bump when the on-disk shape changes; older indexes are treated as absent. */
const INDEX_VERSION = 3;
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
  /** sha256 of the whole source file when this chunk was embedded. */
  fileHash: string;
  text: string;
  embedding: number[];
}

export interface RagIndex {
  version: number;
  workdir: string;
  model: string;
  builtAt: string;
  chunks: RagChunk[];
}

function indexFile(config: ClawConfig): string {
  return path.join(config.projectDir, "index.json");
}

/**
 * The parsed index, held across calls. Every Semantic tool call used to re-read
 * and re-parse the whole file — every embedding, as JSON floats — which on a
 * real repo is tens of megabytes per query. Keyed on mtime+size so an index
 * rebuilt by another process is picked up.
 */
let indexCache: { file: string; mtimeMs: number; size: number; index: RagIndex } | null = null;

export function loadIndex(config: ClawConfig): RagIndex | null {
  const f = indexFile(config);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(f);
  } catch {
    return null;
  }
  if (indexCache && indexCache.file === f && indexCache.mtimeMs === stat.mtimeMs && indexCache.size === stat.size) {
    return indexCache.index;
  }
  try {
    const idx = JSON.parse(fs.readFileSync(f, "utf8")) as RagIndex;
    if (idx.version !== INDEX_VERSION) return null;
    indexCache = { file: f, mtimeMs: stat.mtimeMs, size: stat.size, index: idx };
    return idx;
  } catch {
    return null;
  }
}

/** Test-only: drop the in-process index cache. */
export function _resetIndexCache(): void {
  indexCache = null;
}

function saveIndex(config: ClawConfig, idx: RagIndex): void {
  const f = indexFile(config);
  fs.writeFileSync(f, JSON.stringify(idx));
  try {
    const stat = fs.statSync(f);
    indexCache = { file: f, mtimeMs: stat.mtimeMs, size: stat.size, index: idx };
  } catch {
    indexCache = null;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Paths git would ignore. Indexing uploads file contents to the embeddings API,
 * so anything the repo deliberately does not track should not be sent either.
 * Returns an empty set outside a git repo.
 */
function gitIgnoredPaths(workdir: string, files: string[]): Set<string> {
  if (files.length === 0) return new Set();
  // NUL-separated both ways so a newline in a filename can't split one path
  // into two and silently un-ignore it.
  const res = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
    cwd: workdir,
    input: files.join("\0"),
    encoding: "utf8",
  });
  // 0 = at least one ignored, 1 = none ignored, 128 = not a git repo.
  if (res.status !== 0 || !res.stdout) return new Set();
  return new Set(
    res.stdout
      .split("\0")
      .filter(Boolean)
      .map((p) => path.resolve(workdir, p))
  );
}

function* walkFiles(dir: string, root: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // Hidden entries are skipped wholesale: .env and friends have no business
    // being shipped to an embeddings endpoint.
    if (e.name.startsWith(".")) continue;
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

/**
 * Lines that begin a new top-level construct across the languages we index.
 * Deliberately loose: a false positive costs a slightly earlier chunk break, a
 * false negative costs nothing that the blank-line rule doesn't already catch.
 */
const DECLARATION_START =
  /^(?:export\s|module\.exports|declare\s|@|(?:public|private|protected|internal|static|final|abstract|async|unsafe|pub)\s+)?(?:function|class|interface|type|enum|struct|impl|trait|def|fn|func|const|let|var|package|namespace|describe|it|test)\b/;

/** A markdown heading — the natural split point in prose files. */
const HEADING = /^#{1,6}\s/;

/**
 * Split a file into units that shouldn't be cut in half: a run of lines from
 * one top-level declaration (or heading, or blank-line-separated block) up to
 * the next.
 */
function splitUnits(text: string): string[] {
  const lines = text.split("\n");
  const units: string[] = [];
  let current: string[] = [];
  let sawContent = false;
  for (const line of lines) {
    const boundary =
      sawContent && (DECLARATION_START.test(line) || HEADING.test(line));
    if (boundary) {
      units.push(current.join("\n"));
      current = [line];
      sawContent = line.trim().length > 0;
      continue;
    }
    current.push(line);
    if (line.trim().length > 0) sawContent = true;
  }
  if (current.length > 0) units.push(current.join("\n"));
  return units.filter((u) => u.length > 0);
}

/** Last-resort split for a single unit that is itself larger than a chunk. */
function windowUnit(unit: string): string[] {
  const out: string[] = [];
  let pos = 0;
  while (pos < unit.length) {
    const end = Math.min(unit.length, pos + CHUNK_CHARS);
    out.push(unit.slice(pos, end));
    if (end >= unit.length) break;
    pos = end - CHUNK_OVERLAP;
  }
  return out;
}

/**
 * Chunk a file for embedding.
 *
 * Fixed character windows routinely cut through the middle of a function, so a
 * chunk would carry the tail of one definition and the head of the next and
 * match neither well. Units are packed greedily instead, and each chunk is
 * prefixed with the file path so location is part of what gets embedded —
 * "where is auth checked" should be able to match `src/auth/check.ts`.
 */
export function chunkText(text: string, relPath = ""): string[] {
  const header = relPath ? `// ${relPath}\n` : "";
  const budget = Math.max(200, CHUNK_CHARS - header.length);
  const packed: string[] = [];
  let current = "";
  for (const unit of splitUnits(text)) {
    if (unit.length > budget) {
      if (current) {
        packed.push(current);
        current = "";
      }
      packed.push(...windowUnit(unit));
      continue;
    }
    if (current.length + unit.length + 1 > budget) {
      packed.push(current);
      current = unit;
      continue;
    }
    current = current ? `${current}\n${unit}` : unit;
  }
  if (current) packed.push(current);
  const chunks = packed.length > 0 ? packed : [text];
  return chunks.map((c) => header + c);
}

/**
 * Build (or rebuild) the project's semantic index.
 *
 * Incremental: a file whose content hash matches the previous index keeps its
 * existing embeddings instead of being re-embedded. A full rebuild re-charged
 * for every chunk in the repo on every `/index`, which made keeping the index
 * fresh expensive enough that people don't.
 */
export async function buildIndex(
  config: ClawConfig,
  onProgress?: (msg: string) => void
): Promise<{ index: RagIndex; filesIndexed: number; chunks: number; reusedChunks: number }> {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });

  // Never index the index: with projectDir inside workdir it would embed its
  // own embeddings, growing the index every rebuild.
  const selfPath = path.resolve(indexFile(config));
  const candidates: string[] = [];
  for (const f of walkFiles(config.workdir, config.workdir)) {
    try {
      if (path.resolve(f) === selfPath) continue;
      const stat = fs.statSync(f);
      if (stat.size > MAX_FILE_BYTES) continue;
      candidates.push(f);
    } catch {}
  }
  const ignored = gitIgnoredPaths(config.workdir, candidates);
  const files = candidates.filter((f) => !ignored.has(path.resolve(f)));

  onProgress?.(
    `scanning ${files.length} file(s)${ignored.size > 0 ? ` (${ignored.size} git-ignored)` : ""}…`
  );

  // Previous embeddings, keyed by file + content hash.
  const previous = loadIndex(config);
  const reusable = new Map<string, RagChunk[]>();
  if (previous && previous.model === EMBED_MODEL) {
    for (const c of previous.chunks) {
      if (!c.fileHash) continue;
      const key = `${c.file}\u0000${c.fileHash}`;
      const list = reusable.get(key);
      if (list) list.push(c);
      else reusable.set(key, [c]);
    }
  }

  type Pending = { file: string; chunkIndex: number; fileHash: string; text: string };
  const pending: Pending[] = [];
  const chunks: RagChunk[] = [];
  let reusedChunks = 0;
  for (const f of files) {
    try {
      const text = fs.readFileSync(f, "utf8");
      if (!text.trim()) continue;
      const rel = path.relative(config.workdir, f);
      const fileHash = sha256(text);
      const cached = reusable.get(`${rel}\u0000${fileHash}`);
      if (cached) {
        chunks.push(...cached);
        reusedChunks += cached.length;
        continue;
      }
      chunkText(text, rel).forEach((p, i) =>
        pending.push({ file: rel, chunkIndex: i, fileHash, text: p })
      );
    } catch {}
  }

  onProgress?.(
    `embedding ${pending.length} chunk(s)${reusedChunks > 0 ? `, reusing ${reusedChunks}` : ""}…`
  );

  const BATCH = 64;
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
        fileHash: slice[j].fileHash,
        text: slice[j].text,
        embedding: res.data[j].embedding,
      });
    }
    onProgress?.(`embedded ${Math.min(i + BATCH, pending.length)}/${pending.length}`);
  }

  chunks.sort((a, b) => (a.file === b.file ? a.chunkIndex - b.chunkIndex : a.file < b.file ? -1 : 1));

  const idx: RagIndex = {
    version: INDEX_VERSION,
    workdir: config.workdir,
    model: EMBED_MODEL,
    builtAt: new Date().toISOString(),
    chunks,
  };
  saveIndex(config, idx);
  return { index: idx, filesIndexed: files.length, chunks: chunks.length, reusedChunks };
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
