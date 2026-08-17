import Database from "bun:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Persistence: conversations + messages, keyed by a client-generated sessionId
// ---------------------------------------------------------------------------
const dbPath = process.env.DATABASE_URL || "./data/app.db";
mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
`);

const insertMsg = db.query(
  "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)"
);
const historyStmt = db.query(
  "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC"
);
const clearStmt = db.query("DELETE FROM messages WHERE session_id = ?");

// ---------------------------------------------------------------------------
// AI broker — credential is injected server-side by the platform.
// ---------------------------------------------------------------------------
const ai = new Anthropic({
  baseURL: process.env.SANTAI_AI_BASE_URL,
  apiKey: process.env.SANTAI_AI_TOKEN || "placeholder",
});
const MODEL = "anthropic-claude-bedrock4.5-haiku";
const SYSTEM_PROMPT =
  "You are a warm, sharp, genuinely helpful assistant. Keep replies concise and " +
  "conversational by default, expanding only when the question deserves depth. " +
  "Use light Markdown (short lists, **bold**, `code`) when it aids clarity. Never " +
  "invent facts — if unsure, say so.";

const publicDir = `${import.meta.dir}/public`;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

async function handleChat(req: Request): Promise<Response> {
  let body: { sessionId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const sessionId = (body.sessionId || "").trim();
  const message = (body.message || "").trim();
  if (!sessionId) return json({ error: "Missing sessionId." }, 400);
  if (!message) return json({ error: "Message cannot be empty." }, 400);
  if (message.length > 6000) return json({ error: "Message too long." }, 400);

  // Persist the user's turn, then build the running context for the model.
  insertMsg.run(sessionId, "user", message);
  const history = historyStmt.all(sessionId) as {
    role: "user" | "assistant";
    content: string;
  }[];

  if (!process.env.SANTAI_AI_TOKEN) {
    return json(
      { error: "AI is not configured in this environment yet." },
      503
    );
  }

  try {
    const resp = await ai.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
    });
    const reply =
      resp.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim() || "…";

    insertMsg.run(sessionId, "assistant", reply);
    return json({ reply });
  } catch (err) {
    console.error("AI call failed:", err);
    return json({ error: "The assistant is having trouble right now." }, 502);
  }
}

export default {
  port: process.env.PORT || 3000,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/chat" && req.method === "POST") {
      return handleChat(req);
    }

    if (url.pathname === "/api/history" && req.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") || "";
      if (!sessionId) return json({ messages: [] });
      const messages = historyStmt.all(sessionId);
      return json({ messages });
    }

    if (url.pathname === "/api/clear" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId") || "";
      if (sessionId) clearStmt.run(sessionId);
      return json({ ok: true });
    }

    // Static files
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${publicDir}${rel}`);
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },
};
