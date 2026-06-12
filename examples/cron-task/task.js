// A tiny scheduled task. The agent starts one container per cron fire; the task
// does its work, prints a line (shipped to CloudWatch), and EXITS 0 — there is no
// long-running loop. A non-zero exit would surface as `cron.lastExitCode` in
// `launch-pad status`.
console.log(`[cron-task] run at ${new Date().toISOString()}`);

// Simulate a little real work so the run is visible as "in progress" briefly.
setTimeout(() => {
  console.log("[cron-task] done");
  process.exit(0);
}, 2000);
