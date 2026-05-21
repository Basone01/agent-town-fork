/**
 * Custom Next.js dev server for Agent Town.
 *
 * Hosts the app and an agent bridge: a WebSocket endpoint at /api/gateway
 * that the browser talks to. The bridge is selected by AGENT_PROVIDER —
 * `claude` (local Claude Code CLI, default) or `auggie` (Augment CLI).
 * Also exposes localhost-only internal endpoints for MCP worker dispatch.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocket, WebSocketServer } from "ws";
import next from "next";
import { createLogger } from "./lib/logger";
import {
  attachClaudeBridge,
  dispatchToWorker as claudeDispatch,
  validateDispatchSecret as claudeValidate,
  setWorkerRoster as claudeSetRoster,
} from "./lib/claude-bridge.mjs";
import {
  attachAuggieBridge,
  dispatchToWorker as auggieDispatch,
  validateDispatchSecret as auggieValidate,
  setWorkerRoster as auggieSetRoster,
} from "./lib/auggie-bridge.mjs";
import { handlePickDirectory } from "./lib/pick-directory.mjs";

const log = createLogger("Server");

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);

// ── Provider selection ──
const AGENT_PROVIDER = process.env.AGENT_PROVIDER === "auggie" ? "auggie" : "claude";
const isAuggie = AGENT_PROVIDER === "auggie";
// Expose the provider to client code (compiled on-demand in dev).
process.env.NEXT_PUBLIC_AGENT_PROVIDER = AGENT_PROVIDER;

const dispatchToWorker = isAuggie ? auggieDispatch : claudeDispatch;
const validateDispatchSecret = isAuggie ? auggieValidate : claudeValidate;
const setWorkerRoster = isAuggie ? auggieSetRoster : claudeSetRoster;

// Claude workers run in this directory. Resolved once so it is stable.
process.env.CLAUDE_WORKSPACE_DIR = process.env.CLAUDE_WORKSPACE_DIR ?? process.cwd();

const app = next({ dev });
const handle = app.getRequestHandler();

// ── Internal dispatch endpoint (MCP tool → active bridge) ──

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
      if (req.url === "/api/internal/pick-directory") {
        handlePickDirectory(req, res);
        return;
      }
      handle(req, res);
    });

    if (isAuggie) {
      attachAuggieBridge(server, WebSocket, WebSocketServer);
    } else {
      attachClaudeBridge(server, WebSocket, WebSocketServer);
    }

    server.listen(port);
    log.info(`Ready on http://localhost:${port}`);
    log.info(`Provider: ${isAuggie ? "Auggie (auggie CLI)" : "Claude (local claude CLI)"}`);
  })
  .catch((err) => {
    log.error("Failed to prepare Next.js:", err);
    process.exit(1);
  });
