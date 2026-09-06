import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load .env files into process.env. Every entry point must call this before
 * anything reads a key — `npm run eval` did not, so the eval runner failed on
 * every case with "OPENAI_API_KEY is not set" for anyone who keeps their key
 * in .env, which is what the docs tell them to do.
 *
 * Order (later wins): bundled project .env, ~/.openai-claw/.env, cwd .env,
 * cwd .env.local. `override: false` means an already-exported variable beats
 * every file.
 */
export function loadEnvFiles(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, "..");
  const cwd = process.cwd();
  const userHomeEnv = path.join(process.env.HOME ?? "", ".openai-claw", ".env");
  const candidates = [
    path.join(projectRoot, ".env"),
    path.join(projectRoot, ".env.local"),
    userHomeEnv,
    ...(cwd !== projectRoot ? [path.join(cwd, ".env"), path.join(cwd, ".env.local")] : []),
  ];
  const loaded: string[] = [];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    dotenv.config({ path: file, override: false, quiet: true });
    loaded.push(file);
  }
  return loaded;
}
