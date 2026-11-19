/**
 * HTTP app without listening.
 * Server startup (env, migrations, port) stays in src/server.ts so tests can
 * exercise routes without binding a port or opening Postgres.
 */
import express from "express";
import { getRequestById, listEventsForRequest } from "./db.js";
import { createChatRouter } from "./routes/chat.js";
import { createCursorRouter } from "./routes/cursor.js";
import { createGitHubRouter } from "./routes/github.js";

export function createApp(): express.Express {
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

  return app;
}
