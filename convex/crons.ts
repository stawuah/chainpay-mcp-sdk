import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("expire credentials and rate buckets", { minutes: 5 }, internal.cleanup.expiredCredentials, {});
crons.interval("expire community pet sessions", { minutes: 5 }, internal.pet.cleanup, {});
crons.interval("index support vault contributions", { minutes: 5 }, internal.support.sync, {});
export default crons;
