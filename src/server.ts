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
import express from "express";
import { loadConfig } from "./config.js";
import { closePool, getRequestById, listEventsForRequest, runMigrations } from "./db.js";
import { createChatRouter } from "./routes/chat.js";
import { createCursorRouter } from "./routes/cursor.js";
import { createGitHubRouter } from "./routes/github.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await runMigrations(config.DATABASE_URL);

  const app = express();

  // Health before body parsers — cheap liveness
  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "devbot" });
  });

  // Cursor/GitHub routers apply express.raw on their own paths.
  // Mount them before the global JSON parser so signatures see raw bytes.
  app.use(createCursorRouter());
  app.use(createGitHubRouter());

  // Parsed JSON for chat webhook + timeline API
  app.use(express.json({ limit: "1mb" }));
  app.use(createChatRouter());

  app.get("/requests/:id/timeline", async (req, res) => {
    try {
      const id = req.params.id;
      const request = await getRequestById(id);
      if (!request) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      const events = await listEventsForRequest(id);
      res.status(200).json({
        ok: true,
        request,
        events,
      });
    } catch (err) {
      console.error("[timeline] error", err);
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  });

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
