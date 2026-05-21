/**
 * Claude Bridge — drives Agent Town with the locally installed `claude` CLI.
 *
 * Speaks the frame-based gateway RPC protocol the browser's GatewayClient
 * expects (connect.challenge → connect → hello-ok, chat.send / chat.abort,
 * sessions.list, models.list) and fulfils it by spawning
 * `claude -p --output-format stream-json` child processes, mapping the
 * NDJSON event stream onto gateway `agent` / `chat` events.
 *
 * Single ESM module imported by both server.ts (dev, via tsx) and
 * server.prod.mjs (standalone npx build). WebSocket classes are injected so
 * module resolution works in both environments.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";

const isProd = process.env.NODE_ENV === "production";
const prefix = "[Claude Bridge]";
const log = {
  debug: isProd ? () => {} : console.debug.bind(console, prefix),
  info: isProd ? () => {} : console.info.bind(console, prefix),
  warn: console.warn.bind(console, prefix),
  error: console.error.bind(console, prefix),
};

// ── Module state ───────────────────────────────────────

let runCounter = 0;
let activeClientState = null;
let activeWsClass = null;
let workerRoster = [];
let mcpConfigPath = null;
let workspaceDir = null;
let sessionsLoaded = false;

const dispatchSecret = `at_${Date.now()}_${Math.random().toString(36).slice(2)}`;

/** Persisted map: gateway sessionKey → claude session UUID. Survives restarts. */
const sessionMap = new Map();
/** Per-sessionKey token usage snapshot, feeds the ContextMeter via sessions.list. */
const sessionUsage = new Map();
/** Run IDs intentionally aborted — close handler skips error reporting for these. */
const abortedRuns = new Set();

/** Static model catalogue — `claude` has no `model list` subcommand. */
const MODEL_CATALOG = [
  { id: "opus", provider: "anthropic", contextWindow: 200_000 },
  { id: "sonnet", provider: "anthropic", contextWindow: 200_000 },
  { id: "haiku", provider: "anthropic", contextWindow: 200_000 },
];
const CONTEXT_WINDOW = 200_000;

// ── Config resolution ──────────────────────────────────

function getWorkspaceDir() {
  return workspaceDir ?? process.env.CLAUDE_WORKSPACE_DIR ?? process.cwd();
}

