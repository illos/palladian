/** Dates as the notes app shows them, in the reader's locale and time zone. */

function sameDay(a: Date, b: Date) {
  return a.toDateString() === b.toDateString();
}

function isYesterday(date: Date, now: Date) {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return sameDay(date, yesterday);
}

function clock(date: Date) {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function calendarDate(date: Date, now: Date) {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear()
      ? ({ year: "numeric" } as const)
      : {}),
  });
}

/** A note row's date: the time today, "Yesterday", or the date. */
export function smartDate(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp);
  if (sameDay(date, now)) return clock(date);
  if (isYesterday(date, now)) return "Yesterday";
  return calendarDate(date, now);
}

/** A moment with its day: "Today 2:14 PM", "Yesterday 9:05 AM", "Oct 3, 4:40 PM". */
export function dayAndTime(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp);
  if (sameDay(date, now)) return `Today ${clock(date)}`;
  if (isYesterday(date, now)) return `Yesterday ${clock(date)}`;
  return `${calendarDate(date, now)}, ${clock(date)}`;
}

/**
 * When a stretch of editing happened: one moment if it began and ended in the
 * same minute, a time range within one day, or two dated moments.
 */
export function timeRange(start: number, end: number, now = new Date()) {
  const from = new Date(start);
  const to = new Date(end);
  const first = dayAndTime(start, now);
  if (!sameDay(from, to)) return `${first} – ${dayAndTime(end, now)}`;
  if (clock(from) === clock(to)) return first;
  return `${first} – ${clock(to)}`;
}
