import { describe, expect, it } from "vite-plus/test";

import type { SavedCloudEnvironment } from "../../persistence/mobile-preferences";
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
  // Relay environments currently in the registry, and each account's saved set.
  let connected: SavedCloudEnvironment[] = [];
  const saved = new Map<string, ReadonlyArray<SavedCloudEnvironment>>();

  const sync = createCloudAccountSync({
    removeRelayEnvironments: async (accountId) => {
      log.push(`remove:${accountId}`);
      const gate = removalGates.shift();
      if (gate) await gate.promise;
      // Like the real draft archive, the stored owner survives removal so a
      // crashed cleanup can be retried on the next cold start.
      const removed = connected;
      connected = [];
      return removed;
    },
    cleanUpCredentials: async (previous) => {
      log.push(`cleanup:${previous ? await previous() : "none"}`);
    },
    loadSavedEnvironments: async (accountId) => saved.get(accountId) ?? null,
    saveEnvironments: async (accountId, environments) => {
      log.push(`save:${accountId}:${environments.map((env) => env.environmentId).join(",")}`);
      saved.set(accountId, environments);
    },
    pruneSavedEnvironments: async (keep) => {
      for (const accountId of saved.keys()) {
        if (!keep.has(accountId)) saved.delete(accountId);
      }
    },
    restoreEnvironments: async (environments) => {
      log.push(`reconnect:${environments.map((env) => env.environmentId).join(",")}`);
      connected = [...environments];
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
    saved,
    active: () => active,
    /** Sets which accounts Clerk reports as signed in. */
    signIn: (...accountIds: string[]) => {
      sync.setSignedInAccounts(new Set(accountIds));
    },
    /** Connects a relay environment for the active account. */
    connect: (environmentId: string, enabled = true) => {
      connected.push({ environmentId, label: environmentId, enabled });
    },
    connected: () => connected.map((env) => env.environmentId),
    holdNextRemoval: () => {
      const gate = deferred();
      removalGates.push(gate);
      return gate;
    },
  };
}

describe("createCloudAccountSync", () => {
  it("activates the signed-in account on a cold start without onboarding", async () => {
    const { sync, log, active, signIn } = harness();
    signIn("account-a");

    sync.observe(session("account-a"));
    await sync.settled();

    expect(log).toEqual(["restore:account-a", "activate:account-a"]);
    expect(await active()?.token).toBe("account-a-token");
  });

  it("revokes the previous account before activating a switched-to account", async () => {
    const { sync, log, active, signIn, connect, holdNextRemoval } = harness();
    signIn("account-a");
    sync.observe(session("account-a"));
    await sync.settled();
    connect("env-a1");
    log.length = 0;

    const removal = holdNextRemoval();
    signIn("account-a", "account-b");
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
      "save:account-a:env-a1",
      "cleanup:account-a-token",
      "restore:account-b",
      "activate:account-b",
      "onboarding:account-b",
    ]);
    expect(await active()?.token).toBe("account-b-token");
  });

  it("reconnects saved environments without onboarding when switching back", async () => {
    const { sync, log, signIn, connect, connected } = harness();
    signIn("account-a", "account-b");
    sync.observe(session("account-a"));
    await sync.settled();
    connect("env-a1");
    connect("env-a2", false);
    sync.observe(session("account-b"));
    await sync.settled();
    connect("env-b1");
    log.length = 0;

    sync.observe(session("account-a"));
    await sync.settled();

    expect(log).toEqual([
      "deactivate",
      "remove:account-b",
      "save:account-b:env-b1",
      "cleanup:account-b-token",
      "restore:account-a",
      "activate:account-a",
      "reconnect:env-a1,env-a2",
    ]);
    expect(connected()).toEqual(["env-a1", "env-a2"]);

    log.length = 0;
    sync.observe(session("account-b"));
    await sync.settled();
    expect(log).toContain("reconnect:env-b1");
    expect(log).not.toContain("onboarding:account-b");
  });

  it("reconnects saved environments when Clerk repeats the session mid-switch", async () => {
    const { sync, log, signIn, connect, connected, holdNextRemoval } = harness();
    signIn("account-a", "account-b");
    sync.observe(session("account-a"));
    await sync.settled();
    connect("env-a1");
    sync.observe(session("account-b"));
    await sync.settled();
    connect("env-b1");
    sync.observe(session("account-a"));
    await sync.settled();
    log.length = 0;

    // Signing out of account-a reports account-b twice before cleanup ends.
    signIn("account-b");
    const removal = holdNextRemoval();
    sync.observe(session("account-b"));
    sync.observe(session("account-b"));
    removal.resolve();
    await sync.settled();

    expect(log).toContain("reconnect:env-b1");
    expect(log).not.toContain("onboarding:account-b");
    expect(connected()).toEqual(["env-b1"]);
  });

  it("only activates the last account when switches outpace cleanup", async () => {
    const { sync, log, active, signIn, holdNextRemoval } = harness();
    signIn("account-a", "account-b", "account-c");
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

  it("forgets saved environments on sign-out so the next sign-in onboards", async () => {
    const { sync, log, saved, signIn, connect } = harness();
    signIn("account-a", "account-b");
    sync.observe(session("account-a"));
    await sync.settled();
    connect("env-a1");
    sync.observe(session("account-b"));
    await sync.settled();
    expect([...saved.keys()]).toEqual(["account-a"]);

    signIn();
    sync.observe(null);
    await sync.settled();
    expect(saved.size).toBe(0);

    log.length = 0;
    signIn("account-a");
    sync.observe(session("account-a"));
    await sync.settled();
    expect(log).toEqual(["restore:account-a", "activate:account-a", "onboarding:account-a"]);
  });

  it("does not save the environments of an account signed out while another remains", async () => {
    const { sync, log, saved, active, signIn, connect } = harness();
    signIn("account-a", "account-b");
    sync.observe(session("account-a"));
    await sync.settled();
    connect("env-a1");
    log.length = 0;

    // Clerk briefly reports signed-out before activating the remaining session.
    signIn("account-b");
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
    expect(saved.has("account-a")).toBe(false);
    expect(active()?.accountId).toBe("account-b");
  });

  it("saves and restores across a switch made while the app was closed", async () => {
    const { sync, log, signIn } = harness({ storedAccountId: "account-a" });
    signIn("account-a", "account-b");

    sync.observe(session("account-b"));
    await sync.settled();

    expect(log).toEqual([
      "remove:account-a",
      "save:account-a:",
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
        return [];
      },
      cleanUpCredentials: async () => {},
      loadSavedEnvironments: async () => null,
      saveEnvironments: async () => {},
      pruneSavedEnvironments: async () => {},
      restoreEnvironments: async () => {},
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
    sync.setSignedInAccounts(new Set(["account-a", "account-b"]));
    sync.observe(session("account-a"));
    await sync.settled();

    sync.observe(session("account-b"));
    await sync.settled();

    expect(log).toEqual(["activate:account-a", "deactivate"]);
    expect(failures).toHaveLength(1);
  });

  it("drops pending activations once cancelled", async () => {
    const { sync, log, signIn, holdNextRemoval } = harness();
    signIn("account-a", "account-b");
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
