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
crons.hourly(
  "expire file uploads",
  { minuteUTC: 29 },
  internal.files.expireUploads,
  {},
);
// After the note purge, so objects only purged notes used are already gone.
crons.daily(
  "purge expired file objects",
  { hourUTC: 4, minuteUTC: 53 },
  internal.files.purgeExpired,
  {},
);
export default crons;
