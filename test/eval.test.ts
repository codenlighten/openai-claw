import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  loadEvalCases,
  checkExpectations,
  snapshotDir,
  type EvalObservation,
} from "../src/eval/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-eval-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadEvalCases", () => {
  it("loads all .json fixtures", () => {
    fs.writeFileSync(
      path.join(tmp, "alpha.json"),
      JSON.stringify({ id: "alpha", prompt: "do alpha" })
    );
    fs.writeFileSync(
      path.join(tmp, "beta.json"),
      JSON.stringify({ id: "beta", prompt: "do beta" })
    );
    fs.writeFileSync(path.join(tmp, "ignored.txt"), "not a fixture");
    const cases = loadEvalCases(tmp);
    expect(cases).toHaveLength(2);
    expect(cases.map((c) => c.id).sort()).toEqual(["alpha", "beta"]);
  });

  it("falls back id to filename when absent", () => {
    fs.writeFileSync(path.join(tmp, "named.json"), JSON.stringify({ prompt: "x" }));
    const cases = loadEvalCases(tmp);
    expect(cases[0].id).toBe("named");
  });

  it("returns empty list when dir missing", () => {
    expect(loadEvalCases(path.join(tmp, "nope"))).toEqual([]);
  });
});

describe("eval case library", () => {
  const dir = path.join(process.cwd(), "test", "evals");
  const cases = loadEvalCases(dir);

  it("has enough cases to be a signal", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });

  it("reaches the agent logic that only mocks had exercised", () => {
    const ids = cases.map((c) => c.id);
    // Compaction and truncation are unreachable without the window knobs, so
    // both were mock-only until these cases existed.
    expect(ids).toContain("compaction-survives");
    expect(ids).toContain("truncation-is-surfaced");
    expect(cases.find((c) => c.id === "compaction-survives")?.expect?.compacted).toBe(true);
    expect(cases.find((c) => c.id === "truncation-is-surfaced")?.expect?.warned).toBe(true);
  });

  it("every case has a unique id, a prompt and at least one expectation", () => {
    const ids = new Set<string>();
    for (const c of cases) {
      expect(c.id, `case ${c.id}`).toBeTruthy();
      expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false);
      ids.add(c.id);
      expect(c.prompt.length, `case ${c.id} prompt`).toBeGreaterThan(10);
      expect(Object.keys(c.expect ?? {}).length, `case ${c.id} expectations`).toBeGreaterThan(0);
    }
  });

  it("every case's setup runs cleanly and produces the files it asserts on", () => {
    for (const c of cases) {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `claw-evalcheck-${c.id}-`));
      try {
        for (const cmd of c.setup ?? []) {
          const r = spawnSync("bash", ["-c", cmd], { cwd: sandbox, encoding: "utf8" });
          expect(r.status, `case ${c.id} setup failed: ${cmd}\n${r.stderr}`).toBe(0);
        }
        // Anything the case reads from must exist after setup. Files the agent
        // is meant to create are covered by files_exist, so they're excluded.
        const created = new Set(c.expect?.files_exist ?? []);
        const mustExist = [
          ...(c.expect?.files_unchanged ?? []),
          ...(c.expect?.file_not_matches ?? []).map((m) => m.path),
        ];
        for (const rel of mustExist) {
          if (created.has(rel)) continue;
          expect(fs.existsSync(path.join(sandbox, rel)), `case ${c.id}: setup did not create ${rel}`).toBe(true);
        }
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });

  it("covers the regressions we have actually shipped fixes for", () => {
    const ids = cases.map((c) => c.id);
    // Orphaned tool_call_id, both routes: a denial landing mid-dispatch and a
    // turn with many parallel calls.
    expect(ids).toContain("permission-denied-recovery");
    expect(ids).toContain("parallel-reads");
    // Project instructions at the repo root were never loaded.
    expect(ids).toContain("respects-project-instructions");
  });
});

