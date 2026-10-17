import http from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_FILES = {
  "/": ["ui.html", "text/html; charset=utf-8"],
  "/index.html": ["ui.html", "text/html; charset=utf-8"],
  "/app.js": ["ui.js", "text/javascript; charset=utf-8"],
  "/app.css": ["ui.css", "text/css; charset=utf-8"],
}

const DEFAULT_PORT = 4777
const MAX_BODY_BYTES = 64 * 1024
const MAX_PROMPT_CHARS = 32 * 1024
const HEARTBEAT_MS = 15_000

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".local", "share", "opencode-remote-player")
let DATA_DIR = DEFAULT_DATA_DIR
let STATE_FILE = path.join(DATA_DIR, "state.json")
let RUNTIME_FILE = path.join(DATA_DIR, "runtime.json")
let LOG_FILE = path.join(DATA_DIR, "remote-player.log")

function configureDataDir(dir) {
  DATA_DIR = dir
  STATE_FILE = path.join(dir, "state.json")
  RUNTIME_FILE = path.join(dir, "runtime.json")
  LOG_FILE = path.join(dir, "remote-player.log")
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function securityHeaders() {
  return {
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cache-Control": "no-store",
  }
}

async function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    console.log(`[remote-player] ${message}`)
  } catch {}
  try {
    await mkdir(DATA_DIR, { recursive: true })
    await appendFile(LOG_FILE, line, "utf8")
  } catch {}
}

function errorText(error) {
  if (error === undefined || error === null) return "Unknown error"
  if (typeof error === "string") return error
  const err = error.error ?? error
  if (err && typeof err === "object" && err.name && err.data) {
    const data = err.data
    switch (err.name) {
      case "APIError":
        return `${data.message || "API error"}${data.statusCode ? ` (HTTP ${data.statusCode})` : ""}`
      case "ProviderAuthError":
        return `Provider authentication failed (${data.providerID || "unknown"}): ${data.message || "unauthorized"}`
      case "MessageOutputLengthError":
        return "Model output length limit reached"
      case "MessageAbortedError":
        return "Request aborted"
      default:
        return data.message || err.name
    }
  }
  if (err && typeof err === "object" && err.message) return err.message
  return String(err)
}

function unwrap(result) {
  if (result && typeof result === "object" && "request" in result && "response" in result) {
    if (result.error) throw result.error
    return result.data
  }
  return result
}

function opencodeAuthHeaders() {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return {}
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode"
  const encoded = Buffer.from(`${username}:${password}`).toString("base64")
  return { Authorization: `Basic ${encoded}` }
}

function existingClientHeaders(client) {
  try {
    const config = client?._client?.getConfig?.()
    const headers = config?.headers
    if (!headers) return {}
    const out = {}
    if (typeof headers.forEach === "function") {
      headers.forEach((value, key) => {
        out[key] = value
      })
    } else {
      Object.assign(out, headers)
    }
    delete out["x-opencode-directory"]
    delete out["X-Opencode-Directory"]
    return out
  } catch {
    return {}
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
  })
  res.end(data)
}

async function readJson(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase()
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json")
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large")
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new HttpError(400, "Invalid JSON body")
  }
}

