import express from "express";
import pg from "pg";

const { Pool } = pg;

const role = process.env.ROLE ?? "api";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS launchpad_migrations (
        id bigserial PRIMARY KEY,
        name text NOT NULL UNIQUE,
        ran_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      "INSERT INTO launchpad_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
      ["001-create-launchpad-migrations"],
    );
    const { rows } = await client.query("SELECT count(*)::int AS count FROM launchpad_migrations");
    console.log(`migration complete; rows=${rows[0]?.count ?? 0}`);
  } finally {
    client.release();
  }
}

async function runMigrationsWithRetry() {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await migrate();
      return;
    } catch (error) {
      lastError = error;
      console.log(`migration waiting for postgres: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw lastError;
}

if (role === "migrate") {
  runMigrationsWithRetry()
    .then(async () => {
      await pool.end();
    })
    .catch(async (error) => {
      console.error(error);
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
} else {
  const app = express();

  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok\n");
  });

  app.get("/", (_req, res) => {
    res.type("text/plain").send("launch-pad postgres api\n");
  });

  app.get("/db", async (_req, res, next) => {
    try {
      const { rows } = await pool.query(
        "SELECT name, ran_at FROM launchpad_migrations ORDER BY id ASC",
      );
      res.json({ ok: true, migrations: rows });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  });

  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`api listening on ${port}`);
  });

  process.on("SIGTERM", () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
