import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.daily(
  "purge expired trash",
  { hourUTC: 4, minuteUTC: 17 },
  internal.lifecycle.purgeExpired,
  {},
);
crons.daily(
  "prune account email log",
  { hourUTC: 4, minuteUTC: 41 },
  internal.email.prune,
  {},
);
export default crons;
