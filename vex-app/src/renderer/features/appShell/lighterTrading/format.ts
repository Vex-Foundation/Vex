export function formatNumber(
  value: number | null,
  options: Intl.NumberFormatOptions = {},
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 6,
    ...options,
  }).format(value);
}

export function formatCompact(value: number | null): string {
  return formatNumber(value, {
    notation: "compact",
    maximumFractionDigits: 2,
  });
}

export function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const digits = value >= 1_000 ? 2 : value >= 1 ? 4 : 6;
  return formatNumber(value, {
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  });
}

export function formatRetrievedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}
