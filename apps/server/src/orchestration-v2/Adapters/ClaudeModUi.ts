import * as Effect from "effect/Effect";
import type { ProviderModUiEvent, ProviderModUiRequest } from "@t3tools/contracts";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The CLI advertises this protocol before the SDK publishes its UI types. */
export function createClaudeModUi(query: unknown, emit: (event: ProviderModUiEvent) => void) {
  const sdk = object(query);
  const pending = new Map<
    string,
    { clientId: string; resolve: (value: unknown) => void; timer: AbortController }
  >();
  const clients = new Set<string>();
  let sequence = 0;
  let closed = false;
  let ready = false;
  const send = async (payload: Record<string, unknown>) => {
    if (closed || typeof sdk.request !== "function")
      throw new Error("Claude mod UI is unavailable.");
    const reply: unknown = await sdk.request.call(query, payload);
    return object(reply).response;
  };
  const hostRequest = (subtype: string, payload: unknown, context: { signal?: AbortSignal }) =>
    new Promise<unknown>((resolve) => {
      const body = object(payload);
      const clientId = typeof body.client_id === "string" ? body.client_id : "";
      if (!clients.has(clientId)) {
        resolve({});
        return;
      }
      const requestId = `mod-host-${++sequence}`;
      const finish = (value: unknown) => {
        const entry = pending.get(requestId);
        if (!entry) return;
        entry.timer.abort();
        pending.delete(requestId);
        context.signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => finish({});
      const timer = new AbortController();
      void Effect.runPromise(
        Effect.sleep(5_000).pipe(Effect.andThen(Effect.sync(() => finish({})))),
        { signal: timer.signal },
      ).catch(() => {});
      pending.set(requestId, { clientId, resolve: finish, timer });
      context.signal?.addEventListener("abort", abort, { once: true });
      if (context.signal?.aborted) {
        abort();
        return;
      }
      emit({
        subtype: "host_request",
        client_id: clientId,
        payload: { ...body, requestId, operation: subtype },
      });
    });
  if (typeof sdk.setUiHost === "function")
    sdk.setUiHost.call(query, {
      copy: (payload: unknown, context: { signal?: AbortSignal }) =>
        hostRequest("ui_copy", payload, context),
      promptRead: (payload: unknown, context: { signal?: AbortSignal }) =>
        hostRequest("ui_prompt_read", payload, context),
      promptFill: (payload: unknown, context: { signal?: AbortSignal }) =>
        hostRequest("ui_prompt_fill", payload, context),
      promptSuggest: (payload: unknown, context: { signal?: AbortSignal }) =>
        hostRequest("ui_prompt_suggest", payload, context),
    });
  return {
    async request(input: ProviderModUiRequest): Promise<unknown> {
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(input.clientId)) throw new Error("Invalid mod UI client.");
      if (JSON.stringify(input.payload).length > 9 * 1024 * 1024)
        throw new Error("Mod UI request is too large.");
      if (input.operation === "capabilities") {
        if (typeof sdk.initializationResult !== "function") return { supported: false };
        const initialization: unknown = await sdk.initializationResult.call(query);
        const capabilities = object(initialization).capabilities;
        return {
          supported: Array.isArray(capabilities) && capabilities.includes("ui_surface_v1"),
          composer: typeof sdk.setUiHost === "function",
          ready,
        };
      }
      if (input.operation === "host_reply") {
        const entry = pending.get(String(input.payload.requestId));
        if (entry?.clientId === input.clientId) entry.resolve(input.payload.response);
        return {};
      }
      // Client identity belongs to this connection, never a plugin or nested payload.
      const payload = { ...input.payload, subtype: input.operation, client_id: input.clientId };
      if (input.operation === "ui_attach") clients.add(input.clientId);
      try {
        return await send(payload);
      } catch (error) {
        if (input.operation === "ui_attach") clients.delete(input.clientId);
        throw error;
      } finally {
        if (input.operation === "ui_detach") {
          clients.delete(input.clientId);
          for (const entry of pending.values())
            if (entry.clientId === input.clientId) entry.resolve({});
        }
      }
    },
    receive(message: unknown) {
      const value = object(message);
      if (value.type === "result" || (value.type === "system" && value.subtype === "init")) {
        ready = true;
        emit({ subtype: "session_ready", payload: { modsReady: true } });
        return;
      }
      if (
        value.type !== "system" ||
        typeof value.subtype !== "string" ||
        !value.subtype.startsWith("ui_")
      )
        return;
      const { type: _type, subtype, uuid: _uuid, session_id: _session, ...payload } = value;
      if (JSON.stringify(payload).length > 1024 * 1024) return;
      emit({
        subtype,
        ...(typeof payload.client_id === "string" ? { client_id: payload.client_id } : {}),
        payload,
      });
    },
    close() {
      closed = true;
      for (const entry of pending.values()) entry.resolve({});
      clients.clear();
    },
  };
}
