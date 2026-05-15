import { describe, it, expect } from "vitest";
import { redactSensitiveHunks } from "../src/subagent.js";

describe("subagent worktree diff redaction", () => {
  const benign = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`;
  const secret = `diff --git a/.env b/.env
new file mode 100644
--- /dev/null
+++ b/.env
@@ -0,0 +1 @@
+OPENAI_API_KEY=sk-leak
`;

  it("drops .env hunks and reports them", () => {
    const { diff, redacted } = redactSensitiveHunks(benign + secret);
    expect(diff).toContain("src/foo.ts");
    expect(diff).not.toContain("OPENAI_API_KEY");
    expect(diff).not.toContain(".env");
    expect(redacted).toEqual([".env"]);
  });

  it("drops nested .env.production and id_rsa hunks", () => {
    const nested = `diff --git a/config/.env.production b/config/.env.production
+++ b/config/.env.production
@@
+SECRET=1
diff --git a/keys/id_rsa b/keys/id_rsa
+++ b/keys/id_rsa
@@
+ssh-key
`;
    const { diff, redacted } = redactSensitiveHunks(benign + nested);
    expect(redacted.sort()).toEqual(["config/.env.production", "keys/id_rsa"]);
    expect(diff).toContain("src/foo.ts");
    expect(diff).not.toContain("SECRET=1");
    expect(diff).not.toContain("ssh-key");
  });

  it("returns the input unchanged when nothing is sensitive", () => {
    const { diff, redacted } = redactSensitiveHunks(benign);
    expect(diff).toBe(benign);
    expect(redacted).toEqual([]);
  });

  it("handles empty input", () => {
    expect(redactSensitiveHunks("")).toEqual({ diff: "", redacted: [] });
  });
});
