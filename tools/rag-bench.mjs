#!/usr/bin/env node
/**
 * Retrieval benchmark for the semantic index.
 *
 *   node tools/rag-bench.mjs      (needs OPENAI_API_KEY; costs a few cents)
 *
 * Embeds this repository's own source under two chunking strategies and scores
 * 30 intent-phrased queries — none of which names its target file — against a
 * hand-written ground truth of which file implements the thing. Reports
 * recall@1, recall@3 and MRR over deduplicated file rankings.
 *
 * Why it exists: structural chunking and a per-chunk file-path prefix were both
 * added on the theory that they improve retrieval. They do not. Measured, the
 * prefix was slightly harmful (a filename lexically matching a query word
 * outranks the file that implements it) and was removed; structural chunking is
 * indistinguishable from fixed windows and is kept only for snippet coherence.
 *
 * READ THE NOISE FLOOR BEFORE BELIEVING A RESULT: editing a single source file
 * between runs moved the same variant by one query and 0.016 MRR, which is
 * larger than the gap between the variants. Treat differences of this size as
 * nothing. To claim a real improvement you need a bigger query set, a corpus
 * that is not also the thing being edited, or both.
 */
import fs from "node:fs";
import path from "node:path";
const { default: OpenAI } = await import("openai");

const R = path.resolve(new URL("..", import.meta.url).pathname);
const { loadEnvFiles } = await import(`${R}/dist/env.js`);
loadEnvFiles();
const { chunkText } = await import(`${R}/dist/rag/index.js`);

const CHUNK_CHARS = 4000, CHUNK_OVERLAP = 400;

/** The chunker as it was before this session: fixed windows, no path context. */
function oldChunk(text) {
  if (text.length <= CHUNK_CHARS) return [text];
  const out = []; let pos = 0;
  while (pos < text.length) {
    const end = Math.min(text.length, pos + CHUNK_CHARS);
    out.push(text.slice(pos, end));
    if (end >= text.length) break;
    pos = end - CHUNK_OVERLAP;
  }
  return out;
}

const EXT = new Set([".ts", ".tsx"]);
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (EXT.has(path.extname(e.name))) yield full;
  }
}

const files = [...walk(path.join(R, "src")), ...walk(path.join(R, "packages/openai-claw-verify/src"))];

// Ground truth: intent-phrased queries, none naming its target file, mapped to
// the file that actually implements the thing.
const QUERIES = [
  ["how are shell commands checked before they are allowed to run", "src/permissions/index.ts"],
  ["combining leaf hashes into a single deterministic root", "packages/openai-claw-verify/src/merkle.ts"],
  ["repairing a conversation whose tool responses lost their parent call", "src/agent.ts"],
  ["assembling the binary timestamp proof file", "src/attest/ots-file.ts"],
  ["deciding which environment variables a spawned server may see", "src/mcp/fingerprint.ts"],
  ["serving session transcripts and spend over http", "src/web/index.ts"],
  ["checking whether a scenario met its expected outcome", "src/eval/index.ts"],
  ["keeping a checklist of steps across a session", "src/tools/todo.ts"],
  ["shrinking an over-long conversation into a recap", "src/memory/compaction.ts"],
  ["cloning an extension from a remote repository and linking it", "src/plugins/index.ts"],
  ["preserving windows line endings when replacing a file's contents", "src/tools/write.ts"],
  ["asking the user whether to honour a repository's configuration", "src/trust.ts"],
  ["turning a tool's json schema into the strict form the api wants", "src/client.ts"],
  ["ranking stored code fragments by similarity to a question", "src/rag/index.ts"],
  ["running a task in a throwaway checkout and returning the diff", "src/subagent.ts"],
  ["working out what a request will cost from token counts", "src/cost.ts"],
  ["generating a post-quantum signing keypair and storing it on disk", "src/attest/identity.ts"],
  ["submitting a digest to public timestamping calendars", "src/attest/anchor.ts"],
  ["merging settings from a user file and a project file", "src/config.ts"],
  ["saving a conversation so it can be resumed later", "src/session.ts"],
  ["running configured shell commands at lifecycle points", "src/hooks/index.ts"],
  ["expanding file references typed into a message", "src/input.ts"],
  ["sending a desktop or webhook alert when work finishes", "src/notifications/index.ts"],
  ["storing durable notes that persist between sessions", "src/memory/index.ts"],
  ["scanning past transcripts for recurring corrections", "src/self-review/index.ts"],
  ["starting an external provider over stdio and wrapping what it offers", "src/mcp/index.ts"],
  ["listing directory entries while skipping ignored patterns", "src/tools/ls.ts"],
  ["fetching a web page and reducing it to readable text", "src/tools/webfetch.ts"],
  ["the standing instructions that shape how the assistant behaves", "src/prompts/system.ts"],
  ["reporting which audit checks passed or failed", "packages/openai-claw-verify/src/verify.ts"],
];

function build(kind) {
  const chunks = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    if (!text.trim()) continue;
    const rel = path.relative(R, f);
    const parts =
      kind === "old" ? oldChunk(text) : chunkText(text);
    parts.forEach((t, i) => chunks.push({ file: rel, i, text: t }));
  }
  return chunks;
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 64) {
    const res = await client.embeddings.create({ model: "text-embedding-3-small", input: texts.slice(i, i + 64) });
    out.push(...res.data.map((d) => d.embedding));
  }
  return out;
}
const cos = (a, b) => {
  let d = 0, am = 0, bm = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; am += a[i] * a[i]; bm += b[i] * b[i]; }
  return d / (Math.sqrt(am) * Math.sqrt(bm) + 1e-10);
};

const qvecs = await embed(QUERIES.map(([q]) => q));
const variants = ["old", "structural"];
const results = {};
let totalChunks = 0;

for (const kind of variants) {
  const chunks = build(kind);
  totalChunks += chunks.length;
  const vecs = await embed(chunks.map((c) => c.text));
  let r1 = 0, r3 = 0, mrr = 0;
  const misses = [];
  QUERIES.forEach(([q, want], qi) => {
    const ranked = chunks
      .map((c, ci) => ({ file: c.file, s: cos(qvecs[qi], vecs[ci]) }))
      .sort((a, b) => b.s - a.s);
    const seen = [];
    for (const r of ranked) if (!seen.includes(r.file)) seen.push(r.file);
    const rank = seen.indexOf(want) + 1;
    if (rank === 1) r1++;
    if (rank > 0 && rank <= 3) r3++;
    if (rank > 0) mrr += 1 / rank;
    if (rank !== 1) misses.push(`${q}  →  got ${seen[0]} (want ${want}${rank > 0 ? `, rank ${rank}` : ", absent"})`);
  });
  results[kind] = { chunks: chunks.length, r1, r3, mrr: mrr / QUERIES.length, misses };
}

console.log(`corpus: ${files.length} files, ${QUERIES.length} queries\n`);
console.log("variant            chunks   recall@1   recall@3    MRR");
for (const k of variants) {
  const v = results[k];
  console.log(
    `${k.padEnd(18)} ${String(v.chunks).padStart(5)}   ${String(v.r1).padStart(2)}/${QUERIES.length}      ${String(v.r3).padStart(2)}/${QUERIES.length}     ${v.mrr.toFixed(3)}`
  );
}
for (const k of variants) {
  if (results[k].misses.length) {
    console.log(`\n${k} misses:`);
    for (const m of results[k].misses) console.log("  " + m);
  }
}
