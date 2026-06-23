// ClaudeCodeDriver — drives one erawan participant through the `claude` CLI.
//
// One implementation of the ParticipantDriver contract the backend depends on:
//   start()                 — lazy; a session opens on the first send
//   send(text, onDelta?)    — deliver a message; returns { text, servingModel, sessionId }
//   servingModel            — which model actually answered (the seat-witness)
//   stop()
//
// In v2 a participant's *speech is its reply*: we capture the model's response and the
// backend routes it. No shared file to append to. Orientation rides in `system`
// (an --append-system-prompt), so a participant's own self-file (CLAUDE.md) is never touched.
//
// Runs on the local Claude plan (no API key). Node stdlib only.

import { spawn } from "node:child_process";
import readline from "node:readline";

const KNOCK_TIMEOUT_MS = 180_000;

export class ClaudeCodeDriver {
  constructor({ folder, model, system = null, skipPermissions = false }) {
    this.driver = "claude-code";
    this.folder = folder;          // the participant's self-folder (cwd; its CLAUDE.md auto-loads)
    this.model = model;            // alias: opus | sonnet | haiku | fable, or a full id
    this.system = system;          // per-turn situational framing (never written to disk)
    this.skipPermissions = skipPermissions; // opt-in: run with --dangerously-skip-permissions (no prompts, no allowlist)
    this.sessionId = null;         // captured on first reply; resumed thereafter
    this.servingModel = null;      // from .modelUsage — flags a silent reroute
  }

  start() { /* lazy — the session opens on first send */ }

  // Deliver one message; resolve with the participant's reply + metadata.
  // onDelta(textChunk) is called as assistant content arrives (whole-message granularity).
  send(text, onDelta = null) {
    return new Promise((resolve, reject) => {
      const args = ["-p", "--model", this.model, "--output-format", "stream-json", "--verbose"];
      if (this.skipPermissions) args.push("--dangerously-skip-permissions");
      if (this.system) args.push("--append-system-prompt", this.system);
      if (this.sessionId) args.push("--resume", this.sessionId);
      args.push(text);

      const proc = spawn("claude", args, { cwd: this.folder, stdio: ["ignore", "pipe", "pipe"] });

      let finalText = "";
      let streamed = "";   // concatenated from assistant events (fallback / liveness)
      let err = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill("SIGKILL");
        reject(new Error(`claude-code timed out after ${KNOCK_TIMEOUT_MS}ms`));
      }, KNOCK_TIMEOUT_MS);

      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let ev;
        try { ev = JSON.parse(line); } catch { return; }

        if (ev.type === "assistant" && ev.message?.content) {
          const t = ev.message.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("");
          if (t) { streamed += t; if (onDelta) onDelta(t); }
        } else if (ev.type === "result") {
          if (typeof ev.result === "string") finalText = ev.result;
          if (ev.session_id) this.sessionId = ev.session_id;
          if (ev.modelUsage) this.servingModel = Object.keys(ev.modelUsage)[0] || this.servingModel;
        }
      });

      proc.stderr.on("data", (d) => (err += d));
      proc.on("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const text = finalText || streamed;
        if (code !== 0 && !text) {
          reject(new Error(`claude-code exited ${code}: ${err.slice(0, 300)}`));
        } else {
          resolve({ text, servingModel: this.servingModel, sessionId: this.sessionId });
        }
      });
    });
  }

  stop() { /* nothing persistent to tear down — each send is its own process */ }
}
