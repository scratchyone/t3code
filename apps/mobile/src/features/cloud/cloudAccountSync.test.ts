import { describe, expect, it } from "vite-plus/test";

import { type CloudTokenProvider, createCloudAccountSync } from "./cloudAccountSync";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

/** Lets queued promise continuations run without advancing any gated work. */
function drainMicrotasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function session(accountId: string) {
  const tokenProvider: CloudTokenProvider = async () => `${accountId}-token`;
  return { accountId, tokenProvider };
}

function harness(options: { readonly storedAccountId?: string | null } = {}) {
  const log: string[] = [];
  const failures: unknown[] = [];
  let storedAccountId = options.storedAccountId ?? null;
  let active: { readonly accountId: string; readonly token: Promise<string | null> } | null = null;
  const removalGates: Array<ReturnType<typeof deferred>> = [];

  const sync = createCloudAccountSync({
    removeRelayEnvironments: async (accountId) => {
      log.push(`remove:${accountId}`);
      const gate = removalGates.shift();
      if (gate) await gate.promise;
      storedAccountId = null;
    },
    cleanUpCredentials: async (previous) => {
      log.push(`cleanup:${previous ? await previous() : "none"}`);
    },
    getStoredAccountId: async () => storedAccountId,
    restoreDrafts: async (accountId) => {
      log.push(`restore:${accountId}`);
      storedAccountId = accountId;
    },
    activate: (accountId, tokenProvider) => {
      log.push(`activate:${accountId}`);
      active = { accountId, token: tokenProvider() };
    },
    deactivate: () => {
      log.push("deactivate");
      active = null;
    },
    requestOnboarding: (accountId) => log.push(`onboarding:${accountId}`),
    clearOnboardingRequest: () => log.push("clear-onboarding"),
    track: (_label, work) => {
      work.catch((error: unknown) => failures.push(error));
    },
  });

  return {
    sync,
    log,
    failures,
    active: () => active,
    holdNextRemoval: () => {
      const gate = deferred();
      removalGates.push(gate);
      return gate;
    },
  };
}

describe("createCloudAccountSync", () => {
  it("activates the signed-in account on a cold start without onboarding", async () => {
    const { sync, log, active } = harness();

    sync.observe(session("account-a"));
    await sync.settled();

    expect(log).toEqual(["restore:account-a", "activate:account-a"]);
    expect(await active()?.token).toBe("account-a-token");
  });

  it("revokes the previous account before activating a switched-to account", async () => {
    const { sync, log, active, holdNextRemoval } = harness();
    sync.observe(session("account-a"));
    await sync.settled();
    log.length = 0;

    const removal = holdNextRemoval();
    sync.observe(session("account-b"));
    await drainMicrotasks();

    // Nothing belonging to either account is reachable while A is cleaned up.
    expect(active()).toBeNull();
    expect(log).toEqual(["deactivate", "remove:account-a"]);

    removal.resolve();
    await sync.settled();

    expect(log).toEqual([
      "deactivate",
      "remove:account-a",
      "cleanup:account-a-token",
      "restore:account-b",
      "activate:account-b",
      "onboarding:account-b",
    ]);
    expect(await active()?.token).toBe("account-b-token");
  });

  it("round-trips drafts through A → B → A switches", async () => {
    const { sync, log } = harness();
    sync.observe(session("account-a"));
    await sync.settled();
    sync.observe(session("account-b"));
    await sync.settled();
    log.length = 0;

    sync.observe(session("account-a"));
    await sync.settled();

    expect(log).toEqual([
      "deactivate",
      "remove:account-b",
      "cleanup:account-b-token",
      "restore:account-a",
      "activate:account-a",
      "onboarding:account-a",
    ]);
  });

  it("only activates the last account when switches outpace cleanup", async () => {
    const { sync, log, active, holdNextRemoval } = harness();
    sync.observe(session("account-a"));
    await sync.settled();
    log.length = 0;

    const removal = holdNextRemoval();
    sync.observe(session("account-b"));
    sync.observe(session("account-c"));
    removal.resolve();
    await sync.settled();

    expect(log.filter((entry) => entry.startsWith("activate:"))).toEqual(["activate:account-c"]);
    expect(log).not.toContain("restore:account-b");
    expect(log).toContain("remove:account-a");
    expect(active()?.accountId).toBe("account-c");
  });

  it("falls through to a remaining session after signing out of the active one", async () => {
    const { sync, log, active } = harness();
    sync.observe(session("account-a"));
    await sync.settled();
    log.length = 0;

    // Clerk briefly reports signed-out before activating the remaining session.
    sync.observe(null);
    sync.observe(session("account-b"));
    await sync.settled();

    expect(log).toEqual([
      "clear-onboarding",
      "deactivate",
      "remove:account-a",
      "cleanup:account-a-token",
      "restore:account-b",
      "activate:account-b",
      "onboarding:account-b",
    ]);
    expect(active()?.accountId).toBe("account-b");
  });

  it("archives drafts left by another account before restoring on a cold start", async () => {
    const { sync, log } = harness({ storedAccountId: "account-a" });

    sync.observe(session("account-b"));
    await sync.settled();

    expect(log).toEqual([
      "remove:account-a",
      "cleanup:none",
      "restore:account-b",
      "activate:account-b",
    ]);
  });

  it("keeps the next account inactive when the previous account's cleanup fails", async () => {
    const failures: unknown[] = [];
    const log: string[] = [];
    const sync = createCloudAccountSync({
      removeRelayEnvironments: async (accountId) => {
        if (accountId === "account-a") throw new Error("archive failed");
      },
      cleanUpCredentials: async () => {},
      getStoredAccountId: async () => null,
      restoreDrafts: async () => {},
      activate: (accountId) => log.push(`activate:${accountId}`),
      deactivate: () => log.push("deactivate"),
      requestOnboarding: () => {},
      clearOnboardingRequest: () => {},
      track: (_label, work) => {
        work.catch((error: unknown) => failures.push(error));
      },
    });
    sync.observe(session("account-a"));
    await sync.settled();

    sync.observe(session("account-b"));
    await sync.settled();

    expect(log).toEqual(["activate:account-a", "deactivate"]);
    expect(failures).toHaveLength(1);
  });

  it("drops pending activations once cancelled", async () => {
    const { sync, log, holdNextRemoval } = harness();
    sync.observe(session("account-a"));
    await sync.settled();
    log.length = 0;

    const removal = holdNextRemoval();
    sync.observe(session("account-b"));
    sync.cancel();
    removal.resolve();
    await sync.settled();

    expect(log).not.toContain("activate:account-b");
  });
});
