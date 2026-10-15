import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.daily(
  "purge expired trash",
  { hourUTC: 4, minuteUTC: 17 },
  internal.lifecycle.purgeExpired,
  {},
);
export default crons;
