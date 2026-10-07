import { text } from "./controller.ts";

export function createModUiComposer(options: {
  readonly read: () => { text: string; cursor: number } | null;
  readonly fill: (text: string, cursor: number) => void;
  readonly copy: (text: string) => Promise<void>;
  readonly suggest: (text: string) => boolean;
}) {
  return async (operation: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (operation === "ui_copy") {
      try {
        await options.copy(text(payload.text));
        return { copied: true };
      } catch {
        return { copied: false };
      }
    }
    const box = options.read();
    if (operation === "ui_prompt_read") return box ?? { text: "", cursor: 0 };
    if (operation === "ui_prompt_suggest")
      return { shown: box?.text === "" && options.suggest(text(payload.text)) };
    if (operation === "ui_prompt_fill") {
      if (!box) return { filled: false };
      const value = text(payload.text);
      const cursor = Math.max(0, Math.min(box.text.length, box.cursor));
      const next =
        payload.mode === "append"
          ? box.text + value
          : payload.mode === "insert"
            ? box.text.slice(0, cursor) + value + box.text.slice(cursor)
            : value;
      options.fill(next, payload.mode === "insert" ? cursor + value.length : next.length);
      return { filled: true };
    }
    return {};
  };
}
