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
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
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

// ---- server-side chat history (opt-in; browser keeps its own autosave as a backup) ----
// Relative folders resolve against the erawan install root; absolute folders are used as-is.
const ROOT = dirname(__dir);
const resolveHistoryDir = (folder) => {
  const f = (folder && String(folder).trim()) || "server/history";
  return isAbsolute(f) ? f : join(ROOT, f);
};
// strip anything that could escape the folder — conversation ids can be human-set
const safeName = (id) => (String(id || "default").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "default");
function historyMarkdown(p){
  const name = {}; (p.cast || []).forEach(c => { if (c.id) name[c.id] = c.display; });
  const dn = (id) => name[id] || id;
  const cast = (p.cast || []).map(c => c.display + (c.model ? ` (${c.model})` : "")).join(" · ");
  let md = `# erawan — ${p.title || p.conversationId}\n\n_${p.updatedAt}_\n\n`;
  if (cast) md += `**Cast:** ${cast}\n\n`;
  md += `---\n\n`;
  for (const e of (p.transcript || [])){
    if (e.type === "prompt") md += `**${e.from || "human"} → ${(e.to || []).map(dn).join(", ")}**\n${e.text}\n\n`;
    else if (e.type === "reply") md += `**${e.display || dn(e.by)}**\n${e.text}\n\n`;
    else if (e.type === "route"){ md += `**relays ${e.fromDisplay} → ${(e.to || []).map(dn).join(", ")}**\n> ${String(e.text).replace(/\n/g, "\n> ")}\n`; if (e.comment) md += `\n*${e.comment}*\n`; md += `\n`; }
  }
  return md;
}

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
      // the cast comes from the (authed) console now — participant carries its own folder/model/driver.
      // orientation + dangerouslySkipPermissions are room-wide, set in the console and applied per send.
      const { conversationId = "default", participant, text, orientation, dangerouslySkipPermissions } = await readBody(req);
      if (!participant || !participant.id) return sendJSON(res, 400, { error: "missing participant" });
      if (!text || !String(text).trim()) return sendJSON(res, 400, { error: "empty text" });
      const d = getDriver(conversationId, participant);
      // a non-empty orientation overrides the default wall; empty/missing keeps ORIENTATION
      if (typeof orientation === "string" && orientation.trim()) d.system = orientation;
      d.skipPermissions = !!dangerouslySkipPermissions;
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

    // ---- chat history (opt-in, browser is the backup) ----
    if (req.method === "POST" && url.pathname === "/api/history/save") {
      const { conversationId = "default", folder, transcript = [], cast = [], title = "", config = null } = await readBody(req);
      if (!Array.isArray(transcript)) return sendJSON(res, 400, { error: "transcript must be an array" });
      const dir = resolveHistoryDir(folder);
      mkdirSync(dir, { recursive: true });
      const base = join(dir, safeName(conversationId));
      // config (cast for reopening a named save) is stored as sent — the client strips any API key before sending
      const payload = { format: "erawan-history", version: 1, conversationId, title, updatedAt: new Date().toISOString(), cast, config, transcript };
      writeFileSync(base + ".json", JSON.stringify(payload, null, 2));
      writeFileSync(base + ".md", historyMarkdown(payload));
      return sendJSON(res, 200, { ok: true, path: base + ".json", entries: transcript.length });
    }

    if (req.method === "GET" && url.pathname === "/api/history/load") {
      const file = join(resolveHistoryDir(url.searchParams.get("folder") || ""), safeName(url.searchParams.get("conversationId") || "default") + ".json");
      if (!existsSync(file)) return sendJSON(res, 404, { error: "not found" });
      return sendJSON(res, 200, JSON.parse(readFileSync(file, "utf8")));
    }

    if (req.method === "POST" && url.pathname === "/api/history/delete") {
      const { conversationId = "default", folder } = await readBody(req);
      const base = join(resolveHistoryDir(folder), safeName(conversationId));
      for (const ext of [".json", ".md"]) { try { if (existsSync(base + ext)) unlinkSync(base + ext); } catch (e) {} }
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/history/list") {
      const dir = resolveHistoryDir(url.searchParams.get("folder") || "");
      if (!existsSync(dir)) return sendJSON(res, 200, { conversations: [] });
      const conversations = readdirSync(dir).filter(f => f.endsWith(".json")).map(f => {
        try { const d = JSON.parse(readFileSync(join(dir, f), "utf8")); return { conversationId: d.conversationId, title: d.title, updatedAt: d.updatedAt, entries: (d.transcript || []).length }; }
        catch { return null; }
      }).filter(Boolean);
      return sendJSON(res, 200, { conversations });
    }

    sendJSON(res, 404, { error: "not found" });
  } catch (e) {
    sendJSON(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`erawan backend on http://127.0.0.1:${PORT}`));
