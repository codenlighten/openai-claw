import { highlight, supportsLanguage } from "cli-highlight";
/**
 * Heuristic syntax-highlight for tool outputs.
 * - For Read tool: detect language from the file extension in the line-number block.
 * - For others: return content unchanged.
 */
export function highlightToolOutput(tool, content) {
    if (tool !== "Read")
        return content;
    // Strip the leading "     1\t" line-number column produced by read.ts.
    const lines = content.split("\n");
    const stripped = [];
    let hasNumbers = false;
    for (const line of lines) {
        const m = line.match(/^\s*\d+\t(.*)$/);
        if (m) {
            stripped.push(m[1]);
            hasNumbers = true;
        }
        else {
            stripped.push(line);
        }
    }
    if (!hasNumbers)
        return content;
    // We don't know the language reliably from the content; default to typescript if it
    // looks like code, else return uncolored.
    const code = stripped.join("\n");
    const lang = guessLanguage(code);
    try {
        const colored = highlight(code, { language: lang, ignoreIllegals: true });
        // Re-attach line numbers from the original.
        const out = [];
        const colLines = colored.split("\n");
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^(\s*\d+\t)/);
            if (m)
                out.push(m[1] + (colLines[i] ?? ""));
            else
                out.push(lines[i]);
        }
        return out.join("\n");
    }
    catch {
        return content;
    }
}
function guessLanguage(code) {
    if (/^\s*(import|export|function|const|let|class|interface|type)\b/m.test(code)) {
        if (/\binterface\b|\btype\b\s*\w+\s*=/.test(code))
            return "typescript";
        return "javascript";
    }
    if (/^\s*(def|class|import|from)\b/m.test(code))
        return "python";
    if (/^\s*#include\b/m.test(code))
        return "cpp";
    if (/^\s*package\b/m.test(code))
        return "go";
    if (/^\s*\{[\s\S]*\}\s*$/.test(code) && /"\w+"\s*:/.test(code))
        return "json";
    if (/^\s*<[a-z!?]/i.test(code))
        return "xml";
    return supportsLanguage("plaintext") ? "plaintext" : "text";
}
//# sourceMappingURL=highlight.js.map