/**
 * Custom Next.js dev server for Agent Town.
 *
 * Hosts the app and the Claude bridge: a WebSocket endpoint at
 * /api/gateway that the browser talks to, backed by the local `claude` CLI.
 * Also exposes localhost-only internal endpoints for MCP worker dispatch.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocket, WebSocketServer } from "ws";
import next from "next";
import { createLogger } from "./lib/logger";
import {
  attachClaudeBridge,
  dispatchToWorker,
  validateDispatchSecret,
  setWorkerRoster,
} from "./lib/claude-bridge.mjs";

const log = createLogger("Server");

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);

// Workers run in this directory. Resolved once so it is stable across requests.
process.env.CLAUDE_WORKSPACE_DIR = process.env.CLAUDE_WORKSPACE_DIR ?? process.cwd();

const app = next({ dev });
const handle = app.getRequestHandler();

// ── Internal dispatch endpoint (MCP tool → claude bridge) ──

function handleDispatch(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Only accept requests from localhost.
  const remoteIp = req.socket.remoteAddress;
  if (remoteIp !== "127.0.0.1" && remoteIp !== "::1" && remoteIp !== "::ffff:127.0.0.1") {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  const secret = req.headers["x-dispatch-secret"] as string | undefined;
  if (!secret || !validateDispatchSecret(secret)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid dispatch secret" }));
    return;
  }

  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      const { seatId, task } = JSON.parse(body);
      if (!seatId || !task) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "seatId and task are required" }));
        return;
      }

      dispatchToWorker(seatId, task)
        .then((result) => {
          res.writeHead(result.error ? 500 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        })
        .catch((err: Error) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
    }
  });
}

// ── Seat config sync (worker roster for MCP dispatch) ──

function handleSeatSync(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      const { seats } = JSON.parse(body);
      if (Array.isArray(seats)) {
        setWorkerRoster(
          seats
            .filter((s: { assigned?: boolean }) => s.assigned)
            .map((s: { seatId: string; label: string; roleTitle?: string; model?: string }) => ({
              seatId: s.seatId,
              label: s.label,
              roleTitle: s.roleTitle,
              model: s.model,
            })),
        );
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400);
      res.end();
    }
  });
}

app
  .prepare()
  .then(() => {
    const server = createServer((req, res) => {
      // Intercept internal API routes before Next.js.
      if (req.url === "/api/internal/dispatch") {
        handleDispatch(req, res);
        return;
      }
      if (req.url === "/api/internal/seat-sync") {
        handleSeatSync(req, res);
        return;
      }
      handle(req, res);
    });

    attachClaudeBridge(server, WebSocket, WebSocketServer);

    server.listen(port);
    log.info(`Ready on http://localhost:${port}`);
    log.info(`Provider: Claude (local claude CLI)`);
  })
  .catch((err) => {
    log.error("Failed to prepare Next.js:", err);
    process.exit(1);
  });
