import { describe, expect, it, vi } from "@effect/vitest";
import { ThreadId, type ProviderModUiEvent, type ProviderModUiRequest } from "@t3tools/contracts";
import { createClaudeModUi } from "./ClaudeModUi.ts";
const input = (
  operation: ProviderModUiRequest["operation"],
  payload: Record<string, unknown> = {},
  clientId = "desktop-1",
): ProviderModUiRequest => ({ threadId: ThreadId.make("thread"), clientId, operation, payload });
function setup(capabilities = ["ui_surface_v1"]) {
  const events: ProviderModUiEvent[] = [];
  const request = vi.fn(async (payload: unknown) => ({ response: payload }));
  const setUiHost = vi.fn();
  const ui = createClaudeModUi(
    { request, setUiHost, initializationResult: async () => ({ capabilities }) },
    (event) => events.push(event),
  );
  const host = setUiHost.mock.calls[0]?.[0] as {
    promptRead: (payload: unknown, context: { signal?: AbortSignal }) => Promise<unknown>;
  };
  return { ui, events, request, host };
}
describe("Claude mod UI SDK bridge", () => {
  it("detects native UI support without opening another provider process", async () => {
    const { ui, request } = setup();
    expect(await ui.request(input("capabilities"))).toEqual({
      supported: true,
      composer: true,
      ready: false,
    });
    expect(request).not.toHaveBeenCalled();
    expect(await setup([]).ui.request(input("capabilities"))).toEqual({
      supported: false,
      composer: true,
      ready: false,
    });
  });
  it("pins operation and client identity while preserving arbitrary mod props", async () => {
    const { ui, request } = setup();
    await ui.request(
      input("ui_render", {
        subtype: "interrupt",
        client_id: "other",
        component: "AbovePrompt",
        props: { arbitrary: { nested: 1 } },
      }),
    );
    expect(request).toHaveBeenCalledWith({
      subtype: "ui_render",
      client_id: "desktop-1",
      component: "AbovePrompt",
      props: { arbitrary: { nested: 1 } },
    });
    await expect(ui.request(input("ui_attach", {}, "bad client"))).rejects.toThrow("Invalid");
  });
  it("routes composer replies only to the requesting client", async () => {
    const { ui, host, events } = setup();
    await ui.request(input("ui_attach"));
    const reply = host.promptRead({ client_id: "desktop-1" }, {});
    const requestId = events[0]?.payload.requestId;
    await ui.request(input("host_reply", { requestId, response: { text: "wrong" } }, "mobile-1"));
    await ui.request(input("host_reply", { requestId, response: { text: "draft", cursor: 5 } }));
    expect(await reply).toEqual({ text: "draft", cursor: 5 });
    ui.close();
  });
  it("releases pending callbacks on detach and cancellation", async () => {
    const { ui, host } = setup();
    await ui.request(input("ui_attach"));
    const detached = host.promptRead({ client_id: "desktop-1" }, {});
    await ui.request(input("ui_detach"));
    expect(await detached).toEqual({});
    await ui.request(input("ui_attach"));
    const controller = new AbortController();
    const aborted = host.promptRead({ client_id: "desktop-1" }, { signal: controller.signal });
    controller.abort();
    expect(await aborted).toEqual({});
    const closed = host.promptRead({ client_id: "desktop-1" }, {});
    ui.close();
    expect(await closed).toEqual({});
  });
  it("forwards native UI events without transcript envelopes", () => {
    const { ui, events } = setup();
    ui.receive({ type: "assistant", subtype: "ui_invalidate" });
    ui.receive({
      type: "system",
      subtype: "ui_invalidate",
      uuid: "uuid",
      session_id: "session",
      client_id: "desktop-1",
      plugin: "example",
    });
    expect(events).toEqual([
      {
        subtype: "ui_invalidate",
        client_id: "desktop-1",
        payload: { client_id: "desktop-1", plugin: "example" },
      },
    ]);
  });
});
