/**
 * GemScout MCP HTTP wrapper
 *
 * Starts the official @mongodb-js/mongodb-mcp-server (stdio) as a child
 * process and exposes it over HTTP so Google Cloud Agent Builder can reach it.
 *
 * The MongoDB partner MCP server handles ALL database operations.
 * This file only does transport adaptation: stdio ↔ HTTP/SSE.
 */

import express from "express";
import { spawn } from "child_process";
import { randomUUID } from "crypto";

const app = express();
app.use(express.json());

const MDB_URI = process.env.MONGODB_URI;
const MDB_DB  = process.env.MONGODB_DB || "gemscout";

if (!MDB_URI) throw new Error("MONGODB_URI env var required");

// ─── Spawn the official MongoDB MCP server ──────────────────────────────────

function spawnMcpServer() {
  const proc = spawn(
    "node",
    ["node_modules/@mongodb-js/mongodb-mcp-server/dist/index.js"],
    {
      env: {
        ...process.env,
        MDB_MCP_CONNECTION_STRING: MDB_URI,
        MDB_MCP_DEFAULT_DB:        MDB_DB,
        MDB_MCP_TELEMETRY_DISABLED: "true",
      },
      stdio: ["pipe", "pipe", "inherit"],
    }
  );
  return proc;
}

// ─── Session map: sessionId → { proc, sseRes, pendingCallbacks } ─────────────

const sessions = new Map();

// ─── SSE endpoint — Agent Builder opens a persistent connection here ─────────

app.get("/sse", (req, res) => {
  const sessionId = randomUUID();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Session-Id", sessionId);
  res.flushHeaders();

  const proc = spawnMcpServer();
  const pending = new Map(); // id → resolve

  sessions.set(sessionId, { proc, sseRes: res, pending });

  // Forward MCP server stdout → SSE to client
  let buffer = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        // MCP notifications or responses
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
        // Resolve pending RPC call
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        // ignore non-JSON lines (e.g. startup log)
      }
    }
  });

  proc.on("exit", () => {
    sessions.delete(sessionId);
    res.end();
  });

  req.on("close", () => {
    proc.kill();
    sessions.delete(sessionId);
  });

  // Send endpoint info so client knows where to POST messages
  res.write(`event: endpoint\ndata: ${JSON.stringify({ sessionId, messageUrl: `/message?sessionId=${sessionId}` })}\n\n`);
});

// ─── Message endpoint — Agent Builder posts JSON-RPC here ───────────────────

app.post("/message", (req, res) => {
  const { sessionId } = req.query;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const msg = req.body;
  session.proc.stdin.write(JSON.stringify(msg) + "\n");

  // For method calls, wait for response
  if (msg.method && msg.id != null) {
    session.pending.set(msg.id, (response) => res.json(response));
    setTimeout(() => {
      if (session.pending.has(msg.id)) {
        session.pending.delete(msg.id);
        res.status(504).json({ error: "timeout" });
      }
    }, 30000);
  } else {
    res.json({ ok: true });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "gemscout-mcp", partner: "@mongodb-js/mongodb-mcp-server" })
);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`GemScout MCP HTTP wrapper on :${PORT} (partner: @mongodb-js/mongodb-mcp-server)`)
);
