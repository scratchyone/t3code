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
 * from one Clerk account to the next. Only one account is installed at a time:
 * every transition archives the installed account's drafts, removes its relay
 * environments and revokes its credentials before the next account is
 * installed. While an account stays signed in, its removed environments are
 * saved and reconnected when the user switches back; sign-out forgets them.
 */
export function createCloudAccountSync(deps: CloudAccountSyncDependencies): CloudAccountSync {
  // undefined until the first observation, so a cold start is not a transition.
  let observedAccount: string | null | undefined = undefined;
  // The account whose drafts and environments are on this device, with its
  // token reader once it went live. Undefined until read from the drafts'
  // owner, which survives a crashed or failed cleanup so it can be retried.
  let installed:
    | { readonly accountId: string; readonly tokenProvider: CloudTokenProvider | null }
    | null
    | undefined = undefined;
  // An account installed with nothing saved onboards once it goes live,
  // unless no account change has happened yet: a cold start never onboards.
  let onboardingFor: string | null = null;
  let hasChangedAccount = false;
  let transition: Promise<void> | null = null;
  let generation = 0;
  let signedInAccounts: ReadonlySet<string> = new Set();

  const enqueue = (work: () => Promise<void>) => {
    transition = (transition ?? Promise.resolve()).catch(() => {}).then(work);
    return transition;
  };

  const resolveInstalled = async () => {
    if (installed === undefined) {
      const stored = await deps.getStoredAccountId();
      installed = stored === null ? null : { accountId: stored, tokenProvider: null };
    }
    return installed;
  };

  /** Removes the installed account. A failure leaves it installed for the next attempt. */
  const uninstall = async (signedIn: ReadonlySet<string>): Promise<void> => {
    const account = await resolveInstalled();
    if (account === null) return;
    // Save before removing so a crash in between loses nothing. A list saved
    // by an interrupted cleanup or restore is complete; the registry may not be.
    if (
      signedIn.has(account.accountId) &&
      (await deps.loadSavedEnvironments(account.accountId)) === null
    ) {
      await deps.saveEnvironments(account.accountId, await deps.listRelayEnvironments());
    }
    await deps.removeRelayEnvironments(account.accountId);
    await deps.pruneSavedEnvironments(signedIn);
    await deps.cleanUpCredentials(account.tokenProvider);
    installed = null;
  };

  return {
    observe(session) {
      const current = ++generation;
      const isCurrent = () => current === generation;
      const previousObservedAccount = observedAccount;
      const nextAccount = session?.accountId ?? null;
      observedAccount = nextAccount;
      // Signing out of the active account while another stays signed in
      // reaches us as a switch, so ask Clerk rather than trusting the
      // transition. Read it now: a quick sign-in again must not undo a sign-out.
      const signedIn = signedInAccounts;

      // A cold start observes undefined → account and is not a transition:
      // the registry still holds that account's environments.
      const isAccountTransition =
        previousObservedAccount !== undefined && previousObservedAccount !== nextAccount;
      if (isAccountTransition) {
        hasChangedAccount = true;
        // A request made for the previous account must not open over the next.
        deps.clearOnboardingRequest();
      }
      if (
        session === null ||
        (previousObservedAccount != null && previousObservedAccount !== nextAccount)
      ) {
        // Revoke the previous account before the next one can read relay state.
        deps.deactivate();
      }
      if (session === null) {
        deps.track(
          "cloud account cleanup",
          enqueue(() => uninstall(signedIn)),
        );
        return;
      }

      const { accountId, tokenProvider } = session;
      const activation = enqueue(async () => {
        if (!isCurrent()) return;
        const account = await resolveInstalled();
        if (account !== null && account.accountId !== accountId) {
          await uninstall(signedIn);
          if (!isCurrent()) return;
        }
        const newlyInstalled = installed === null;
        if (newlyInstalled) installed = { accountId, tokenProvider: null };
        // Once drafts come back the account is installed, even if a newer
        // switch arrives: the next cleanup must find all of it to archive.
        await deps.restoreDrafts(accountId);
        // A saved list is deleted once restored, so one left over for the
        // installed account means a restore was interrupted.
        const saved = await deps.loadSavedEnvironments(accountId);
        if (saved !== null) {
          await deps.restoreEnvironments(saved);
          await deps.forgetSavedEnvironments(accountId);
        }
        if (newlyInstalled) {
          onboardingFor = saved === null && hasChangedAccount ? accountId : null;
        }
        if (!isCurrent()) return;
        installed = { accountId, tokenProvider };
        deps.activate(accountId, tokenProvider);
        if (onboardingFor === accountId) {
          onboardingFor = null;
          deps.requestOnboarding(accountId);
        }
      });
      deps.track("cloud account activation", activation);
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
