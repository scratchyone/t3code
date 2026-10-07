import {
  ProviderModUiError,
  type ProviderModUiRequest,
  type ProviderModUiSubscribe,
  type ProviderModUiEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";

export class ModUi extends Context.Service<
  ModUi,
  {
    readonly request: (input: ProviderModUiRequest) => Effect.Effect<unknown, ProviderModUiError>;
    readonly subscribe: (
      input: ProviderModUiSubscribe,
    ) => Stream.Stream<ProviderModUiEvent, ProviderModUiError>;
  }
>()("t3/provider/ModUi") {}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
  const load = (threadId: ProviderModUiRequest["threadId"]) =>
    Effect.gen(function* () {
      const records = yield* threads.getThreadRecords(threadId, ["providerThreads"]);
      const thread = records.providerThreads.find(
        (candidate) => candidate.id === records.thread.activeProviderThreadId,
      );
      const runtime = thread?.providerSessionId
        ? Option.getOrNull(yield* sessions.get(thread.providerSessionId))
        : null;
      return thread && runtime?.modUi ? { thread, ui: runtime.modUi } : null;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderModUiError({ threadId, detail: "Could not read this mod session.", cause }),
      ),
    );
  const request: ModUi["Service"]["request"] = Effect.fn("ModUi.request")(function* (input) {
    const target = yield* load(input.threadId);
    if (!target) {
      if (input.operation === "capabilities") return { supported: false };
      return yield* new ProviderModUiError({
        threadId: input.threadId,
        detail: "This thread has no active mod UI session.",
      });
    }
    return yield* target.ui.request(target.thread, input).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderModUiError({
            threadId: input.threadId,
            detail: "The mod UI request failed.",
            cause,
          }),
      ),
    );
  });
  return ModUi.of({
    request,
    subscribe: (input) => {
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(input.clientId))
        return Stream.fail(
          new ProviderModUiError({ threadId: input.threadId, detail: "Invalid mod UI client." }),
        );
      return Stream.merge(
        Stream.succeed(null),
        threads.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              "threadId" in event &&
              event.threadId === input.threadId &&
              [
                "provider-session.attached",
                "provider-session.updated",
                "provider-thread.updated",
                "thread.metadata.updated",
                "run.updated",
              ].includes(event.type),
          ),
          Stream.map(() => null),
          Stream.mapError(
            (cause) =>
              new ProviderModUiError({
                threadId: input.threadId,
                detail: "Mod session disconnected.",
                cause,
              }),
          ),
        ),
      ).pipe(
        Stream.mapEffect(() => load(input.threadId)),
        Stream.changesWith(
          (a, b) =>
            a?.thread.providerSessionId === b?.thread.providerSessionId &&
            a?.thread.nativeThreadRef?.nativeId === b?.thread.nativeThreadRef?.nativeId,
        ),
        Stream.switchMap((target) =>
          !target
            ? Stream.succeed({ subtype: "session_unavailable", payload: {} })
            : Stream.merge(
                Stream.succeed<ProviderModUiEvent>({
                  subtype: "session_ready",
                  payload: { reset: true },
                }),
                target.ui.events(target.thread),
              ).pipe(
                Stream.filter(
                  (event) => event.client_id === undefined || event.client_id === input.clientId,
                ),
                Stream.ensuring(
                  target.ui
                    .request(target.thread, { ...input, operation: "ui_detach", payload: {} })
                    .pipe(Effect.ignore),
                ),
              ),
        ),
      );
    },
  });
});
export const layer = Layer.effect(ModUi, make);
