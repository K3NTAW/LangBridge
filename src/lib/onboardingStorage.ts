const STORAGE_KEY = "cut.phase1.onboarding.v1";

export function readOnboardingDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissOnboardingPersist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* ignore */
  }
}
