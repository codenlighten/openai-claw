export function ok(content, display) {
    return { content, display };
}
export function err(message) {
    return { content: message, isError: true };
}
//# sourceMappingURL=types.js.map