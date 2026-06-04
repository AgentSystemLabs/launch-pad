import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  res.type("text/plain").send("hello from launch-pad");
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "web", time: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`web service listening on :${port}`);
});
