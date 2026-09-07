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

export function formatDecimalString(value: string | null): string {
  if (value === null || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return "—";
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer = "0", fraction] = unsigned.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

export function formatCompact(value: number | null): string {
  return formatNumber(value, {
    notation: "compact",
    maximumFractionDigits: 2,
  });
}

export function formatQuoteVolume(
  value: number | null,
  quoteSymbol: string | null,
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const compact = formatCompact(value);
  if (quoteSymbol === "USD") return `$${compact}`;
  return quoteSymbol === null ? compact : `${compact} ${quoteSymbol}`;
}

export function formatBaseAmount(
  value: number | null,
  baseSymbol: string | null,
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const compact = formatCompact(value);
  return baseSymbol === null || baseSymbol === "" ? compact : `${compact} ${baseSymbol}`;
}

export function formatPrice(value: number | null, precision?: number): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (precision !== undefined) {
    return formatNumber(value, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    });
  }
  const digits = value >= 1_000 ? 2 : value >= 1 ? 4 : 6;
  return formatNumber(value, {
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  });
}

export function formatProviderPercent(
  value: string | null,
  enabled = true,
): string {
  if (!enabled) return "Disabled";
  const formatted = formatDecimalString(value);
  return formatted === "—" ? formatted : `${formatted}%`;
}

export function marketSymbols(
  symbol: string,
  marketType: "perp" | "spot",
): { readonly base: string; readonly quote: string } {
  if (marketType === "spot") {
    const separator = symbol.includes("/") ? "/" : symbol.includes(":") ? ":" : null;
    if (separator !== null) {
      const [base, quote] = symbol.split(separator, 2);
      if (base !== undefined && base.length > 0 && quote !== undefined && quote.length > 0) {
        return { base, quote };
      }
    }
    return { base: symbol, quote: "quote" };
  }
  const base = symbol.replace(/[-/](?:USD|USDC|USDG)$/i, "");
  return { base: base.length > 0 ? base : symbol, quote: "USD" };
}

export function formatRetrievedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}
