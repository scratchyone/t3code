export type CloudTokenProvider = () => Promise<string | null>;

export interface CloudAccountSyncDependencies {
  /** Archives the account's drafts, then drops every relay environment. */
  readonly removeRelayEnvironments: (accountId: string | null) => Promise<void>;
  /** Clears relay tokens and the push registration of the previous account. */
  readonly cleanUpCredentials: (previousTokenProvider: CloudTokenProvider | null) => Promise<void>;
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
  /** Stops pending activations; the next `observe` starts a fresh generation. */
  readonly cancel: () => void;
  /** Settles once every queued cleanup and activation has finished. */
  readonly settled: () => Promise<void>;
}

/**
 * Moves relay credentials, connected cloud environments and composer drafts
 * from one Clerk account to the next. Only one account is active at a time:
 * every transition, whether through sign-out or a multi-session switch,
 * archives the previous account's drafts, removes its relay environments and
 * revokes its credentials before the next account is activated.
 */
export function createCloudAccountSync(deps: CloudAccountSyncDependencies): CloudAccountSync {
  let previousTokenProvider: CloudTokenProvider | null = null;
  // undefined until the first observation, so a cold start is not a transition.
  let observedAccount: string | null | undefined = undefined;
  let transition: Promise<void> | null = null;
  let generation = 0;

  const cleanUpAccount = async (
    previous: CloudTokenProvider | null,
    accountId: string | null,
  ): Promise<void> => {
    await deps.removeRelayEnvironments(accountId);
    await deps.cleanUpCredentials(previous);
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

      // Every sign-in or account switch completed during this app session asks
      // for the T3 Connect onboarding sheet: the transition removes the
      // previous account's environments, so the new account starts with no
      // devices to reach. A cold start observes undefined → account and must
      // not re-prompt. Sign-out drops any not-yet-presented request.
      const isAccountTransition =
        previousObservedAccount !== undefined && previousObservedAccount !== nextAccount;
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
          if (storedAccount !== null && storedAccount !== accountId) {
            await cleanUpAccount(null, storedAccount);
          }
          if (!isCurrent()) return;
          await deps.restoreDrafts(accountId);
          if (!isCurrent()) return;
          previousTokenProvider = tokenProvider;
          deps.activate(accountId, tokenProvider);
          if (isAccountTransition) {
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
