import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/** Only provider tool rows carry the native call identity needed by render hooks. */
export function modUiToolProps(item: OrchestrationV2TurnItem | undefined) {
  if (
    !item ||
    !item.nativeItemRef?.nativeId ||
    (item.type !== "dynamic_tool" && item.type !== "command_execution")
  )
    return null;
  const tool = item.type === "dynamic_tool" ? item.toolName : "Bash";
  if (!tool) return null;
  const output =
    item.type === "command_execution" && item.output !== undefined
      ? { stdout: item.output, stderr: "", interrupted: item.status === "interrupted" }
      : item.output;
  return {
    tool_use_id: item.nativeItemRef.nativeId,
    tool,
    input: item.type === "command_execution" ? { command: item.input } : item.input,
    isRunning: item.status === "running" || item.status === "pending",
    isErrored: item.status === "failed",
    isInterrupted: item.status === "interrupted",
    ...(output === undefined ? {} : { output }),
  };
}

/** A rewritten native result replaces only its presentation in the transcript. */
export function modUiResultText(original: unknown, rewritten: unknown): string | null {
  if (JSON.stringify(original) === JSON.stringify(rewritten)) return null;
  if (typeof rewritten === "string") return rewritten;
  if (
    typeof rewritten === "object" &&
    rewritten !== null &&
    "stdout" in rewritten &&
    typeof rewritten.stdout === "string"
  )
    return rewritten.stdout;
  return JSON.stringify(rewritten, null, 2) ?? "";
}
