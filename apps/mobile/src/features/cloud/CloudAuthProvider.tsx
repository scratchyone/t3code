import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { ManagedRelay, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { type ReactNode, useEffect, useState } from "react";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  getComposerCloudAccountId,
  restoreCloudComposerDrafts,
} from "../../state/use-composer-drafts";
import {
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
  unregisterAgentAwarenessDeviceForCurrentUser,
} from "../agent-awareness/remoteRegistration";
import { clearConnectOnboardingRequest, requestConnectOnboarding } from "./connectOnboarding";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "./publicConfig";
import { removeCloudEnvironments } from "./cloud-drafts";
import { createCloudAccountSync } from "./cloudAccountSync";

function resetManagedRelayTokenCache() {
  return settleAsyncResult(() =>
    runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
    ),
  );
}

export function deactivateCloudRelayAccount(): void {
  setAgentAwarenessRelayTokenProvider(null);
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateCloudRelayAccount(
  accountId: string,
  tokenProvider: () => Promise<string | null>,
): void {
  setAgentAwarenessRelayTokenProvider(tokenProvider, accountId);
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken: tokenProvider,
  });
}

function CloudAuthBridge(props: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const [accountSync] = useState(() =>
    createCloudAccountSync({
      removeRelayEnvironments: async (accountId) => {
        const removal = await runAtomCommand(appAtomRegistry, removeCloudEnvironments, accountId, {
          reportFailure: false,
          reportDefect: false,
        });
        if (removal._tag !== "Success") throw squashAtomCommandFailure(removal);
      },
      cleanUpCredentials: async (previousTokenProvider) => {
        const results = await Promise.all([
          resetManagedRelayTokenCache(),
          ...(previousTokenProvider
            ? [
                settleAsyncResult(() =>
                  runtime.runPromiseExit(
                    unregisterAgentAwarenessDeviceForCurrentUser(previousTokenProvider),
                  ),
                ),
              ]
            : []),
        ]);
        for (const result of results) {
          reportAtomCommandResult(result, { label: "cloud account cleanup" });
        }
      },
      getStoredAccountId: getComposerCloudAccountId,
      restoreDrafts: restoreCloudComposerDrafts,
      activate: activateCloudRelayAccount,
      deactivate: deactivateCloudRelayAccount,
      requestOnboarding: requestConnectOnboarding,
      clearOnboardingRequest: clearConnectOnboardingRequest,
      track: (label, work) => {
        void settlePromise(() => work).then((result) => {
          reportAtomCommandResult(result, { label });
        });
      },
    }),
  );

  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    accountSync.observe(
      isSignedIn && userId
        ? { accountId: userId, tokenProvider: () => getToken(resolveRelayClerkTokenOptions()) }
        : null,
    );
    return accountSync.cancel;
  }, [accountSync, getToken, isLoaded, isSignedIn, userId]);

  useEffect(
    () => () => {
      // Unmounting is not a sign-out: the user is usually still signed in, so
      // detach the provider without ending lock-screen activities or wiping the
      // persisted registration (a remount reuses both).
      releaseAgentAwarenessRelayTokenProvider();
      setManagedRelaySession(appAtomRegistry, null);
    },
    [],
  );

  return props.children;
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  const config = resolveCloudPublicConfig();
  const publishableKey = config.clerk.publishableKey;
  const relayUrl = config.relay.url;

  useEffect(() => {
    if (!publishableKey || !relayUrl) {
      deactivateCloudRelayAccount();
    }
  }, [publishableKey, relayUrl]);

  if (!publishableKey || !relayUrl) {
    return props.children;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <CloudAuthBridge>{props.children}</CloudAuthBridge>
    </ClerkProvider>
  );
}
