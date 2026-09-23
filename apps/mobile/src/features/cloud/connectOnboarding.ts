import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

// Signals RootStackLayout (inside the navigation tree) that an in-session
// sign-in just completed. Holds the account id so a sign-out between the
// request and the navigation cannot present the sheet for the wrong account.
export const connectOnboardingRequestAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:connect-onboarding-request"),
);

/**
 * Requests the onboarding sheet for the given account. Runs when an account
 * signs in with no saved environments on this device: its first sign-in, or
 * any sign-in after signing out. Switching back to an account restores its
 * environments instead.
 */
export function requestConnectOnboarding(accountId: string): void {
  appAtomRegistry.set(connectOnboardingRequestAtom, accountId);
}

export function clearConnectOnboardingRequest(): void {
  appAtomRegistry.set(connectOnboardingRequestAtom, null);
}
