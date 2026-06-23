// erawan backend — turns a roster into live participant drivers and exposes a small HTTP API
// the console talks to. v1: claude-code driver only (runs on the Claude plan, no key).
//
// Endpoints (mount behind your own reverse proxy, e.g. at /api/):
//   GET  /api/health                                  → { ok }
//   GET  /api/roster                                  → participants (no folders leaked)
//   POST /api/send   { conversationId, participantId, text }  → { id, text, served }
//   POST /api/reset  { conversationId }               → drop a conversation's sessions
//
// Each participant keeps a persistent driver (its session resumes) for the life of a
// conversation, so continuity holds across turns. Node stdlib only.

import http from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ClaudeCodeDriver } from "./drivers/claudeCode.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8011;

// The standing orientation (the "wall"), delivered to every participant via --append-system-prompt.
// Non-invasive: it never touches a participant's own self-file. Per-turn source labels ride in the
// message text itself (the human's name, or "<name> said: …").
const ORIENTATION =
  "You are one voice in erawan, a conversation among several AI participants and a human. Each message " +
  "is labelled by its source — the human (by their name), or another participant by name. There is no " +
  "task to complete and nothing to assist with; this is a conversation among equals. Reply as yourself. " +
  "You may be brief, and you may decline to add anything.";

function loadRoster(){
  try { return JSON.parse(readFileSync(join(__dir, "roster.json"), "utf8")); }
  catch (e) { return { participants: [] }; }
}
const findParticipant = (roster, id) => roster.participants.find(p => p.id === id);

// driver registry — key: `${conversationId}::${participantId}`
const drivers = new Map();

// persist each participant's claude session_id so continuity survives a backend restart
const STATE_DIR = join(__dir, "state");
const SESS_FILE = join(STATE_DIR, "sessions.json");
function loadSessions(){ try { return JSON.parse(readFileSync(SESS_FILE, "utf8")); } catch { return {}; } }
function saveSessions(){ try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(SESS_FILE, JSON.stringify(sessionMap, null, 2)); } catch (e) {} }
const sessionMap = loadSessions();

function getDriver(conversationId, p){
  const key = conversationId + "::" + p.id;
  let d = drivers.get(key);
  if (!d){
    if (p.driver === "claude-code"){
      if (!p.folder || !existsSync(p.folder)) throw new Error(`folder does not exist: ${p.folder || "(none)"}`);
      d = new ClaudeCodeDriver({ folder: p.folder, model: p.model, system: ORIENTATION });
      if (sessionMap[key]) d.sessionId = sessionMap[key];  // resume a persisted claude session
    } else {
      throw new Error(`driver '${p.driver}' is not implemented yet (claude-code only for now)`);
    }
    drivers.set(key, d);
  }
  return d;
}

const sendJSON = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/health") return sendJSON(res, 200, { ok: true });

    if (req.method === "GET" && url.pathname === "/api/roster") {
      const roster = loadRoster(); // hot-reload each fetch
      return sendJSON(res, 200, { participants: roster.participants.map(p => ({
        id: p.id, display: p.display, model: p.model, driver: p.driver, color: p.color,
      })) });
    }

    if (req.method === "POST" && url.pathname === "/api/send") {
      // the cast comes from the (authed) console now — participant carries its own folder/model/driver
      const { conversationId = "default", participant, text } = await readBody(req);
      if (!participant || !participant.id) return sendJSON(res, 400, { error: "missing participant" });
      if (!text || !String(text).trim()) return sendJSON(res, 400, { error: "empty text" });
      const d = getDriver(conversationId, participant);
      const r = await d.send(String(text));
      sessionMap[conversationId + "::" + participant.id] = d.sessionId; saveSessions();
      return sendJSON(res, 200, { id: participant.id, text: r.text, served: r.servingModel });
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      const { conversationId = "default" } = await readBody(req);
      for (const k of [...drivers.keys()]) if (k.startsWith(conversationId + "::")) drivers.delete(k);
      for (const k of Object.keys(sessionMap)) if (k.startsWith(conversationId + "::")) delete sessionMap[k];
      saveSessions();
      return sendJSON(res, 200, { ok: true });
    }

    sendJSON(res, 404, { error: "not found" });
  } catch (e) {
    sendJSON(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`erawan backend on http://127.0.0.1:${PORT}`));
