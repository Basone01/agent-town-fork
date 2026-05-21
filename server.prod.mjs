/**
 * Production server for Agent Town (npx / standalone).
 *
 * Reads the Next.js config from the standalone build output and serves the
 * app plus the Claude bridge (WebSocket /api/gateway backed by the local
 * `claude` CLI) and the localhost-only internal endpoints for MCP dispatch.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  attachClaudeBridge,
  dispatchToWorker,
  validateDispatchSecret,
  setWorkerRoster,
} from "./lib/claude-bridge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isProd = process.env.NODE_ENV === "production";
const prefix = "[Server]";
const log = {
  info: isProd ? () => {} : console.info.bind(console, prefix),
  error: console.error.bind(console, prefix),
};

// Workers run in the directory Agent Town was launched from — capture it
// before chdir() points us at the standalone build directory.
process.env.CLAUDE_WORKSPACE_DIR = process.env.CLAUDE_WORKSPACE_DIR ?? process.cwd();

// Load standalone config before importing next.
const requiredServerFiles = JSON.parse(
  readFileSync(join(__dirname, ".next", "required-server-files.json"), "utf-8"),
);
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(requiredServerFiles.config);

const { default: next } = await import("next");
const { WebSocket, WebSocketServer } = await import("ws");

const port = parseInt(process.env.PORT ?? "3000", 10);

process.chdir(__dirname);
const app = next({ dev: false, dir: __dirname });
const handle = app.getRequestHandler();

// ── Internal dispatch endpoint (MCP tool → claude bridge) ──

function handleDispatch(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }
  const remoteIp = req.socket.remoteAddress;
  if (remoteIp !== "127.0.0.1" && remoteIp !== "::1" && remoteIp !== "::ffff:127.0.0.1") {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }
  const secret = req.headers["x-dispatch-secret"];
  if (!secret || !validateDispatchSecret(secret)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid dispatch secret" }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
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
        .catch((err) => {
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

function handleSeatSync(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      const { seats } = JSON.parse(body);
      if (Array.isArray(seats)) {
        setWorkerRoster(
          seats
            .filter((s) => s.assigned)
            .map((s) => ({
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

    server.listen(port, () => {
      log.info("");
      log.info("  \x1b[36m\x1b[1mAgent Town\x1b[0m is running!");
      log.info("");
      log.info(`  > Local:    \x1b[4mhttp://localhost:${port}\x1b[0m`);
      log.info("  > Provider: Claude (local claude CLI)");
      log.info("");
    });
  })
  .catch((err) => {
    log.error("Failed to start Agent Town:", err);
    process.exit(1);
  });
