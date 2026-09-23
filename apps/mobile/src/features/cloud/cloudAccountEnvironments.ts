import { loadPreferences, updatePreferences } from "../../persistence/imperative";
import type { SavedCloudEnvironment } from "../../persistence/mobile-preferences";

/** The account's saved relay environments, or null if it was never switched away from here. */
export async function loadSavedCloudEnvironments(
  accountId: string,
): Promise<ReadonlyArray<SavedCloudEnvironment> | null> {
  const preferences = await loadPreferences();
  return preferences.cloudAccountEnvironments?.[accountId] ?? null;
}

export async function saveCloudEnvironments(
  accountId: string,
  environments: ReadonlyArray<SavedCloudEnvironment>,
): Promise<void> {
  await updatePreferences((current) => ({
    cloudAccountEnvironments: { ...current.cloudAccountEnvironments, [accountId]: environments },
  }));
}

export async function forgetSavedCloudEnvironments(accountId: string): Promise<void> {
  await updatePreferences((current) => {
    if (!current.cloudAccountEnvironments?.[accountId]) return {};
    const { [accountId]: _restored, ...kept } = current.cloudAccountEnvironments;
    return { cloudAccountEnvironments: kept };
  });
}

export async function pruneSavedCloudEnvironments(
  signedInAccountIds: ReadonlySet<string>,
): Promise<void> {
  await updatePreferences((current) => {
    const saved = current.cloudAccountEnvironments ?? {};
    const kept = Object.entries(saved).filter(([accountId]) => signedInAccountIds.has(accountId));
    return kept.length === Object.keys(saved).length
      ? {}
      : { cloudAccountEnvironments: Object.fromEntries(kept) };
  });
}