export async function startRemotePlayer(input, options = {}) {
  configureDataDir(
    options.dataDir ||
      process.env.OPENCODE_REMOTE_PLAYER_DATA_DIR ||
      DEFAULT_DATA_DIR,
  )

  const requestedPort = Number(options.port ?? process.env.OPENCODE_REMOTE_PLAYER_PORT ?? DEFAULT_PORT)
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`Invalid port: ${requestedPort}`)
  }

  const token =
    options.token ??
    process.env.OPENCODE_REMOTE_PLAYER_TOKEN ??
    randomBytes(32).toString("base64url")

  const serverUrl = String(input.serverUrl)
  const opencodeHeaders = {
    ...existingClientHeaders(input.client),
    ...opencodeAuthHeaders(),
  }
  const globalClient = createOpencodeClient({ baseUrl: serverUrl, headers: opencodeHeaders })

  let boundPort = requestedPort
  const state = {
    globalClient,
    projects: [],
    activeProjectId: null,
    activeClient: null,
    sessionByProject: new Map(),
    sessionId: null,
    busy: false,
    request: null,
    clients: new Map(),
    stopping: false,
  }

  let stopStream = null

  function publicState() {
    const active = state.projects.find((p) => p.id === state.activeProjectId) || null
    return {
      projects: state.projects.map((p) => ({ id: p.id, worktree: p.worktree })),
      activeProjectId: state.activeProjectId,
      activeProject: active ? { id: active.id, worktree: active.worktree } : null,
      busy: state.busy,
      sessionId: state.sessionId,
      text: state.request ? state.request.text : "",
    }
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of state.clients.keys()) {
      try {
        res.write(frame)
      } catch {
        removeClient(res)
      }
    }
  }

  function removeClient(res) {
    const cleanup = state.clients.get(res)
    if (cleanup) cleanup()
    state.clients.delete(res)
  }

  function clientFor(project) {
    return createOpencodeClient({
      baseUrl: serverUrl,
      directory: project.worktree,
      headers: opencodeHeaders,
    })
  }

  async function persistState() {
    try {
      await mkdir(DATA_DIR, { recursive: true })
      await writeFile(
        STATE_FILE,
        JSON.stringify({ activeProjectId: state.activeProjectId }, null, 2),
        "utf8",
      )
    } catch {}
  }

  async function loadState() {
    try {
      const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"))
      if (typeof parsed.activeProjectId === "string") state.activeProjectId = parsed.activeProjectId
    } catch {}
  }

  async function writeRuntime() {
    await mkdir(DATA_DIR, { recursive: true })
    await writeFile(
      RUNTIME_FILE,
      JSON.stringify(
        {
          url: `http://127.0.0.1:${boundPort}`,
          token,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          log: LOG_FILE,
        },
        null,
        2,
      ),
      "utf8",
    )
  }

  async function refreshProjects() {
    const projects = unwrap(await state.globalClient.project.list({ signal: AbortSignal.timeout(10_000) }))
    if (!Array.isArray(projects)) throw new Error("Invalid project list from OpenCode")
    state.projects = projects
      .filter((p) => p && typeof p.id === "string" && typeof p.worktree === "string")
      .sort((a, b) => a.worktree.localeCompare(b.worktree))
    if (state.activeProjectId && !state.projects.some((p) => p.id === state.activeProjectId)) {
      state.activeProjectId = null
      state.activeClient = null
      state.sessionId = null
    }
    if (!state.activeProjectId && state.projects.length === 1) {
      state.activeProjectId = state.projects[0].id
      state.activeClient = clientFor(state.projects[0])
      await persistState()
    }
  }

  async function selectProject(projectId) {
    if (state.busy) throw new HttpError(409, "Cannot switch projects while a request is running")
    const project = state.projects.find((p) => p.id === projectId)
    if (!project) throw new HttpError(404, "Unknown project")
    if (state.activeProjectId !== projectId) {
      state.activeProjectId = projectId
      state.activeClient = clientFor(project)
      state.sessionId = state.sessionByProject.get(projectId) || null
    }
    await persistState()
    broadcast("state", publicState())
    return publicState()
  }

  async function ensureSession() {
    if (!state.activeProjectId || !state.activeClient) throw new HttpError(400, "Select a project first")
    if (state.sessionId) return state.sessionId
    const session = unwrap(
      await state.activeClient.session.create({ body: { title: "Remote Player" } }),
    )
    if (!session || typeof session.id !== "string") throw new Error("Failed to create OpenCode session")
    state.sessionId = session.id
    state.sessionByProject.set(state.activeProjectId, session.id)
    return session.id
  }

  function emitError(error, kind) {
    const message = errorText(error)
    const request = state.request
    if (!request) {
      broadcast("error", { message, kind })
      return
    }
    if (!request.errors) request.errors = new Set()
    if (request.errors.has(message)) return
    request.errors.add(message)
    broadcast("error", { message, kind })
    if (!request.errorTimer) {
      request.errorTimer = setTimeout(() => {
        if (state.request === request) finishRequest("error")
      }, 1_500)
      request.errorTimer.unref?.()
    }
  }

  function finishRequest(reason) {
    const request = state.request
    if (!request) return
    if (request.errorTimer) clearTimeout(request.errorTimer)
    state.request = null
    state.busy = false
    if (reason === "aborted") broadcast("aborted", { text: request.text })
    else broadcast("done", { text: request.text, reason })
    broadcast("status", { status: "idle" })
  }

  function handleGlobalEvent(event) {
    const payload = event && typeof event === "object" ? event.payload ?? event : null
    if (!payload) return
    const request = state.request
    if (!request) return

    switch (payload.type) {
      case "message.updated": {
        const info = payload.properties?.info
        if (!info || info.sessionID !== request.sessionId) return
        if (info.role === "user") {
          request.userMessageIds.add(info.id)
        } else if (info.role === "assistant") {
          request.assistantMessageIds.add(info.id)
          if (info.error) emitError(info.error, "assistant")
        }
        return
      }
      case "message.part.updated": {
        const part = payload.properties?.part
        if (!part || part.sessionID !== request.sessionId) return
        if (part.type !== "text") return
        if (part.synthetic) return
        if (request.userMessageIds.has(part.messageID)) return
        if (!request.assistantMessageIds.has(part.messageID)) {
          request.assistantMessageIds.add(part.messageID)
        }
        const full = typeof part.text === "string" ? part.text : ""
        const previous = request.partText.get(part.id) || ""
        const delta = full.startsWith(previous) ? full.slice(previous.length) : full
        request.partText.set(part.id, full)
        if (delta) {
          request.text += delta
          broadcast("delta", { text: delta })
        }
        return
      }
      case "session.status": {
        const properties = payload.properties
        if (!properties || properties.sessionID !== request.sessionId) return
        const status = properties.status
        if (status?.type === "retry") {
          broadcast("retry", {
            attempt: status.attempt,
            message: status.message,
            next: status.next,
          })
        } else if (status?.type === "idle") {
          finishRequest("done")
        }
        return
      }
      case "session.idle": {
        if (payload.properties?.sessionID === request.sessionId) finishRequest("done")
        return
      }
      case "session.error": {
        const properties = payload.properties || {}
        if (properties.sessionID && properties.sessionID !== request.sessionId) return
        if (properties.error) emitError(properties.error, "session")
        return
      }
      default:
        return
    }
  }

  async function subscribeLoop() {
    const controller = new AbortController()
    stopStream = () => controller.abort()
    while (!state.stopping) {
      try {
        const { stream } = await state.globalClient.global.event({ signal: controller.signal })
        for await (const event of stream) {
          if (state.stopping) return
          handleGlobalEvent(event)
        }
      } catch (error) {
        if (state.stopping || controller.signal.aborted) return
        await logLine(`event stream error: ${errorText(error)}`)
      }
      if (state.stopping) return
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }

  async function startPrompt(text) {
    if (state.busy) throw new HttpError(409, "A request is already running")
    if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Prompt is empty")
    if (text.length > MAX_PROMPT_CHARS) throw new HttpError(413, "Prompt is too long")
    const sessionId = await ensureSession()

    const request = {
      id: randomBytes(8).toString("hex"),
      sessionId,
      userMessageIds: new Set(),
      assistantMessageIds: new Set(),
      partText: new Map(),
      text: "",
      aborted: false,
      errors: new Set(),
      errorTimer: null,
    }
    state.busy = true
    state.request = request
    broadcast("status", { status: "busy" })

    try {
      unwrap(
        await state.activeClient.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text }] },
        }),
      )
    } catch (error) {
      state.busy = false
      state.request = null
      const message = errorText(error)
      broadcast("error", { message, kind: "prompt" })
      broadcast("status", { status: "idle" })
      throw new HttpError(502, message)
    }

    return request.id
  }

  async function abortRequest() {
    const request = state.request
    if (!request) return false
    request.aborted = true
    try {
      unwrap(await state.activeClient.session.abort({ path: { id: request.sessionId } }))
    } catch (error) {
      emitError(error, "abort")
    }
    finishRequest("aborted")
    return true
  }

  async function serveFile(res, fileName, contentType) {
    const body = await readFile(path.join(HERE, fileName))
    res.writeHead(200, { ...securityHeaders(), "Content-Type": contentType })
    res.end(body)
  }

  function openEvents(req, res) {
    res.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    res.write("retry: 1500\n\n")

    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n")
      } catch {
        removeClient(res)
      }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()

    const cleanup = () => {
      clearInterval(heartbeat)
      state.clients.delete(res)
    }
    state.clients.set(res, cleanup)

    req.on("close", cleanup)
    req.on("error", cleanup)
    res.on("error", cleanup)

    try {
      res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`)
    } catch {
      cleanup()
    }
  }

  function hostAllowed(req) {
    const host = String(req.headers.host || "").toLowerCase()
    return host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}`
  }

  function originAllowed(req) {
    const origin = req.headers.origin
    if (!origin) return true
    return origin === `http://127.0.0.1:${boundPort}` || origin === `http://localhost:${boundPort}`
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req)) {
        res.writeHead(421, securityHeaders())
        res.end("Misdirected Request")
        return
      }

      const url = new URL(req.url || "/", `http://127.0.0.1:${boundPort}`)
      const pathname = url.pathname
      const method = req.method || "GET"

      if (method === "GET" && Object.hasOwn(UI_FILES, pathname)) {
        const [fileName, contentType] = UI_FILES[pathname]
        await serveFile(res, fileName, contentType)
        return
      }
      if (pathname === "/favicon.ico") {
        res.writeHead(204, securityHeaders())
        res.end()
        return
      }
      if (pathname === "/api/health") {
        sendJson(res, 200, { ok: true })
        return
      }
      if (!pathname.startsWith("/api/")) {
        sendJson(res, 404, { message: "Not found" })
        return
      }
      if (!originAllowed(req)) {
        sendJson(res, 403, { message: "Forbidden origin" })
        return
      }
      if (!authorized(req)) {
        sendJson(res, 401, { message: "Unauthorized" })
        return
      }

      if (pathname === "/api/state" && method === "GET") {
        try {
          await refreshProjects()
        } catch (error) {
          await logLine(`project refresh failed: ${errorText(error)}`)
        }
        sendJson(res, 200, publicState())
        return
      }
      if (pathname === "/api/projects" && method === "GET") {
        await refreshProjects()
        sendJson(res, 200, { projects: publicState().projects })
        return
      }
      if (pathname === "/api/projects/select" && method === "POST") {
        const body = await readJson(req)
        if (typeof body.projectId !== "string" || !body.projectId) {
          throw new HttpError(400, "projectId is required")
        }
        const next = await selectProject(body.projectId)
        sendJson(res, 200, next)
        return
      }
      if (pathname === "/api/prompt" && method === "POST") {
        if (!state.activeProjectId) throw new HttpError(400, "Select a project first")
        const body = await readJson(req)
        const requestId = await startPrompt(body.text)
        sendJson(res, 202, { requestId })
        return
      }
      if (pathname === "/api/abort" && method === "POST") {
        const aborted = await abortRequest()
        sendJson(res, 200, { aborted })
        return
      }
      if (pathname === "/api/events" && method === "GET") {
        openEvents(req, res)
        return
      }

      sendJson(res, 404, { message: "Not found" })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (status === 500) await logLine(`request error: ${error?.stack || errorText(error)}`)
      if (!res.headersSent) {
        sendJson(res, status, { message: errorText(error) })
      } else {
        try {
          res.end()
        } catch {}
      }
    }
  })

  function authorized(req) {
    const header = String(req.headers.authorization || "")
    const match = /^Bearer (.+)$/.exec(header)
    if (!match) return false
    const provided = Buffer.from(match[1])
    const expected = Buffer.from(token)
    return provided.length === expected.length && timingSafeEqual(provided, expected)
  }

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        server.off("error", onError)
        resolve()
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(requestedPort, "127.0.0.1")
    })
  } catch (error) {
    if (error && error.code === "EADDRINUSE") {
      await logLine(
        `port ${requestedPort} is already in use; another OpenCode Remote Player instance is probably running`,
      )
      return {
        hooks: {},
        url: `http://127.0.0.1:${requestedPort}`,
        token: null,
        port: requestedPort,
        close: async () => {},
      }
    }
    throw error
  }

  boundPort = server.address().port
  await mkdir(DATA_DIR, { recursive: true })
  await loadState()
  await writeRuntime()
  await logLine(
    `listening on http://127.0.0.1:${boundPort}#${token} (token also in ${RUNTIME_FILE})`,
  )

  try {
    await refreshProjects()
  } catch (error) {
    await logLine(`initial project refresh failed: ${errorText(error)}`)
  }

  if (state.activeProjectId) {
    const project = state.projects.find((p) => p.id === state.activeProjectId)
    if (project) {
      state.activeClient = clientFor(project)
      state.sessionId = state.sessionByProject.get(project.id) || null
    }
  }

  subscribeLoop().catch((error) => logLine(`event subscription stopped: ${errorText(error)}`))

  const hooks = {
    dispose: async () => {
      if (state.stopping) return
      state.stopping = true
      try {
        stopStream?.()
      } catch {}
      for (const res of [...state.clients.keys()]) {
        try {
          removeClient(res)
          res.end()
        } catch {}
      }
      state.clients.clear()
      await new Promise((resolve) => server.close(() => resolve()))
      await logLine("stopped")
    },
  }

  return {
    hooks,
    url: `http://127.0.0.1:${boundPort}`,
    token,
    port: boundPort,
    close: hooks.dispose,
  }
}

export default async function remotePlayerPlugin(input) {
  const result = await startRemotePlayer(input)
  return result.hooks
}
