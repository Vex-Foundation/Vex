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
import type { BoardChartPillResolution } from "@shared/schemas/board-chart.js";

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

function dayMonth(at: Date): string {
  return `${String(at.getUTCDate())} ${utcMonthName(at)}`;
}

function hoursMinutes(at: Date): string {
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

/** The tooltip's stamp, exactly the mockup's `26 Aug - 04:15`, in UTC. */
export function tooltipStamp(timeSec: UTCTimestamp): string {
  const at = utcDateOf(timeSec);
  if (at === null) return "unknown time";
  return `${dayMonth(at)} - ${hoursMinutes(at)}`;
}

/**
 * The tooltip's and the readout's LAST line: the stamp with its zone said
 * out loud, because a chart read beside a UTC-stamped header must not leave
 * the reader guessing which clock the card is on.
 */
export function tooltipStampUtc(timeSec: UTCTimestamp): string {
  const stamp = tooltipStamp(timeSec);
  return stamp === "unknown time" ? stamp : `${stamp} UTC`;
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
  return utcTickMarkFormatterFor(SPOTLIGHT_AXIS_DEFAULT_PILL)(time, tickMarkType);
}

/**
 * How a TIME-OF-DAY tick reads on each pill. The two intraday pills say the
 * clock alone; a week of two-hour bars needs the day beside it or every
 * "12:00" looks like every other; a month of eight-hour bars is read by day.
 * Year, month and day-of-month ticks read the same on every pill.
 */
const TIME_TICK_FORM: Readonly<
  Record<BoardChartPillResolution, "clock" | "day-clock" | "day">
> = {
  "1m": "clock",
  "15m": "clock",
  "2h": "day-clock",
  "8h": "day",
};

/** The pill the zero-argument formatter speaks for: the densest vocabulary. */
const SPOTLIGHT_AXIS_DEFAULT_PILL: BoardChartPillResolution = "1m";

/**
 * The AXIS TICK MARKS for ONE pill, in UTC, at whatever granularity the
 * library asks for. The pill decides only what a time-of-day tick carries;
 * the branch on `TickMarkType` lives here and nowhere else.
 */
export function utcTickMarkFormatterFor(
  resolution: BoardChartPillResolution,
): (time: Time, tickMarkType: TickMarkType) => string {
  const form = TIME_TICK_FORM[resolution];
  return (time: Time, tickMarkType: TickMarkType): string => {
    const at = utcDateOf(time);
    if (at === null) return "";
    switch (tickMarkType) {
      case TickMarkType.Year:
        return String(at.getUTCFullYear());
      case TickMarkType.Month:
        return utcMonthName(at);
      case TickMarkType.DayOfMonth:
        return dayMonth(at);
      case TickMarkType.TimeWithSeconds:
        return `${hoursMinutes(at)}:${pad(at.getUTCSeconds())}`;
      case TickMarkType.Time:
      default:
        if (form === "day") return dayMonth(at);
        if (form === "day-clock") return `${dayMonth(at)} ${hoursMinutes(at)}`;
        return hoursMinutes(at);
    }
  };
}
