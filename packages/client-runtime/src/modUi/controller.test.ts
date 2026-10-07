import { describe, expect, it, vi } from "@effect/vitest";
import { createModUiController, type ModUiState } from "./controller.ts";
import { createModUiComposer } from "./composer.ts";
const drawing = {
  tree: { type: "Text", children: ["Example mod"] },
  props: {},
  rewritten: false,
  hooked: true,
};
describe("mod UI host", () => {
  it("leaves no empty region when a native mod returns the default drawing", async () => {
    const states: ModUiState[] = [];
    const host = createModUiController({
      send: async (operation) =>
        operation === "capabilities"
          ? { supported: true }
          : operation === "ui_render"
            ? { ...drawing, tree: { type: "engine" } }
            : { panes: [] },
      surface: "desktop",
      update: (state) => states.push(state),
      hostRequest: async () => ({}),
    });
    await host.start();
    expect(states.at(-1)?.supported).toBe(true);
    expect(states.at(-1)?.above).toBe(null);
    await host.close();
  });
  it("renders the selected pane and follows native invalidation", async () => {
    const states: ModUiState[] = [];
    const send = vi.fn(async (operation: string, payload?: Record<string, unknown>) => {
      if (operation === "capabilities") return { supported: true };
      if (operation === "ui_panes")
        return {
          panes: [
            { id: "one", title: "First" },
            { id: "two", title: "Second" },
          ],
          shown_id: "two",
          focused_id: "two",
        };
      if (operation === "ui_render")
        return { ...drawing, tree: { type: "Text", children: [payload?.instance_id] } };
      return {};
    });
    const host = createModUiController({
      send,
      surface: "desktop",
      update: (state) => states.push(state),
      hostRequest: async () => ({}),
    });
    await host.start();
    expect(states.at(-1)?.shownId).toBe("two");
    expect(states.at(-1)?.panes.map((pane) => pane.tree)).toEqual([
      null,
      { type: "Text", children: ["two"] },
    ]);
    expect(
      send.mock.calls.filter(
        ([operation, p]) => operation === "ui_render" && p?.component === "Pane",
      ),
    ).toHaveLength(1);
    await host.act("ui_press", { plugin: "example", handle: 1 });
    expect(send.mock.calls.filter(([operation]) => operation === "ui_render")).toHaveLength(4);
    await host.close();
    expect(send.mock.calls.at(-1)?.[0]).toBe("ui_detach");
  });
  it("does not revive a host disposed during initialization", async () => {
    let finish!: (value: unknown) => void;
    const update = vi.fn();
    const host = createModUiController({
      send: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      surface: "mobile",
      update,
      hostRequest: async () => ({}),
    });
    const started = host.start();
    await host.close();
    finish({ supported: true });
    await started;
    expect(update).not.toHaveBeenCalled();
  });
  it("renders only changed transcript sites on viewport updates", async () => {
    const send = vi.fn(async (operation: string, _payload?: Record<string, unknown>) =>
      operation === "capabilities"
        ? { supported: true }
        : operation === "ui_render"
          ? drawing
          : { panes: [] },
    );
    const host = createModUiController({
      send,
      surface: "desktop",
      update: () => {},
      hostRequest: async () => ({}),
    });
    host.registerSite("AssistantMessage", "message", { text: "hello" }, () => {});
    await host.start();
    const messageRenders = () =>
      send.mock.calls.filter(
        ([operation, payload]) =>
          operation === "ui_render" && payload?.component === "AssistantMessage",
      );
    expect(messageRenders()).toHaveLength(1);
    host.setViewport(80, false);
    await host.refresh();
    expect(messageRenders()).toHaveLength(1);
    await host.act("ui_press", {});
    expect(messageRenders()).toHaveLength(1);
    await host.act("ui_press", { component: "AssistantMessage", instance_id: "message" });
    expect(messageRenders()).toHaveLength(2);
    await host.close();
  });
  it("does not publish a render from a session that exited", async () => {
    let finish!: (value: unknown) => void;
    const states: ModUiState[] = [];
    let notifyRender!: () => void;
    const renderStarted = new Promise<void>((resolve) => {
      notifyRender = resolve;
    });
    const host = createModUiController({
      send: async (operation) => {
        if (operation === "capabilities") return { supported: true };
        if (operation === "ui_render")
          return new Promise((resolve) => {
            finish = resolve;
            notifyRender();
          });
        return { panes: [] };
      },
      surface: "desktop",
      update: (state) => states.push(state),
      hostRequest: async () => ({}),
    });
    const started = host.start();
    await renderStarted;
    host.receive({ subtype: "session_unavailable", payload: {} });
    finish(drawing);
    await started;
    expect(states.at(-1)?.supported).toBe(false);
    expect(states.at(-1)?.above).toBe(null);
    await host.close();
  });
  it("waits for native mod initialization before rendering", async () => {
    const send = vi.fn(async (operation: string) =>
      operation === "capabilities"
        ? { supported: true, ready: false }
        : operation === "ui_render"
          ? drawing
          : { panes: [] },
    );
    const host = createModUiController({
      send,
      surface: "desktop",
      update: () => {},
      hostRequest: async () => ({}),
    });
    await host.start();
    expect(send.mock.calls.some(([operation]) => operation === "ui_render")).toBe(false);
    host.receive({ subtype: "session_ready", payload: { modsReady: true } });
    await host.refresh();
    expect(send.mock.calls.some(([operation]) => operation === "ui_render")).toBe(true);
    await host.close();
  });
  it("fills at the cursor and acknowledges the native composer protocol", async () => {
    let box = { text: "hello world", cursor: 6 };
    const handler = createModUiComposer({
      read: () => box,
      fill: (text, cursor) => {
        box = { text, cursor };
      },
      copy: async () => {},
      suggest: () => true,
    });
    expect(await handler("ui_prompt_fill", { text: "mod ", mode: "insert" })).toEqual({
      filled: true,
    });
    expect(await handler("ui_prompt_read", {})).toEqual({ text: "hello mod world", cursor: 10 });
    expect(await handler("ui_prompt_suggest", { text: "suggestion" })).toEqual({ shown: false });
    expect(await handler("ui_copy", { text: "copied" })).toEqual({ copied: true });
  });
});
