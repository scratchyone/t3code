import type { SavedCloudEnvironment } from "../../persistence/mobile-preferences";

export type CloudTokenProvider = () => Promise<string | null>;

export interface CloudAccountSyncDependencies {
  readonly listRelayEnvironments: () => Promise<ReadonlyArray<SavedCloudEnvironment>>;
  /** Archives the account's drafts and drops every relay environment. */
  readonly removeRelayEnvironments: (accountId: string | null) => Promise<void>;
  /** Clears relay tokens and the push registration of the previous account. */
  readonly cleanUpCredentials: (previousTokenProvider: CloudTokenProvider | null) => Promise<void>;
  /** Null unless the account was switched away from and not yet restored. */
  readonly loadSavedEnvironments: (
    accountId: string,
  ) => Promise<ReadonlyArray<SavedCloudEnvironment> | null>;
  readonly saveEnvironments: (
    accountId: string,
    environments: ReadonlyArray<SavedCloudEnvironment>,
  ) => Promise<void>;
  readonly forgetSavedEnvironments: (accountId: string) => Promise<void>;
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
  // on the next cold start. Skip the retry for what this process finished.
  let cleanedAccount: string | null = null;
  // Clerk can report the same session again before its activation finishes,
  // which cancels it. The switch stays pending until an activation completes.
  let pendingSwitchTo: string | null = null;

  const cleanUpAccount = async (
    previous: CloudTokenProvider | null,
    accountId: string | null,
  ): Promise<void> => {
    cleanedAccount = null;
    // Save before removing so a crash in between loses nothing. Cleanup can
    // run again for the same account (a retry, or an account that never
    // finished activating), so an empty registry keeps the saved list.
    const environments = await deps.listRelayEnvironments();
    // Signing out of the active account while another stays signed in
    // reaches us as a switch, so ask Clerk rather than trusting the transition.
    const signedIn = signedInAccounts;
    if (accountId !== null && signedIn.has(accountId) && environments.length > 0) {
      await deps.saveEnvironments(accountId, environments);
    }
    await deps.removeRelayEnvironments(accountId);
    await deps.pruneSavedEnvironments(signedIn);
    await deps.cleanUpCredentials(previous);
    cleanedAccount = accountId;
  };

  const enqueue = (work: () => Promise<void>) => {
    transition = (transition ?? Promise.resolve()).catch(() => {}).then(work);
    return transition;
  };
  const queueAccountCleanup = (previous: CloudTokenProvider | null, accountId: string | null) =>
    enqueue(() => cleanUpAccount(previous, accountId));

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
          if (
            storedAccount !== null &&
            storedAccount !== accountId &&
            storedAccount !== cleanedAccount
          ) {
            await cleanUpAccount(null, storedAccount);
          }
          if (!isCurrent()) return;
          // Once drafts come back the account is installed, even if a newer
          // switch arrives: the next cleanup must find all of it to archive.
          await deps.restoreDrafts(accountId);
          // A saved list is deleted once restored, so one left over for the
          // active account means a restore was interrupted.
          const saved = await deps.loadSavedEnvironments(accountId);
          if (saved !== null) {
            await deps.restoreEnvironments(saved);
            await deps.forgetSavedEnvironments(accountId);
          }
          if (!isCurrent()) return;
          previousTokenProvider = tokenProvider;
          deps.activate(accountId, tokenProvider);
          pendingSwitchTo = null;
          if (saved === null && isAccountTransition) {
            // Only an account with nothing saved on this device gets the T3
            // Connect onboarding sheet.
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
      // Signing out of an inactive account forgets it without a transition.
      deps.track(
        "cloud account prune",
        enqueue(() => deps.pruneSavedEnvironments(accountIds)),
      );
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
