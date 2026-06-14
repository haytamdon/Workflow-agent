export function readStoredValue(key: string, fallback = ""): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredValue(key: string, value: string): void {
  try {
    if (value) {
      window.localStorage.setItem(key, value);
      return;
    }
    window.localStorage.removeItem(key);
  } catch {
    // Local storage can be unavailable in private or embedded contexts.
  }
}
