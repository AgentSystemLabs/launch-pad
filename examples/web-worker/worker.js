// A trivial background worker: no HTTP server, no ingress — just periodic work.
// Used to prove launch-pad can run a service that needs no domain/Caddy.
let ticks = 0;

setInterval(() => {
  ticks += 1;
  console.log(`[worker] tick ${ticks} @ ${new Date().toISOString()}`);
}, 5000);

console.log("worker started");
