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

// ─── Session map: sessionId → { proc, sseRes, pending } ─────────────────────

const sessions = new Map();

// ─── Send a JSON-RPC request to the child and wait for its response ───────────

function rpcToChild(proc, pending, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`rpcToChild timeout: ${method}`));
      }
    }, 15000);
  });
}

// ─── SSE endpoint — Agent Builder opens a persistent connection here ─────────

app.get("/sse", async (req, res) => {
  const sessionId = randomUUID();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Session-Id", sessionId);
  res.flushHeaders();

  const proc = spawnMcpServer();
  const pending = new Map(); // id → resolve fn

  sessions.set(sessionId, { proc, sseRes: res, pending });

  // Forward MCP server stdout → SSE to client (and resolve pending calls)
  let buffer = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        // Resolve internal auto-connect call — never forward to client (has credentials)
        if (typeof msg.id === "string" && msg.id.startsWith("__")) {
          if (pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
          continue;
        }
        // All other messages (initialize responses, tool results, notifications)
        // flow back to the client via SSE — this is the MCP SSE transport spec
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      } catch { /* ignore non-JSON startup logs */ }
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

  // Send endpoint event FIRST — mcp/client/sse.py must receive this quickly
  // or it times out waiting. Auto-connect runs in background so it doesn't block.
  // mcp/client/sse.py does: endpoint_url = urljoin(base_url, sse.data)
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = `${proto}://${host}`;
  res.write(`event: endpoint\ndata: ${base}/message?sessionId=${sessionId}\n\n`);

  // Auto-connect to MongoDB in background — keeps URI server-side.
  // MongoDB connection is ready well before any real tool call comes in.
  rpcToChild(proc, pending, "__init_connect__", "tools/call", {
    name: "connect",
    arguments: { connectionStringOrClusterName: MDB_URI },
  })
    .then(() => console.log(`[${sessionId}] Auto-connected to MongoDB`))
    .catch((err) => console.error(`[${sessionId}] Auto-connect failed:`, err.message));
});

// ─── Message endpoint — client posts JSON-RPC here ──────────────────────────
//
// MCP SSE transport spec: POST /message returns 202 Accepted immediately.
// The actual JSON-RPC response flows back via the SSE stream.
// (We previously did synchronous HTTP response — wrong, breaks ADK & Agent Builder.)

app.post("/message", (req, res) => {
  const { sessionId } = req.query;
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const msg = req.body;
  session.proc.stdin.write(JSON.stringify(msg) + "\n");

  // Spec-compliant: acknowledge receipt, response comes via SSE
  res.status(202).end();
});

// ─── Health check ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "gemscout-mcp", partner: "@mongodb-js/mongodb-mcp-server" })
);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`GemScout MCP HTTP wrapper on :${PORT} (partner: @mongodb-js/mongodb-mcp-server)`)
);
