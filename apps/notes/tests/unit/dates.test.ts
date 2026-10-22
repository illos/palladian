import { describe, expect, test } from "vitest";
import { dayAndTime, smartDate, timeRange } from "../../src/dates";

// Local times, so the tests hold in any time zone. Expected clock and date
// strings come from the same locale calls, so they hold in any locale.
const now = new Date(2026, 9, 22, 15, 30);
const at = (day: number, hour: number, minute: number, year = 2026) =>
  new Date(year, 9, day, hour, minute).getTime();
const clock = (time: number) =>
  new Date(time).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
const day = (time: number, year?: "numeric") =>
  new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(year ? { year } : {}),
  });

describe("smartDate", () => {
  test("the time today, Yesterday, or the date", () => {
    expect(smartDate(at(22, 9, 5), now)).toBe(clock(at(22, 9, 5)));
    expect(smartDate(at(21, 23, 59), now)).toBe("Yesterday");
    expect(smartDate(at(3, 12, 0), now)).toBe(day(at(3, 12, 0)));
    expect(smartDate(at(3, 12, 0, 2025), now)).toBe(
      day(at(3, 12, 0, 2025), "numeric"),
    );
  });
});

describe("dayAndTime", () => {
  test("names today and yesterday, and dates the rest", () => {
    expect(dayAndTime(at(22, 9, 5), now)).toBe(`Today ${clock(at(22, 9, 5))}`);
    expect(dayAndTime(at(21, 8, 0), now)).toBe(
      `Yesterday ${clock(at(21, 8, 0))}`,
    );
    expect(dayAndTime(at(3, 16, 40), now)).toBe(
      `${day(at(3, 16, 40))}, ${clock(at(3, 16, 40))}`,
    );
  });
});

describe("timeRange", () => {
  test("one minute is one moment", () => {
    const start = at(22, 14, 14);
    expect(timeRange(start, start + 20_000, now)).toBe(`Today ${clock(start)}`);
  });

  test("a range within a day names the day once", () => {
    expect(timeRange(at(22, 14, 14), at(22, 14, 31), now)).toBe(
      `Today ${clock(at(22, 14, 14))} – ${clock(at(22, 14, 31))}`,
    );
    expect(timeRange(at(2, 9, 0), at(2, 11, 30), now)).toBe(
      `${day(at(2, 9, 0))}, ${clock(at(2, 9, 0))} – ${clock(at(2, 11, 30))}`,
    );
  });

  test("a range across days dates both ends", () => {
    expect(timeRange(at(21, 23, 50), at(22, 0, 10), now)).toBe(
      `Yesterday ${clock(at(21, 23, 50))} – Today ${clock(at(22, 0, 10))}`,
    );
  });
});
