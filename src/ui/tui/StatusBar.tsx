import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ClawConfig } from "../../config.js";

export function StatusBar({
  config,
  busy,
  totalTokens,
  totalCostUSD,
}: {
  config: ClawConfig;
  busy: boolean;
  totalTokens: number;
  totalCostUSD: number;
}) {
  const cost = totalCostUSD > 0 ? ` $${totalCostUSD.toFixed(4)}` : "";
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {busy ? <Spinner type="dots" /> : "●"}{" "}
        <Text bold color="cyan">openai-claw</Text>{" "}
        <Text dimColor>model={config.model} mode={config.permissionMode} tokens={totalTokens}{cost}</Text>
      </Text>
    </Box>
  );
}
