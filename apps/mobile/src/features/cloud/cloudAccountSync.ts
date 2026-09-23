import type { SavedCloudEnvironment } from "../../persistence/mobile-preferences";

export type CloudTokenProvider = () => Promise<string | null>;

export interface CloudAccountSyncDependencies {
  /** Archives the account's drafts, drops every relay environment and returns what it dropped. */
  readonly removeRelayEnvironments: (
    accountId: string | null,
  ) => Promise<ReadonlyArray<SavedCloudEnvironment>>;
  /** Clears relay tokens and the push registration of the previous account. */
  readonly cleanUpCredentials: (previousTokenProvider: CloudTokenProvider | null) => Promise<void>;
  /** Null when the account was never switched away from on this device. */
  readonly loadSavedEnvironments: (
    accountId: string,
  ) => Promise<ReadonlyArray<SavedCloudEnvironment> | null>;
  readonly saveEnvironments: (
    accountId: string,
    environments: ReadonlyArray<SavedCloudEnvironment>,
  ) => Promise<void>;
  /** Forgets saved environments of every account not in the set. */
  readonly pruneSavedEnvironments: (signedInAccountIds: ReadonlySet<string>) => Promise<void>;
  readonly restoreEnvironments: (
    environments: ReadonlyArray<SavedCloudEnvironment>,
  ) => Promise<void>;
  readonly getStoredAccountId: () => Promise<string | null>;
  readonly restoreDrafts: (accountId: string) => Promise<void>;
  readonly activate: (accountId: string, tokenProvider: CloudTokenProvider) => void;
  readonly deactivate: () => void;
  readonly requestOnboarding: (accountId: string) => void;
  readonly clearOnboardingRequest: () => void;
  /** Receives background work so its failures can be reported. */
  readonly track: (label: string, work: Promise<void>) => void;
}

export interface CloudAccountSync {
  /**
   * Feeds the current Clerk session. Call on every change of the active
   * session, including a direct switch between two signed-in accounts.
   */
  readonly observe: (
    session: { readonly accountId: string; readonly tokenProvider: CloudTokenProvider } | null,
  ) => void;
  /** Records every account with a live Clerk session on this device, including the active one. */
  readonly setSignedInAccounts: (accountIds: ReadonlySet<string>) => void;
  /** Stops pending activations; the next `observe` starts a fresh generation. */
  readonly cancel: () => void;
  /** Settles once every queued cleanup and activation has finished. */
  readonly settled: () => Promise<void>;
}

/**
 * Moves relay credentials, connected cloud environments and composer drafts
 * from one Clerk account to the next. Only one account is active at a time:
 * every transition archives the previous account's drafts, removes its relay
 * environments and revokes its credentials before the next account is
 * activated. While an account stays signed in, its removed environments are
 * saved and reconnected when the user switches back; sign-out forgets them.
 */
export function createCloudAccountSync(deps: CloudAccountSyncDependencies): CloudAccountSync {
  let previousTokenProvider: CloudTokenProvider | null = null;
  // undefined until the first observation, so a cold start is not a transition.
  let observedAccount: string | null | undefined = undefined;
  let transition: Promise<void> | null = null;
  let generation = 0;
  let signedInAccounts: ReadonlySet<string> = new Set();
  // Drafts keep their owner through removal so a crashed cleanup is retried
  // on the next cold start. Remember what this process already finished, or
  // the retry would run again and save the account's environments as empty.
  let cleanedAccount: string | null = null;
  // Clerk can report the same session again before its activation finishes,
  // which cancels it. The switch stays pending until an activation completes.
  let pendingSwitchTo: string | null = null;

  const cleanUpAccount = async (
    previous: CloudTokenProvider | null,
    accountId: string | null,
  ): Promise<void> => {
    cleanedAccount = null;
    const removed = await deps.removeRelayEnvironments(accountId);
    // Signing out of the active account while another stays signed in
    // reaches us as a switch, so ask Clerk rather than trusting the transition.
    const signedIn = signedInAccounts;
    if (accountId !== null && signedIn.has(accountId)) {
      await deps.saveEnvironments(accountId, removed);
    }
    await deps.pruneSavedEnvironments(signedIn);
    await deps.cleanUpCredentials(previous);
    cleanedAccount = accountId;
  };

  const queueAccountCleanup = (previous: CloudTokenProvider | null, accountId: string | null) => {
    transition = (transition ?? Promise.resolve())
      .catch(() => {})
      .then(() => cleanUpAccount(previous, accountId));
    return transition;
  };

  return {
    observe(session) {
      const current = ++generation;
      const isCurrent = () => current === generation;
      const previousObservedAccount = observedAccount;
      const nextAccount = session?.accountId ?? null;
      observedAccount = nextAccount;

      // A cold start observes undefined → account and is not a transition:
      // the registry still holds that account's environments.
      const isAccountTransition =
        (previousObservedAccount !== undefined && previousObservedAccount !== nextAccount) ||
        (nextAccount !== null && pendingSwitchTo === nextAccount);
      pendingSwitchTo = isAccountTransition ? nextAccount : null;
      if (isAccountTransition && nextAccount === null) {
        deps.clearOnboardingRequest();
      }

      const previous = previousTokenProvider;
      if (session === null) {
        previousTokenProvider = null;
        deps.deactivate();
        if (previousObservedAccount !== null) {
          deps.track(
            "cloud account cleanup",
            queueAccountCleanup(previous, previousObservedAccount ?? null),
          );
        }
        return;
      }

      const { accountId, tokenProvider } = session;
      const activateAfter = (pending: Promise<void>) => {
        const activation = (async () => {
          await pending;
          if (!isCurrent()) return;
          // Drafts on disk may belong to an account that was switched away
          // from while the app was closed. Archive them before restoring.
          const storedAccount = await deps.getStoredAccountId();
          const switchedWhileClosed =
            storedAccount !== null &&
            storedAccount !== accountId &&
            storedAccount !== cleanedAccount;
          if (switchedWhileClosed) {
            await cleanUpAccount(null, storedAccount);
          }
          if (!isCurrent()) return;
          await deps.restoreDrafts(accountId);
          if (!isCurrent()) return;
          const saved =
            isAccountTransition || switchedWhileClosed
              ? await deps.loadSavedEnvironments(accountId)
              : null;
          if (!isCurrent()) return;
          previousTokenProvider = tokenProvider;
          deps.activate(accountId, tokenProvider);
          pendingSwitchTo = null;
          if (saved !== null) {
            await deps.restoreEnvironments(saved);
          } else if (isAccountTransition) {
            // Only an account this device has never switched away from gets
            // the T3 Connect onboarding sheet.
            deps.requestOnboarding(accountId);
          }
        })();
        transition = activation;
        deps.track("cloud account activation", activation);
      };

      if (
        previousObservedAccount !== undefined &&
        previousObservedAccount !== null &&
        previousObservedAccount !== accountId
      ) {
        // Direct switch between signed-in accounts: revoke the previous
        // account before the next one can read any relay state.
        previousTokenProvider = null;
        deps.deactivate();
        activateAfter(queueAccountCleanup(previous, previousObservedAccount));
      } else {
        // A failed disk write can be retried. The stored account check above
        // still requires cleanup before activating a different account.
        activateAfter((transition ?? Promise.resolve()).catch(() => {}));
      }
    },
    setSignedInAccounts(accountIds) {
      signedInAccounts = accountIds;
    },
    cancel() {
      generation++;
    },
    async settled() {
      let seen: Promise<void> | null = null;
      while (transition !== seen) {
        seen = transition;
        await seen?.catch(() => {});
      }
    },
  };
}
