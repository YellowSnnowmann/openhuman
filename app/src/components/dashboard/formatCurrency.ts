/**
 * Format a USD-denominated amount with the requested display currency label.
 * Falls back to the locale "USD" formatter when the configured currency
 * code is not a valid ISO-4217 currency Intl supports — this keeps
 * arbitrary display labels (e.g. "USD ($)") from throwing.
 */
export function formatCurrency(amountUsd: number, currency: string): string {
  const safe = Number.isFinite(amountUsd) ? amountUsd : 0;
  const normalized = currency?.trim() ? currency.trim().toUpperCase() : 'USD';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: normalized,
      maximumFractionDigits: safe >= 100 ? 0 : 2,
    }).format(safe);
  } catch {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: safe >= 100 ? 0 : 2,
    }).format(safe);
  }
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toString();
}

export function shortDayLabel(isoDate: string): string {
  try {
    const date = new Date(`${isoDate}T00:00:00Z`);
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(date);
  } catch {
    return isoDate.slice(5);
  }
}

/**
 * Full long-form date label for tooltips (e.g. "Wed, May 27").
 * Falls back to the raw ISO string when parsing fails.
 */
export function longDateLabel(isoDate: string): string {
  try {
    const date = new Date(`${isoDate}T00:00:00Z`);
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  } catch {
    return isoDate;
  }
}

/**
 * Day-of-month number for the X-axis sub-line, in UTC. Returns the
 * trailing two digits of the ISO date on any parse failure.
 */
export function dayOfMonth(isoDate: string): string {
  try {
    const date = new Date(`${isoDate}T00:00:00Z`);
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: 'UTC' }).format(date);
  } catch {
    return isoDate.slice(-2);
  }
}

/**
 * Human-friendly relative-time string for the "updated Ns ago" pill.
 * Caps at 60s/60m/24h boundaries; returns a plain "Just now" within 5s
 * to avoid a flickering "0s ago" right after a refetch.
 */
export function relativeTime(timestampMs: number, nowMs: number = Date.now()): string {
  const deltaSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (deltaSec < 5) return 'Just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  return `${deltaDay}d ago`;
}
