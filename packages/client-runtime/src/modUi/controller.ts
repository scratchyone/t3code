import {
  ProviderModUiRender,
  type ProviderModUiEvent,
  type ProviderModUiRequest,
  type ProviderModUiSurface,
  type ProviderModUiNode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeRender = Schema.decodeUnknownSync(ProviderModUiRender);

export const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const text = (value: unknown) => (typeof value === "string" ? value : "");
export interface ModUiPane {
  readonly id: string;
  readonly title: string;
  readonly plugin: string;
  readonly tree: ProviderModUiNode | null;
  readonly modules: Readonly<Record<string, string>>;
}
export interface ModUiState {
  readonly supported: boolean;
  readonly above: ProviderModUiNode | null;
  readonly panes: ReadonlyArray<ModUiPane>;
  readonly shownId: string | null;
  readonly focusedId: string | null;
  readonly modules: Readonly<Record<string, string>>;
  readonly statuses: Readonly<Record<string, string>>;
  readonly notices: ReadonlyArray<{ readonly plugin: string; readonly text: string }>;
  readonly error: string | null;
}
export const emptyModUiState: ModUiState = {
  supported: false,
  above: null,
  panes: [],
  shownId: null,
  focusedId: null,
  modules: {},
  statuses: {},
  notices: [],
  error: null,
};
export type ModUiSend = (
  operation: ProviderModUiRequest["operation"],
  payload?: Record<string, unknown>,
) => Promise<unknown>;

/** One mounted client; invalidations coalesce, and late results cannot revive an unmounted host. */
export function createModUiController(options: {
  readonly send: ModUiSend;
  readonly surface: ProviderModUiSurface;
  readonly update: (state: ModUiState) => void;
  readonly hostRequest: (operation: string, payload: Record<string, unknown>) => Promise<unknown>;
}) {
  let state = emptyModUiState;
  const sites = new Map<
    string,
    {
      component: string;
      instanceId: string;
      props: Record<string, unknown>;
      update: (drawing: typeof ProviderModUiRender.Type) => void;
      dirty: boolean;
    }
  >();
  const regions = new Map<
    string,
    {
      scroll: { offset: number; bodyRows: number; contentRows: number };
      receive: (event: ProviderModUiEvent) => void;
    }
  >();
  const layout = (component: string, instanceId: string, rows: number) =>
    regions.get(`${component}:${instanceId}`)?.scroll ?? {
      offset: 0,
      bodyRows: rows,
      contentRows: 0,
    };
  let renderReady = false;
  let disposed = false;
  let generation = 0;
  let refreshing: Promise<void> | null = null;
  let dirty = false;
  let starting: Promise<void> | null = null;
  let working = false;
  let columns = 100;
  const publish = (patch: Partial<ModUiState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    options.update(state);
  };
  const send: ModUiSend = (operation, payload = {}) =>
    options.send(operation, { ...payload, surface: options.surface });
  const render = async (component: string, instance_id: string, props: Record<string, unknown>) => {
    const response = await send("ui_render", { component, instance_id, props });
    return decodeRender(response);
  };
  const refresh = (invalidateSites = false): Promise<void> => {
    if (invalidateSites) for (const site of sites.values()) site.dirty = true;
    if (disposed || !state.supported || !renderReady) return Promise.resolve();
    dirty = true;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        while (dirty && !disposed && state.supported && renderReady) {
          dirty = false;
          const currentGeneration = generation;
          const [above, roster] = await Promise.all([
            render("AbovePrompt", "above-prompt", {
              hasSurvey: false,
              isWorking: working,
              maxRows: 12,
              bodyColumns: columns,
              scroll: layout("AbovePrompt", "above-prompt", 12),
              view: {},
            }),
            send("ui_panes"),
          ]);
          const rosterData = record(roster);
          const items = rosterData.panes;
          const shownId = text(rosterData.shown_id) || null;
          const focusedId = text(rosterData.focused_id) || null;
          const panes = await Promise.all(
            (Array.isArray(items) ? items : []).map(async (item) => {
              const pane = record(item);
              const id = text(pane.id);
              const title = text(pane.title) || id;
              const drawn =
                id === shownId
                  ? await render("Pane", id, {
                      id,
                      title,
                      isFocused: id === focusedId,
                      bodyColumns: columns,
                      placement: "inline",
                      scroll: layout("Pane", id, 24),
                    })
                  : null;
              return {
                id,
                title,
                plugin: text(pane.plugin),
                tree: drawn?.hooked ? drawn.tree : null,
                modules: drawn?.client_modules ?? {},
              };
            }),
          );
          if (disposed || currentGeneration !== generation) continue;
          const visible = [...sites.entries()].filter(([, site]) => site.dirty);
          for (let offset = 0; offset < visible.length; offset += 4) {
            await Promise.all(
              visible.slice(offset, offset + 4).map(async ([key, site]) => {
                site.dirty = false;
                const drawing = await render(site.component, site.instanceId, site.props);
                if (!disposed && currentGeneration === generation && sites.get(key) === site)
                  site.update(drawing);
              }),
            );
          }
          if (disposed || currentGeneration !== generation) continue;
          publish({
            above: above.hooked && above.tree.type !== "engine" ? above.tree : null,
            modules: above.client_modules ?? {},
            panes,
            shownId,
            focusedId,
            error: null,
          });
        }
      } catch (error) {
        publish({ error: error instanceof Error ? error.message : "Could not refresh mod UI." });
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };
  return {
    send,
    render,
    registerRegion(
      component: string,
      instanceId: string,
      receive: (event: ProviderModUiEvent) => void,
    ) {
      const key = `${component}:${instanceId}`;
      const region = { scroll: layout(component, instanceId, 12), receive };
      regions.set(key, region);
      return () => {
        if (regions.get(key) === region) regions.delete(key);
      };
    },
    setRegionLayout(
      component: string,
      instanceId: string,
      scroll: { offset: number; bodyRows: number; contentRows: number },
    ) {
      const region = regions.get(`${component}:${instanceId}`);
      if (region) region.scroll = scroll;
    },
    registerSite(
      component: string,
      instanceId: string,
      props: Record<string, unknown>,
      update: (drawing: typeof ProviderModUiRender.Type) => void,
    ) {
      const key = `${component}:${instanceId}`;
      const site = { component, instanceId, props, update, dirty: true };
      sites.set(key, site);
      void refresh();
      return () => {
        if (sites.get(key) === site) sites.delete(key);
      };
    },
    refresh,
    start() {
      if (starting) return starting;
      starting = (async () => {
        try {
          const currentGeneration = generation;
          const capabilities = record(await send("capabilities"));
          if (disposed || currentGeneration !== generation) return;
          if (capabilities.supported !== true) {
            publish(emptyModUiState);
            return;
          }
          await send("ui_attach", {
            viewport: { columns, rows: 40, isFullscreen: false },
            answers:
              capabilities.composer === true ? ["ui_copy", "ui_prompt_read", "ui_prompt_fill"] : [],
          });
          if (disposed || currentGeneration !== generation) {
            if (disposed) await send("ui_detach");
            return;
          }
          renderReady ||= capabilities.ready !== false;
          publish({ supported: true });
          await refresh(true);
        } catch (error) {
          publish({ error: error instanceof Error ? error.message : "Could not attach mod UI." });
        }
      })().finally(() => {
        starting = null;
      });
      return starting;
    },
    receive(event: ProviderModUiEvent) {
      if (disposed) return;
      if (event.subtype === "ui_scroll" || event.subtype === "ui_focus")
        regions
          .get(`${text(event.payload.component)}:${text(event.payload.instance_id)}`)
          ?.receive(event);
      if (event.subtype === "session_ready") {
        if (event.payload.modsReady === true) renderReady = true;
        if (state.supported && event.payload.reset !== true) void refresh(true);
        else {
          generation++;
          renderReady = false;
          publish(emptyModUiState);
          const pending = starting;
          if (pending)
            void pending.then(() => {
              if (!disposed) void this.start();
            });
          else void this.start();
        }
        return;
      }
      if (event.subtype === "session_unavailable") {
        generation++;
        renderReady = false;
        publish(emptyModUiState);
        return;
      }
      if (event.subtype === "host_request") {
        void options
          .hostRequest(text(event.payload.operation), event.payload)
          .then(
            (response) => send("host_reply", { requestId: event.payload.requestId, response }),
            () => send("host_reply", { requestId: event.payload.requestId, response: {} }),
          )
          .catch(() => {});
      } else if (
        event.subtype === "ui_invalidate" ||
        event.subtype === "ui_panes" ||
        event.subtype === "ui_scroll" ||
        event.subtype === "ui_focus"
      ) {
        void refresh(event.subtype === "ui_invalidate");
      } else if (event.subtype === "ui_status") {
        publish({
          statuses: { ...state.statuses, [text(event.payload.plugin)]: text(event.payload.text) },
        });
      } else if (event.subtype === "ui_log" || event.subtype === "ui_toast") {
        publish({
          notices: [
            ...state.notices,
            { plugin: text(event.payload.plugin), text: text(event.payload.text) },
          ].slice(-5),
        });
      }
    },
    async act(operation: ProviderModUiRequest["operation"], payload: Record<string, unknown>) {
      const result = await send(operation, payload);
      const key = `${text(payload.component)}:${text(payload.instance_id)}`;
      const site = sites.get(key);
      if (site) site.dirty = true;
      await refresh();
      return result;
    },
    setViewport(nextColumns: number, isWorking: boolean) {
      const next = Math.max(20, Math.round(nextColumns));
      if (columns === next && working === isWorking) return;
      columns = next;
      working = isWorking;
      void refresh();
    },
    dismissNotice(index: number) {
      publish({ notices: state.notices.filter((_, i) => i !== index) });
    },
    async close() {
      disposed = true;
      generation++;
      if (state.supported) await send("ui_detach").catch(() => {});
    },
  };
}

export { modUiToolProps, modUiResultText } from "./tool.ts";

export { modUiQuestions } from "./questions.ts";
