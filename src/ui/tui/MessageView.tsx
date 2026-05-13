import React from "react";
import { Box, Text } from "ink";
import type { ChatItem } from "./types.js";
import { Diff } from "./Diff.js";
import { renderMarkdown, renderStreamingMarkdown } from "./markdown.js";
import { highlightToolOutput } from "./highlight.js";

function renderAssistant(text: string, streaming?: boolean): string {
  if (streaming) return renderStreamingMarkdown(text);
  return renderMarkdown(text);
}

export function MessageView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>{"> "}</Text>
          <Text>{item.text}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box marginTop={1} flexDirection="column">
          <Text>{renderAssistant(item.text, item.streaming)}</Text>
        </Box>
      );

    case "tool_call": {
      const progressLines = (item.progress ?? "").split("\n").slice(-6);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="blue">▸ </Text>
            <Text color="blue">{item.preview}</Text>
          </Box>
          {item.progress && (
            <Box flexDirection="column" marginLeft={2}>
              {progressLines.map((line, i) => (
                <Text key={i} dimColor>
                  {line}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      );
    }

    case "tool_result": {
      if (item.display && (item.tool === "Write" || item.tool === "Edit")) {
        return <Diff patch={item.display} />;
      }
      const rendered = item.isError ? item.content : highlightToolOutput(item.tool, item.content);
      const lines = rendered.split("\n");
      const limit = 12;
      const shown = lines.slice(0, limit);
      const more = lines.length > shown.length ? lines.length - shown.length : 0;
      return (
        <Box flexDirection="column">
          {shown.map((line, i) => (
            <Text key={i} color={item.isError ? "red" : undefined} dimColor={!item.isError}>
              {"  " + line}
            </Text>
          ))}
          {more > 0 && <Text color="gray">{`  … (${more} more lines — /last to expand)`}</Text>}
        </Box>
      );
    }

    case "system":
      return <Text color="magenta">{item.text}</Text>;

    case "error":
      return (
        <Box marginTop={1}>
          <Text color="red">! {item.text}</Text>
        </Box>
      );
  }
}