describe("checkExpectations", () => {
  let sandbox: string;
  const obs = (over: Partial<EvalObservation> = {}): EvalObservation => ({
    toolsUsed: [],
    toolsDenied: [],
    compactions: 0,
    warnings: [],
    turns: 1,
    errors: [],
    before: {},
    ...over,
  });

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "claw-expect-"));
  });
  afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(sandbox, rel)), { recursive: true });
    fs.writeFileSync(path.join(sandbox, rel), body);
  };

  it("passes when everything holds", () => {
    write("a.txt", "hello");
    expect(
      checkExpectations(sandbox, { files_exist: ["a.txt"], file_matches: [{ path: "a.txt", pattern: "hello" }] }, obs())
    ).toEqual([]);
  });

  it("fails an agent error even when the files look right", () => {
    write("a.txt", "hello");
    const failures = checkExpectations(sandbox, { files_exist: ["a.txt"] }, obs({ errors: ["Bad request (400)"] }));
    expect(failures.join(" ")).toContain("400");
  });

  it("allows errors when the case opts in", () => {
    expect(checkExpectations(sandbox, {}, obs({ errors: ["boom"] }), true)).toEqual([]);
  });

  it("catches content that should have been removed", () => {
    write("a.js", "computeTotal()");
    const failures = checkExpectations(sandbox, { file_not_matches: [{ path: "a.js", pattern: "computeTotal" }] }, obs());
    expect(failures.join(" ")).toContain("still matches");
  });

  it("catches an unrequested new file", () => {
    write("kept.txt", "x");
    const before = snapshotDir(sandbox);
    write("README.md", "unasked-for docs");
    const failures = checkExpectations(sandbox, { no_new_files: true }, obs({ before }));
    expect(failures.join(" ")).toContain("README.md");
  });

  it("catches a file that was modified but should not have been", () => {
    write("keep.txt", "original");
    const before = snapshotDir(sandbox);
    write("keep.txt", "meddled with");
    const failures = checkExpectations(sandbox, { files_unchanged: ["keep.txt"] }, obs({ before }));
    expect(failures.join(" ")).toContain("keep.txt");
  });

  it("catches a forbidden tool and a missing one", () => {
    const failures = checkExpectations(
      sandbox,
      { tools_used: ["Grep"], tools_not_used: ["Write"] },
      obs({ toolsUsed: ["Write", "Read"] })
    );
    expect(failures.join(" ")).toContain("tool not used: Grep");
    expect(failures.join(" ")).toContain("should not have been used: Write");
  });

  it("catches a case that allowlisted its way past the denial it exists to test", () => {
    write("note.txt", "noted");
    const failures = checkExpectations(
      sandbox,
      { files_exist: ["note.txt"], tools_denied: ["Bash"] },
      obs({ toolsUsed: ["Write"], toolsDenied: [] })
    );
    expect(failures.join(" ")).toContain("expected Bash to be denied");
  });

  it("passes when the denial actually happened", () => {
    write("note.txt", "noted");
    expect(
      checkExpectations(
        sandbox,
        { files_exist: ["note.txt"], tools_denied: ["Bash"] },
        obs({ toolsUsed: ["Write"], toolsDenied: ["Bash"] })
      )
    ).toEqual([]);
  });

  it("catches thrashing that still lands correctly", () => {
    write("a.txt", "done");
    const failures = checkExpectations(
      sandbox,
      { files_exist: ["a.txt"], max_turns_used: 5 },
      obs({ turns: 19 })
    );
    expect(failures.join(" ")).toContain("19 turns");
  });

  it("runs shell_passes in the sandbox", () => {
    write("ok.sh", "exit 0");
    expect(checkExpectations(sandbox, { shell_passes: ["bash ok.sh"] }, obs())).toEqual([]);
    expect(checkExpectations(sandbox, { shell_passes: ["exit 7"] }, obs()).join(" ")).toContain("exit 7");
  });
});
