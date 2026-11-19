/**
 * DevBot Phase 1 entrypoint.
 * - JSON parser for chat + REST
 * - Raw body for Cursor/GitHub signature verification
 * - Migrations on startup
 *
 * Load `.env` into process.env before loadConfig(). Config itself stays
 * dotenv-free so tests can pass an explicit env object without side effects.
 */
import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closePool, runMigrations } from "./db.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await runMigrations(config.DATABASE_URL);

  const app = createApp();

  const server = app.listen(config.PORT, () => {
    // PUBLIC_BASE_URL may be the local default — loadConfig already warns once.
    console.log(
      `[devbot] listening on :${config.PORT} (PUBLIC_BASE_URL=${config.PUBLIC_BASE_URL})`,
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`[devbot] ${signal} — shutting down`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[devbot] failed to start", err);
  process.exit(1);
});
