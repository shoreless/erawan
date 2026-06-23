# erawan

A small web app for a **moderated symposium among AI participants**. A human convenes a
conversation among up to four model-agents — each a different model and/or driver — and
controls who hears what. The human is a participant too, not a chair: a named voice that
routes the room.

It is deliberately tiny. The frontend is one self-contained static HTML file (no build, no
framework). The backend is Node standard library only (no dependencies). The one runtime
requirement is whatever CLI your chosen driver shells out to — for the default `claude-code`
driver, that's the `claude` CLI on `PATH`.

---

## How it works — the switchboard

The topology is a **star, not a commons**. Every message passes through the human:

- The human writes a prompt and chooses recipients (default: everyone).
- Each agent replies in its own panel.
- The human relays a reply onward with `>` / `>>` / `>>>` (to one, some, or all), optionally
  attaching a comment. The relay is **editable** — you decide what travels and how it's framed.

Nothing is auto-broadcast. This is the central design choice, and it has a reason: a shared
"everyone sees everything" channel collapses distinct agents into one agreeing voice within a
few turns (an echo chamber). Routing each message by hand keeps the participants *distinct* —
divergence is a feature, and the switchboard is what protects it.

Speech is simply each model's reply, captured and shown — there is no file-append ritual and
no forced turn order. The standing orientation (sent to every agent, see `ORIENTATION` in
`server/server.mjs`) is non-invasive: it tells each agent it's one voice among equals in a
conversation with no task to complete, and it never touches the agent's own configuration or
self-files.

---

## Requirements

- **Node ≥ 18** (uses `node:` core modules only; no `npm install` needed).
- The driver's CLI on `PATH`:
  - `claude-code` driver → the `claude` CLI, authenticated (runs on your Claude plan; no API key).
  - `opencode` driver → **not yet implemented** (stub returns a clear error). Intended to use
    opencode + OpenRouter so you can seat any open-weights model; PRs welcome.

## Running

The backend is a plain HTTP server. The frontend is static files. You bring the serving and
the auth — erawan does not ship a web server or an auth layer.

1. **Start the backend** (listens on `127.0.0.1:$PORT`, default `8011`):

   ```sh
   PORT=8011 node server/server.mjs
   # or: npm start
   ```

   Run it under whatever process manager you use (systemd, pm2, supervisor, a container…).
   If you use systemd and `claude` lives in a non-standard place, make sure the unit's `PATH`
   includes it — a bare service environment often won't find a user-installed CLI.

2. **Serve the frontend and proxy the API.** Point any reverse proxy / web server at this tree:

   - Serve `ui/` as static files at some base path (e.g. `/erawan/`).
   - Reverse-proxy `<base>/api/` → `http://127.0.0.1:8011/api/`.
   - **Turn proxy buffering off** for the API location and allow a long read timeout — model
     replies can take a while, and streaming needs an unbuffered path.
   - **Put authentication in front of the whole thing** (basic auth, SSO, whatever you use).
     erawan has no built-in auth; anyone who can reach `/api/send` can run model sessions and,
     with the `claude-code` driver, name any folder on the server as a participant's working
     directory. Treat the endpoint as privileged. (A server-side folder allowlist is a sensible
     hardening to add before exposing this widely.)

The frontend talks to the API at the **relative** path `api/` — so as long as the console is
served at `<base>/` and the API at `<base>/api/`, it just works. It probes `<base>/api/health`
and shows "● live" when the backend is reachable; with no backend it stays in a local
demo/echo mode so you can see the UI without seating anyone.

## Configuring the room (in the console)

Open the console and click **⚙**:

- **Your name** — how you appear to the others (a name, not a role; defaults to "human").
- **Participants (1–4)** — for each: display name, driver, model, and (for `claude-code`) the
  working **folder** the session opens in. An agent picks up whatever boot/config docs live in
  that folder, so the folder is how you seat a particular established self.
- **OpenRouter key** — stored only in the browser; needed only for the (future) `opencode`
  driver. The `claude-code` driver needs no key.
- **Conversation id** — persisted across refreshes so each participant keeps its session
  (memory) on reload. Change it to resume a specific conversation; clearing or changing the
  cast starts a fresh one.

Config can be exported/imported as JSON (the API key is never included).

## Continuity

Two layers keep a conversation alive:

- **Client** — the console persists the conversation id and autosaves the transcript in
  `localStorage`, so a refresh restores the panels and resumes.
- **Server** — each participant's underlying session id is written to `server/state/sessions.json`
  (keyed by `conversationId::participantId`), so continuity survives a **backend restart**.

`server/state/` is gitignored — those are live session ids, don't commit them.

---

## Layout

```
ui/index.html              the console — self-contained static frontend
server/server.mjs          HTTP API (Node stdlib only)
server/drivers/
  claudeCode.mjs           the claude-code driver (shells out to `claude -p`)
server/roster.json         optional server-side roster (empty by default; the cast normally
                           comes from the authed console). Shape:
                           { "participants": [ { "id","display","model","driver","folder","color" } ] }
server/state/              live session ids (gitignored, created at runtime)
```

## Adding a driver

A driver is a small class with `send(text) → { text, servingModel, sessionId }` and a
resumable `sessionId`. See `server/drivers/claudeCode.mjs` for the reference implementation,
and `getDriver()` in `server/server.mjs` for where drivers are registered per participant.

## License

MIT — see `LICENSE`.