/** Normalize a client-supplied workspace path: trim and expand a leading `~`. */
function resolveWorkspace(input) {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function getPermissionMode() {
  return process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions";
}

function getDefaultModel() {
  return process.env.CLAUDE_MODEL || "sonnet";
}

// ── Session-map persistence ────────────────────────────

function sessionsFilePath() {
  return join(homedir(), ".agent-town", "sessions.json");
}

/** Load this workspace's sessionKey → claudeSessionId map from disk. */
function loadPersistedSessions() {
  try {
    const data = JSON.parse(readFileSync(sessionsFilePath(), "utf-8"));
    const entry = data?.[getWorkspaceDir()];
    if (entry && typeof entry === "object") {
      for (const [k, v] of Object.entries(entry)) {
        if (typeof v === "string") sessionMap.set(k, v);
      }
      log.info(`Restored ${sessionMap.size} session(s) for ${getWorkspaceDir()}`);
    }
  } catch {
    /* no file yet — first run */
  }
}

/** Write the sessionMap back, namespaced by workspace dir (other workspaces preserved). */
function persistSessions() {
  try {
    let data = {};
    try {
      data = JSON.parse(readFileSync(sessionsFilePath(), "utf-8")) ?? {};
    } catch {
      /* fresh file */
    }
    data[getWorkspaceDir()] = Object.fromEntries(sessionMap);
    mkdirSync(dirname(sessionsFilePath()), { recursive: true });
    writeFileSync(sessionsFilePath(), JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    log.warn("Failed to persist sessions:", err.message);
  }
}

// ── Frame helpers ──────────────────────────────────────

function sendFrame(state, WebSocket, frame) {
  if (state.ws.readyState !== WebSocket.OPEN) return;
  try {
    state.ws.send(JSON.stringify(frame));
  } catch (err) {
    log.error("sendFrame failed:", err.message);
  }
}

function sendEvent(state, WebSocket, event, payload) {
  sendFrame(state, WebSocket, { type: "event", event, payload, seq: state.seq++ });
}

function sendResponse(state, WebSocket, id, ok, payloadOrError) {
  const frame = { type: "res", id, ok };
  if (ok) frame.payload = payloadOrError;
  else frame.error = payloadOrError;
  sendFrame(state, WebSocket, frame);
}

function checkOrigin(req, socket) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        log.warn(`Rejected WS upgrade: origin ${origin} does not match host ${host}`);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return false;
      }
    } catch {
      log.warn(`Rejected WS upgrade: invalid origin ${origin}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return false;
    }
  }
  return true;
}

// ── MCP config (multi-worker dispatch) ─────────────────

function getMcpServerPath() {
  // Resolve relative to this module so it works in dev and standalone builds.
  return join(dirname(fileURLToPath(import.meta.url)), "mcp", "agent-town-mcp.mjs");
}

/** Write (once) a temp MCP config pointing at our stdio dispatch server. */
function writeMcpConfig() {
  if (workerRoster.length <= 1) return null; // nothing to dispatch to
  if (mcpConfigPath) return mcpConfigPath;
  try {
    const config = {
      mcpServers: {
        "agent-town": { command: "node", args: [getMcpServerPath()] },
      },
    };
    const dir = join(tmpdir(), "agent-town-mcp");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `mcp-config-${process.pid}.json`);
    writeFileSync(filePath, JSON.stringify(config), "utf-8");
    mcpConfigPath = filePath;
    log.info(`MCP config written to ${filePath}`);
    return filePath;
  } catch (err) {
    log.warn("Failed to write MCP config:", err.message);
    return null;
  }
}

// ── Personality / system prompt ────────────────────────

function buildRosterContext(currentSeatLabel) {
  if (workerRoster.length <= 1) return "";
  const others = workerRoster.filter((w) => w.label !== currentSeatLabel);
  if (others.length === 0) return "";
  const lines = others.map(
    (w) => `  • seatId="${w.seatId}" — ${w.label} (${w.roleTitle ?? "Worker"})`,
  );
  return (
    "\nYou have teammates. Delegate work with the dispatch_to_worker tool:\n" +
    lines.join("\n") +
    "\n"
  );
}

/** Worker identity for `--append-system-prompt` (kept out of the chat transcript). */
function buildSystemPrompt(seatLabel, seatRole) {
  const parts = [];
  if (seatLabel) parts.push(`You are "${seatLabel}"`);
  if (seatRole) parts.push(seatLabel ? `, working as a ${seatRole}` : `You work as a ${seatRole}`);
  const intro = parts.length
    ? `${parts.join("")}, an AI worker in Agent Town. Stay in character while you work.\n`
    : "You are an AI worker in Agent Town.\n";
  return intro + buildRosterContext(seatLabel);
}

// ── stream-json helpers ────────────────────────────────

function normalizeToolContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (b?.text ?? JSON.stringify(b))))
      .join("\n");
  }
  return JSON.stringify(content);
}

function recordUsage(sessionKey, model, usage) {
  if (!usage) return;
  const ctx =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  sessionUsage.set(sessionKey, {
    model,
    totalTokens: ctx,
    inputTokens: ctx,
    outputTokens: usage.output_tokens ?? 0,
    contextWindow: CONTEXT_WINDOW,
  });
}

// ── Core run executor (shared by chat.send and dispatch) ──

/**
 * Spawn `claude` for one run, stream its stdout, and emit gateway events.
 * @returns {Promise<{ result: string, error?: string }>}
 */
function executeRun(state, WebSocket, opts) {
  const { runId, sessionKey, sessionMapKey, message, model, systemPrompt, subagent, workspace } =
    opts;
  // A per-task workspace overrides the bridge's global default cwd.
  const cwd = workspace || getWorkspaceDir();

  return new Promise((resolve) => {
    sendEvent(state, WebSocket, "agent", {
      runId,
      sessionKey,
      stream: "lifecycle",
      data: subagent
        ? { phase: "start", label: subagent.label, seatId: subagent.seatId }
        : { phase: "start" },
    });

    const pendingTools = new Map();
    let gotResult = false;
    let resultText = "";
    let resultErr = null;
    let settled = false;

    const finalizeError = (msg) => {
      if (settled) return;
      settled = true;
      log.error(`Run ${runId} failed:`, msg);
      sendEvent(state, WebSocket, "agent", {
        runId,
        sessionKey,
        stream: "lifecycle",
        data: { phase: "error", error: msg },
      });
      sendEvent(state, WebSocket, "chat", { runId, sessionKey, state: "error" });
      resolve({ result: "", error: msg });
    };

    const finalizeOk = (text) => {
      if (settled) return;
      settled = true;
      sendEvent(state, WebSocket, "agent", {
        runId,
        sessionKey,
        stream: "lifecycle",
        data: { phase: "end" },
      });
      sendEvent(state, WebSocket, "chat", {
        runId,
        sessionKey,
        state: "final",
        message: { content: [{ type: "text", text }] },
      });
      log.info(`Run ${runId} completed`);
      resolve({ result: text });
    };

    /** Parse one NDJSON line from claude's stdout and emit gateway events. */
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return; // diagnostics / partial line
      }

      switch (obj.type) {
        case "system":
          if (typeof obj.session_id === "string") {
            sessionMap.set(sessionMapKey, obj.session_id);
            persistSessions();
          }
          break;

        case "stream_event": {
          const ev = obj.event;
          if (
            ev?.type === "content_block_delta" &&
            ev.delta?.type === "text_delta" &&
            ev.delta.text
          ) {
            sendEvent(state, WebSocket, "agent", {
              runId,
              sessionKey,
              stream: "assistant",
              data: { delta: ev.delta.text },
            });
          }
          break;
        }

        case "assistant": {
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === "tool_use") {
                pendingTools.set(block.id, { name: block.name, input: block.input });
              }
            }
          }
          break;
        }

        case "user": {
          const content = obj.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === "tool_result") {
                const pend = pendingTools.get(block.tool_use_id);
                pendingTools.delete(block.tool_use_id);
                sendEvent(state, WebSocket, "agent", {
                  runId,
                  sessionKey,
                  stream: "tool",
                  data: {
                    name: pend?.name ?? "tool",
                    input: pend?.input,
                    output: normalizeToolContent(block.content),
                  },
                });
              }
            }
          }
          break;
        }

        case "result":
          gotResult = true;
          if (typeof obj.session_id === "string") {
            sessionMap.set(sessionMapKey, obj.session_id);
            persistSessions();
          }
          recordUsage(sessionKey, model, obj.usage);
          if (obj.is_error) {
            resultErr = typeof obj.result === "string" ? obj.result : "claude reported an error";
          } else {
            resultText = typeof obj.result === "string" ? obj.result : "";
          }
          break;

        default:
          break;
      }
    };

    /** One spawn attempt. `withResume` controls whether --resume is passed. */
    const attempt = (withResume) => {
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        getPermissionMode(),
        "--model",
        model,
      ];
      if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
      const cfg = writeMcpConfig();
      if (cfg) args.push("--mcp-config", cfg);
      const resumeId = withResume ? sessionMap.get(sessionMapKey) : undefined;
      if (resumeId) args.push("--resume", resumeId);

      log.info(`Spawning claude for run ${runId}${resumeId ? " (resume)" : ""}`);

      let child;
      try {
        child = spawn("claude", args, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            AGENT_TOWN_PORT: process.env.PORT ?? "3000",
            AGENT_TOWN_WORKERS: JSON.stringify(workerRoster),
            AGENT_TOWN_DISPATCH_SECRET: dispatchSecret,
          },
        });
      } catch (err) {
        finalizeError(`Failed to spawn claude: ${err.message}`);
        return;
      }

      state.runningProcesses.set(runId, child);

      // Feed the prompt via stdin to dodge arg-length / escaping limits.
      try {
        child.stdin.write(message);
        child.stdin.end();
      } catch {
        /* stdin may already be closed if spawn failed */
      }

      let stderr = "";
      let lineBuf = "";
      gotResult = false;
      resultText = "";
      resultErr = null;
      pendingTools.clear();

      child.stdout.on("data", (chunk) => {
        lineBuf += chunk.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() ?? "";
        for (const ln of lines) handleLine(ln);
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        state.runningProcesses.delete(runId);
        finalizeError(`claude process error: ${err.message}`);
      });

      child.on("close", (code) => {
        state.runningProcesses.delete(runId);
        if (lineBuf.trim()) handleLine(lineBuf);

        if (abortedRuns.has(runId)) {
          abortedRuns.delete(runId);
          if (!settled) {
            settled = true;
            resolve({ result: "", error: "aborted" });
          }
          return;
        }

        // Stale --resume: the stored session id no longer exists. Retry fresh.
        const sessionFailed =
          code !== 0 && /session|resume|no conversation|not found/i.test(stderr);
        if (sessionFailed && withResume) {
          log.warn(`Resume failed for "${sessionMapKey}" — dropping stale id, retrying fresh`);
          sessionMap.delete(sessionMapKey);
          persistSessions();
          attempt(false);
          return;
        }

        if (resultErr) {
          finalizeError(resultErr);
          return;
        }
        if (code !== 0 && !gotResult) {
          finalizeError(stderr.trim() || `claude exited with code ${code}`);
          return;
        }
        finalizeOk(resultText);
      });
    };

    // An explicit per-task workspace must resolve to a real directory before
    // we spawn — otherwise `claude` fails with an opaque ENOENT.
    if (workspace) {
      let isDir = false;
      try {
        isDir = statSync(cwd).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        finalizeError(`Workspace directory not found: ${cwd}`);
        return;
      }
    }

    attempt(true);
  });
}

// ── Request handlers ───────────────────────────────────

function handleChatSend(state, WebSocket, id, params) {
  const sessionKey = params.sessionKey ?? "default";
  const message = params.message ?? "";
  const runId = `claude_${Date.now()}_${++runCounter}`;

  sendResponse(state, WebSocket, id, true, { runId });

  void executeRun(state, WebSocket, {
    runId,
    sessionKey,
    sessionMapKey: sessionKey,
    message,
    model: typeof params.model === "string" && params.model ? params.model : getDefaultModel(),
    systemPrompt: buildSystemPrompt(params.seatLabel, params.seatRole),
    workspace: resolveWorkspace(params.workspace),
  });
}

function handleChatAbort(state, WebSocket, id, params) {
  const runId = params.runId;
  const sessionKey = params.sessionKey ?? "default";

  if (runId && state.runningProcesses.has(runId)) {
    abortedRuns.add(runId);
    state.runningProcesses.get(runId).kill("SIGTERM");
    state.runningProcesses.delete(runId);
    log.info(`Aborted run ${runId}`);
  }

  sendResponse(state, WebSocket, id, true, {});
  if (runId) {
    sendEvent(state, WebSocket, "chat", { runId, sessionKey, state: "aborted" });
  }
}

function handleSessionsList(state, WebSocket, id) {
  const sessions = [];
  for (const [key, u] of sessionUsage) {
    sessions.push({
      key,
      model: u.model,
      modelProvider: "anthropic",
      totalTokens: u.totalTokens,
      totalTokensFresh: true,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      contextTokens: u.contextWindow,
    });
  }
  sendResponse(state, WebSocket, id, true, { sessions });
}

function handleMessage(state, WebSocket, raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    log.warn("Received non-JSON message, ignoring");
    return;
  }
  if (frame.type !== "req") return;

  const { id, method, params } = frame;
  if (!id || !method) {
    log.warn("Request frame missing id or method");
    return;
  }
  log.debug(`Request: ${method} (id=${id})`);

  switch (method) {
    case "connect":
      sendResponse(state, WebSocket, id, true, {
        type: "hello-ok",
        scopes: ["operator.read", "operator.write"],
      });
      break;
    case "chat.send":
      handleChatSend(state, WebSocket, id, params ?? {});
      break;
    case "chat.abort":
      handleChatAbort(state, WebSocket, id, params ?? {});
      break;
    case "sessions.list":
      handleSessionsList(state, WebSocket, id);
      break;
    case "sessions.preview":
      sendResponse(state, WebSocket, id, true, { previews: [] });
      break;
    case "models.list":
      sendResponse(state, WebSocket, id, true, { models: MODEL_CATALOG });
      break;
    default:
      log.warn(`Unknown method: ${method}`);
      sendResponse(state, WebSocket, id, false, {
        code: "unknown_method",
        message: `Unknown method: ${method}`,
      });
      break;
  }
}

function cleanupClient(state) {
  if (activeClientState === state) activeClientState = null;
  for (const [runId, child] of state.runningProcesses) {
    log.info(`Killing orphaned process for run ${runId}`);
    child.kill("SIGTERM");
  }
  state.runningProcesses.clear();
}

// ── Public API ─────────────────────────────────────────

/**
 * Dispatch a task to a specific worker seat via a fresh `claude` process.
 * Emits subagent-style lifecycle events so the office animates the target seat.
 * @returns {Promise<{ result: string, error?: string }>}
 */
export function dispatchToWorker(seatId, task) {
  const state = activeClientState;
  const WS = activeWsClass;
  const seat = workerRoster.find((w) => w.seatId === seatId);

  if (!state || !WS || state.ws.readyState !== WS.OPEN) {
    return Promise.resolve({ result: "", error: "No active WebSocket client" });
  }
  if (!seat) {
    return Promise.resolve({ result: "", error: `Unknown seatId: ${seatId}` });
  }

  const runId = `claude_sub_${Date.now()}_${++runCounter}`;
  return executeRun(state, WS, {
    runId,
    sessionKey: `subagent:dispatch:${seatId}:${runId}`,
    sessionMapKey: `dispatch:${seatId}`,
    message: task,
    model: seat.model || getDefaultModel(),
    systemPrompt: buildSystemPrompt(seat.label, seat.roleTitle),
    subagent: { seatId, label: `${seat.label}: ${task.slice(0, 40)}` },
  });
}

/** Validate the dispatch secret presented by the MCP server. */
export function validateDispatchSecret(secret) {
  return secret === dispatchSecret;
}

/** Update the worker roster (called when seat configs change). */
export function setWorkerRoster(seats) {
  workerRoster = seats;
  mcpConfigPath = null; // regenerate on next dispatch
  log.debug(`Worker roster updated: ${seats.length} worker(s)`);
}

/**
 * Attach the Claude bridge WebSocket handler to an HTTP server.
 * @param {import("http").Server} server
 * @param {typeof import("ws").WebSocket} WebSocket
 * @param {typeof import("ws").WebSocketServer} WebSocketServer
 * @param {string} [path="/api/gateway"]
 */
export function attachClaudeBridge(server, WebSocket, WebSocketServer, path = "/api/gateway") {
  activeWsClass = WebSocket;

  if (!sessionsLoaded) {
    workspaceDir = process.env.CLAUDE_WORKSPACE_DIR ?? process.cwd();
    loadPersistedSessions();
    sessionsLoaded = true;
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== path) return;
    if (!checkOrigin(req, socket)) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      const state = { ws, seq: 0, runningProcesses: new Map() };
      activeClientState = state;

      log.info("Client connected");
      sendEvent(state, WebSocket, "connect.challenge", {});

      ws.on("message", (data) => handleMessage(state, WebSocket, data.toString()));
      ws.on("close", () => {
        log.info("Client disconnected");
        cleanupClient(state);
      });
      ws.on("error", (err) => {
        log.error("Client WS error:", err.message);
        cleanupClient(state);
      });
    });
  });

  wss.on("error", (err) => log.error("WebSocketServer error:", err.message));

  process.on("exit", () => {
    if (mcpConfigPath) {
      try {
        unlinkSync(mcpConfigPath);
      } catch {
        /* ignore */
      }
    }
  });

  log.info(`Claude bridge attached on ${path} — workspace ${getWorkspaceDir()}`);
}
