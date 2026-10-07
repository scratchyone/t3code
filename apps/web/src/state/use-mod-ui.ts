import { useEffect, useRef, useState } from "react";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import {
  createModUiController,
  emptyModUiState,
  type ModUiState,
} from "@t3tools/client-runtime/mod-ui";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { modUiEnvironment } from "./modUi";
import { useAtomCommand } from "./use-atom-command";
import { useEnvironmentQuery } from "./query";

export function useModUi(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  hostRequest: (operation: string, payload: Record<string, unknown>) => Promise<unknown>,
) {
  const request = useAtomCommand(modUiEnvironment.request, { reportFailure: false });
  const callback = useRef(hostRequest);
  callback.current = hostRequest;
  const [state, setState] = useState<ModUiState>(emptyModUiState);
  const [session, setSession] = useState<{
    clientId: string;
    controller: ReturnType<typeof createModUiController>;
  } | null>(null);
  useEffect(() => {
    const clientId = `t3-web-${Math.random().toString(36).slice(2)}`;
    const controller = createModUiController({
      surface: "desktop",
      update: setState,
      hostRequest: (operation, payload) => callback.current(operation, payload),
      send: async (operation, payload = {}) => {
        const result = await request({
          environmentId,
          input: { threadId, clientId, operation, payload },
        });
        if (AsyncResult.isSuccess(result)) return result.value;
        if (AsyncResult.isFailure(result)) throw Cause.squash(result.cause);
        throw new Error("Mod UI disconnected.");
      },
    });
    setState(emptyModUiState);
    setSession({ clientId, controller });
    return () => {
      void controller.close();
    };
  }, [environmentId, threadId, request]);
  const event = useEnvironmentQuery(
    session
      ? modUiEnvironment.events({ environmentId, input: { threadId, clientId: session.clientId } })
      : null,
  );
  const received = useRef(new WeakSet<object>());
  useEffect(() => {
    for (const item of event.data ?? []) {
      if (received.current.has(item)) continue;
      received.current.add(item);
      session?.controller.receive(item);
    }
  }, [session, event.data, event.dataUpdatedAt]);
  const controller = session?.controller ?? null;
  return { state, controller };
}
