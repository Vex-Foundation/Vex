/**
 * THE SPOTLIGHT CHART'S UTC VOCABULARY.
 *
 * Every time this chart prints - the crosshair label, the tooltip stamp and
 * the axis ticks - is UTC, and it is UTC by construction rather than by the
 * viewer's timezone. A8 requires it: the chart is read beside a board header
 * stamped "26 Aug - 11:11 UTC" and beside a pair age, and an axis nine hours
 * off from the tooltip next to it is a chart that lies about when.
 *
 * WHY THIS IS TWO FORMATTERS AND NOT ONE. In lightweight-charts 5.2.1
 * `localization.timeFormatter` formats the CROSSHAIR time label only
 * (`TimeFormatterFn`), while the AXIS TICK MARKS go through
 * `timeScale.tickMarkFormatter` (`TickMarkFormatter`, typings.d.ts:4968),
 * whose default falls back to the viewer's local timezone. Setting only the
 * first is the defect this module exists to close, so both live here, share
 * one month table and one pad, and cannot drift apart.
 *
 * THE TICK FORMATTER HONOURS `TickMarkType` (typings.d.ts:167) rather than
 * printing HH:mm at every zoom: the library asks for a year, a month, a day
 * or a time depending on how far out the reader has scrolled, and answering
 * "11:00" to a request for a year label is how a 30D axis becomes unreadable.
 */

import { TickMarkType, type Time, type UTCTimestamp } from "lightweight-charts";

export const UTC_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The library hands `Time`, which for this chart is always a UNIX second, but
 * the type also admits a business-day object and a datestring. Anything that
 * is not a finite number of seconds has no place on this axis and is reported
 * as absent rather than coerced into 1970.
 */
function utcDateOf(time: Time): Date | null {
  const seconds = typeof time === "number" ? time : Number(time);
  if (!Number.isFinite(seconds)) return null;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? null : at;
}

function utcMonthName(at: Date): string {
  return UTC_MONTHS[at.getUTCMonth()] ?? "";
}

/** The tooltip's stamp, exactly the mockup's `26 Aug - 04:15`, in UTC. */
export function tooltipStamp(timeSec: UTCTimestamp): string {
  const at = utcDateOf(timeSec);
  if (at === null) return "unknown time";
  return `${String(at.getUTCDate())} ${utcMonthName(at)} - ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

/** The CROSSHAIR time label (`localization.timeFormatter`), in UTC. */
export function utcTimeFormatter(time: Time): string {
  const at = utcDateOf(time);
  if (at === null) return "";
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

/**
 * The AXIS TICK MARKS (`timeScale.tickMarkFormatter`), in UTC, at whatever
 * granularity the library asks for.
 *
 * `TickMarkType` is a library enum and may gain members; an unknown type
 * degrades to the time-of-day label, which is the densest tick this chart's
 * pills produce and therefore the safest fallback.
 */
export function utcTickMarkFormatter(
  time: Time,
  tickMarkType: TickMarkType,
): string {
  const at = utcDateOf(time);
  if (at === null) return "";
  switch (tickMarkType) {
    case TickMarkType.Year:
      return String(at.getUTCFullYear());
    case TickMarkType.Month:
      return utcMonthName(at);
    case TickMarkType.DayOfMonth:
      return `${String(at.getUTCDate())} ${utcMonthName(at)}`;
    case TickMarkType.TimeWithSeconds:
      return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
    case TickMarkType.Time:
    default:
      return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
  }
}
