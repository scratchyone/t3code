import { describe, expect, it } from "vite-plus/test";

import type { SavedCloudEnvironment } from "../../persistence/mobile-preferences";
import { type CloudTokenProvider, createCloudAccountSync } from "./cloudAccountSync";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
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
  const draftGates: Array<ReturnType<typeof deferred>> = [];
  // Relay environments currently in the registry, and each account's saved set.
  let connected: SavedCloudEnvironment[] = [];
  const saved = new Map<string, ReadonlyArray<SavedCloudEnvironment>>();

  const sync = createCloudAccountSync({
    listRelayEnvironments: async () => [...connected],
    removeRelayEnvironments: async (accountId) => {
      log.push(`remove:${accountId}`);
      const gate = removalGates.shift();
      if (gate) await gate.promise;
      // Like the real draft archive, the stored owner survives removal so a
      // crashed cleanup can be retried on the next cold start.
      connected = [];
    },
    cleanUpCredentials: async (previous) => {
      log.push(`cleanup:${previous ? await previous() : "none"}`);
    },
    loadSavedEnvironments: async (accountId) => saved.get(accountId) ?? null,
    saveEnvironments: async (accountId, environments) => {
      log.push(`save:${accountId}:${environments.map((env) => env.environmentId).join(",")}`);
      saved.set(accountId, environments);
    },
    forgetSavedEnvironments: async (accountId) => {
      saved.delete(accountId);
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
      await draftGates.shift()?.promise;
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
    holdNextDraftRestore: () => {
      const gate = deferred();
      draftGates.push(gate);
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
    expect(log).toEqual([
      "clear-onboarding",
      "deactivate",
      "save:account-a:env-a1",
      "remove:account-a",
    ]);

    removal.resolve();
    await sync.settled();

    expect(log).toEqual([
      "clear-onboarding",
      "deactivate",
      "save:account-a:env-a1",
      "remove:account-a",
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
      "clear-onboarding",
      "deactivate",
      "save:account-b:env-b1",
      "remove:account-b",
      "cleanup:account-b-token",
      "restore:account-a",
      "reconnect:env-a1,env-a2",
      "activate:account-a",
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
    expect(log).toEqual([
      "clear-onboarding",
      "restore:account-a",
      "activate:account-a",
      "onboarding:account-a",
    ]);
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
      "clear-onboarding",
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
    const { sync, log, signIn, connect } = harness({ storedAccountId: "account-a" });
    signIn("account-a", "account-b");
    connect("env-a1");

    sync.observe(session("account-b"));
    await sync.settled();

    expect(log).toEqual([
      "save:account-a:env-a1",
      "remove:account-a",
      "cleanup:none",
      "restore:account-b",
      "activate:account-b",
    ]);
  });

  it("keeps the saved list when a crashed cleanup is retried on the next start", async () => {
    // The previous run saved A's list and removed its environments, then died
    // before B's drafts took ownership.
    const { sync, saved, signIn } = harness({ storedAccountId: "account-a" });
    signIn("account-a", "account-b");
    saved.set("account-a", [{ environmentId: "env-a1", label: "env-a1", enabled: true }]);

    sync.observe(session("account-b"));
    await sync.settled();

    expect(saved.get("account-a")?.map((env) => env.environmentId)).toEqual(["env-a1"]);
  });

  it("keeps a complete saved list when a crash left some environments behind", async () => {
    const { sync, saved, signIn, connect } = harness({ storedAccountId: "account-a" });
    signIn("account-a", "account-b");
    saved.set("account-a", [
      { environmentId: "env-a1", label: "env-a1", enabled: true },
      { environmentId: "env-a2", label: "env-a2", enabled: true },
    ]);
    connect("env-a2");

    sync.observe(session("account-b"));
    await sync.settled();

    expect(saved.get("account-a")?.map((env) => env.environmentId)).toEqual(["env-a1", "env-a2"]);
  });

  it("retries the installed account's cleanup rather than a skipped account's", async () => {
    const { sync, log, saved, active, signIn, connect, holdNextRemoval } = harness();
    signIn("account-a", "account-b", "account-c");
    sync.observe(session("account-a"));
    await sync.settled();
    connect("env-a1");

    const removal = holdNextRemoval();
    sync.observe(session("account-b"));
    await drainMicrotasks();
    removal.reject(new Error("archive failed"));
    await sync.settled();
    expect(active()).toBeNull();

    log.length = 0;
    sync.observe(session("account-c"));
    await sync.settled();

    expect(log).toContain("remove:account-a");
    expect(log).not.toContain("remove:account-b");
    expect(saved.has("account-b")).toBe(false);
    expect(saved.get("account-a")?.map((env) => env.environmentId)).toEqual(["env-a1"]);
    expect(active()?.accountId).toBe("account-c");
  });

  it("does not onboard an account switched back to with no environments", async () => {
    const { sync, log, signIn } = harness();
    signIn("account-a", "account-b");
    sync.observe(session("account-a"));
    await sync.settled();
    sync.observe(session("account-b"));
    await sync.settled();
    log.length = 0;

    sync.observe(session("account-a"));
    await sync.settled();

    expect(log).not.toContain("onboarding:account-a");
  });

  it("does not onboard when Clerk repeats the session while drafts restore", async () => {
    const { sync, log, signIn, connect, connected, holdNextDraftRestore } = harness();
    signIn("account-a", "account-b");
    sync.observe(session("account-b"));
    await sync.settled();
    connect("env-b1");
    sync.observe(session("account-a"));
    await sync.settled();
    log.length = 0;

    const draftRestore = holdNextDraftRestore();
    sync.observe(session("account-b"));
    await drainMicrotasks();
    sync.observe(session("account-b"));
    draftRestore.resolve();
    await sync.settled();

    expect(log).not.toContain("onboarding:account-b");
    expect(connected()).toEqual(["env-b1"]);
  });

  it("onboards a new account when Clerk repeats its session before it installs", async () => {
    const { sync, log, signIn, holdNextRemoval } = harness();
    signIn("account-a", "account-b");
    sync.observe(session("account-a"));
    await sync.settled();
    log.length = 0;

    const removal = holdNextRemoval();
    sync.observe(session("account-b"));
    sync.observe(session("account-b"));
    removal.resolve();
    await sync.settled();

    expect(log).toContain("onboarding:account-b");
  });

  it("forgets environments of an account that signs back in before its cleanup runs", async () => {
    const { sync, log, saved, signIn, connect, holdNextDraftRestore } = harness();
    signIn("account-a", "account-b");
    sync.observe(session("account-b"));
    await sync.settled();
    sync.observe(session("account-a"));
    await sync.settled();
    connect("env-a1");
    log.length = 0;

    // Queue A's sign-out cleanup behind other work, then sign A straight back in.
    const busy = holdNextDraftRestore();
    sync.observe(session("account-a"));
    signIn("account-b");
    sync.observe(null);
    signIn("account-a", "account-b");
    sync.observe(session("account-a"));
    busy.resolve();
    await sync.settled();

    expect(saved.has("account-a")).toBe(false);
    expect(log).not.toContain("reconnect:env-a1");
    expect(log).toContain("onboarding:account-a");
  });

  it("finishes an environment restore that was interrupted by the app closing", async () => {
    // B's drafts were restored, then the app died before its environments came back.
    const { sync, log, saved, signIn, connected } = harness({ storedAccountId: "account-b" });
    signIn("account-a", "account-b");
    saved.set("account-b", [{ environmentId: "env-b1", label: "env-b1", enabled: true }]);

    sync.observe(session("account-b"));
    await sync.settled();

    expect(log).toEqual(["restore:account-b", "reconnect:env-b1", "activate:account-b"]);
    expect(connected()).toEqual(["env-b1"]);
    expect(saved.has("account-b")).toBe(false);
  });

  it("keeps a skipped account's saved environments when switches outpace cleanup", async () => {
    const { sync, saved, signIn, connect, holdNextRemoval } = harness();
    signIn("account-a", "account-b", "account-c");
    sync.observe(session("account-b"));
    await sync.settled();
    connect("env-b1");
    sync.observe(session("account-a"));
    await sync.settled();

    const removal = holdNextRemoval();
    sync.observe(session("account-b"));
    sync.observe(session("account-c"));
    removal.resolve();
    await sync.settled();

    expect(saved.get("account-b")?.map((env) => env.environmentId)).toEqual(["env-b1"]);
  });

  it("archives an account superseded while its drafts were restoring", async () => {
    const { sync, log, saved, active, signIn, connect, connected, holdNextDraftRestore } =
      harness();
    signIn("account-a", "account-b", "account-c");
    sync.observe(session("account-b"));
    await sync.settled();
    connect("env-b1");
    sync.observe(session("account-a"));
    await sync.settled();
    log.length = 0;

    const draftRestore = holdNextDraftRestore();
    sync.observe(session("account-b"));
    await drainMicrotasks();
    expect(log).toContain("restore:account-b");
    sync.observe(session("account-c"));
    draftRestore.resolve();
    await sync.settled();

    // B finished installing without going live, then was cleaned up normally.
    expect(log).not.toContain("activate:account-b");
    expect(log).toContain("reconnect:env-b1");
    expect(log).toContain("remove:account-b");
    expect(saved.get("account-b")?.map((env) => env.environmentId)).toEqual(["env-b1"]);
    expect(connected()).toEqual([]);
    expect(active()?.accountId).toBe("account-c");
  });

  it("forgets an inactive account's saved environments when it signs out", async () => {
    const { sync, log, saved, signIn, connect } = harness();
    signIn("account-a", "account-b");
    sync.observe(session("account-a"));
    await sync.settled();
    connect("env-a1");
    sync.observe(session("account-b"));
    await sync.settled();
    expect(saved.has("account-a")).toBe(true);

    signIn("account-b");
    await sync.settled();
    expect(saved.has("account-a")).toBe(false);

    // Signing back in is a fresh account on this device.
    log.length = 0;
    signIn("account-a", "account-b");
    sync.observe(session("account-a"));
    await sync.settled();
    expect(log).toContain("onboarding:account-a");
  });

  it("keeps the next account inactive when the previous account's cleanup fails", async () => {
    const failures: unknown[] = [];
    const log: string[] = [];
    const sync = createCloudAccountSync({
      listRelayEnvironments: async () => [],
      removeRelayEnvironments: async (accountId) => {
        if (accountId === "account-a") throw new Error("archive failed");
      },
      cleanUpCredentials: async () => {},
      loadSavedEnvironments: async () => null,
      saveEnvironments: async () => {},
      forgetSavedEnvironments: async () => {},
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
