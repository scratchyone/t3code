import {
  EnvironmentRegistry,
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "../../connection/runtime";
import type { SavedCloudEnvironment } from "../../persistence/mobile-preferences";
import { archiveCloudComposerDrafts } from "../../state/use-composer-drafts";

export class CloudDraftArchiveError extends Schema.TaggedError<CloudDraftArchiveError>()(
  "CloudDraftArchiveError",
  {
    environmentCount: Schema.Number,
    hasAccountId: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not preserve local drafts for ${this.environmentCount} cloud environments before sign-out.`;
  }
}

const relayEntries = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry;
  const entries = yield* SubscriptionRef.get(registry.entries);
  return [...entries.values()].filter((entry) => entry.target._tag === "RelayConnectionTarget");
});

/** The relay environments currently registered, in the shape saved per account. */
export const listCloudEnvironments = createRuntimeCommand(connectionAtomRuntime, {
  label: "cloud:list-environments",
  execute: Effect.fn("listCloudEnvironments")(function* () {
    const entries = yield* relayEntries;
    return entries.map((entry): SavedCloudEnvironment => ({
      environmentId: entry.target.environmentId,
      label: entry.target.label,
      enabled: entry.enabled,
    }));
  }),
});

export const removeCloudEnvironments = createRuntimeCommand(connectionAtomRuntime, {
  label: "cloud:preserve-drafts-and-remove-environments",
  execute: Effect.fn("removeCloudEnvironments")(function* (accountId: string | null) {
    const registry = yield* EnvironmentRegistry;
    const environmentIds = new Set(
      (yield* relayEntries).map((entry) => entry.target.environmentId),
    );
    // Credentials are already revoked. A failed backup must leave the local
    // owners intact so a later sign-in can retry without losing their files.
    yield* Effect.tryPromise({
      try: () => archiveCloudComposerDrafts(accountId, environmentIds),
      catch: (cause) =>
        new CloudDraftArchiveError({
          environmentCount: environmentIds.size,
          hasAccountId: accountId !== null,
          cause,
        }),
    });
    yield* registry.removeRelayEnvironments();
  }),
});

/** Reconnects the relay environments an account had when it was switched away from. */
export const restoreCloudEnvironments = createRuntimeCommand(connectionAtomRuntime, {
  label: "cloud:restore-environments",
  execute: Effect.fn("restoreCloudEnvironments")(function* (
    environments: ReadonlyArray<SavedCloudEnvironment>,
  ) {
    const registry = yield* EnvironmentRegistry;
    yield* Effect.forEach(
      environments,
      (environment) =>
        Effect.gen(function* () {
          const environmentId = EnvironmentId.make(environment.environmentId);
          yield* registry.register(
            new RelayConnectionRegistration({
              target: new RelayConnectionTarget({ environmentId, label: environment.label }),
            }),
          );
          if (!environment.enabled) {
            yield* registry.setEnabled(environmentId, false);
          }
        }),
      { discard: true },
    );
  }),
});
