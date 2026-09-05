import { spawn } from "node:child_process";
import path from "node:path";
import { ok, err } from "./types.js";
const MAX_OUTPUT = 200_000;
export const grepTool = {
    name: "Grep",
    description: "Search file contents using ripgrep-style regex. Supports glob filters, content/files-with-matches/count output, line numbers, context lines, and multiline mode. Prefer this over `grep` via Bash.",
    needsPermission: false,
    mutates: false,
    parameters: {
        type: "object",
        properties: {
            pattern: { type: "string", description: "Regex pattern to search for" },
            path: { type: "string", description: "Directory or file to search (default: cwd)" },
            glob: { type: "string", description: "Glob filter, e.g. '*.ts'" },
            type: { type: "string", description: "File type filter, e.g. 'ts', 'py'" },
            output_mode: {
                type: "string",
                enum: ["content", "files_with_matches", "count"],
                description: "Output mode (default 'files_with_matches')",
            },
            "-i": { type: "boolean", description: "Case-insensitive" },
            "-n": { type: "boolean", description: "Show line numbers (with content mode)" },
            "-A": { type: "number", description: "Lines of context after match" },
            "-B": { type: "number", description: "Lines of context before match" },
            "-C": { type: "number", description: "Lines of context around match" },
            head_limit: { type: "number", description: "Limit output to N lines" },
            multiline: {
                type: "boolean",
                description: "Enable multiline regex mode (-U). Patterns may span newlines.",
            },
        },
        required: ["pattern"],
    },
    async run(input, ctx) {
        const args = [];
        const mode = input.output_mode ?? "files_with_matches";
        if (mode === "files_with_matches")
            args.push("-l");
        else if (mode === "count")
            args.push("-c");
        if (input["-i"])
            args.push("-i");
        if (mode === "content" && input["-n"])
            args.push("-n");
        if (input["-A"] !== undefined)
            args.push("-A", String(input["-A"]));
        if (input["-B"] !== undefined)
            args.push("-B", String(input["-B"]));
        if (input["-C"] !== undefined)
            args.push("-C", String(input["-C"]));
        if (input.glob)
            args.push("--glob", input.glob);
        if (input.type)
            args.push("--type", input.type);
        if (input.multiline)
            args.push("-U", "--multiline-dotall");
        // Cap matches at ripgrep level when possible — saves memory on huge result sets.
        if (input.head_limit && mode === "content") {
            args.push("--max-count", String(input.head_limit));
        }
        // `-e` and `--` keep a flag-shaped pattern a pattern. Passed positionally,
        // a search for "--files" is consumed by ripgrep as its own flag and every
        // file comes back as a match.
        args.push("-e", input.pattern);
        args.push("--", path.resolve(input.path ?? ctx.config.workdir));
        return new Promise((resolve) => {
            const child = spawn("rg", args, { cwd: ctx.config.workdir, env: process.env });
            let out = "";
            let errOut = "";
            let truncated = false;
            child.stdout.on("data", (d) => {
                // The result is capped again downstream, so accumulating an unbounded
                // match set here only risks the process before anything can use it.
                if (out.length >= MAX_OUTPUT) {
                    truncated = true;
                    child.kill("SIGTERM");
                    return;
                }
                out += d.toString();
            });
            child.stderr.on("data", (d) => {
                if (errOut.length < MAX_OUTPUT)
                    errOut += d.toString();
            });
            child.on("error", (e) => {
                resolve(err(`Failed to run ripgrep (is it installed?): ${e.message}`));
            });
            child.on("close", (code) => {
                if (truncated) {
                    let lines = out.split("\n");
                    if (input.head_limit)
                        lines = lines.slice(0, input.head_limit);
                    return resolve(ok(`${lines.join("\n").trim()}\n[truncated at ${MAX_OUTPUT} chars — narrow the pattern, add a glob/type filter, or set head_limit]`));
                }
                if (code === 1)
                    return resolve(ok("(no matches)"));
                if (code !== 0 && code !== null) {
                    return resolve(err(errOut || `ripgrep exited ${code}`));
                }
                let lines = out.split("\n");
                if (input.head_limit)
                    lines = lines.slice(0, input.head_limit);
                resolve(ok(lines.join("\n").trim() || "(no matches)"));
            });
        });
    },
    preview: (input) => `Grep ${input.pattern} in ${input.path ?? "."}`,
};
//# sourceMappingURL=grep.js.map