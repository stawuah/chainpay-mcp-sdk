import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("expire credentials and rate buckets", { minutes: 5 }, internal.cleanup.expiredCredentials, {});
export default crons;
