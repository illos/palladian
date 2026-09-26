import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
crons.interval("reconcile private file objects", { minutes: 5 }, internal.platform.files.reconcile, {});
export default crons;
