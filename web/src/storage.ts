// localStorage throws (SecurityError) when site data is blocked, and merely
// touching the global can throw in some sandboxed contexts. Preferences are a
// nicety, so a failed read is "unset" and a failed write is dropped rather
// than letting the exception escape into a render and blank the app.

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage blocked or full: the preference just won't persist */ }
}
