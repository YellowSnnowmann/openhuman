// Remembers which in-app route started an OAuth connect flow so the `openhuman://oauth/success`
// deep link can return the user there instead of always landing on the connections tab.
const STORAGE_KEY = 'openhuman:oauth:return-route';
const DEFAULT_ROUTE = '/connections';

/** Record the hash route that initiated an OAuth connect (e.g. '/rewards'). */
export function setOAuthReturnRoute(route: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, route);
  } catch {
    // sessionStorage unavailable (private mode / non-browser host) — fall back to the default.
  }
}

/** Read and clear the remembered OAuth return route. Defaults to the connections tab. */
export function takeOAuthReturnRoute(): string {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
    return stored && stored.startsWith('/') ? stored : DEFAULT_ROUTE;
  } catch {
    return DEFAULT_ROUTE;
  }
}
