import * as Stream from "effect/Stream";
import { type ProviderModUiEvent, WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { Atom } from "effect/unstable/reactivity";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
export function createModUiEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    request: createEnvironmentRpcCommand(runtime, {
      label: "mod UI",
      tag: WS_METHODS.providerModUiRequest,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "mod UI events",
      tag: WS_METHODS.providerModUiSubscribe,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(
          Stream.scan([] as ReadonlyArray<ProviderModUiEvent>, (events, event) =>
            [...events, event].slice(-128),
          ),
        ),
    }),
  };
}
