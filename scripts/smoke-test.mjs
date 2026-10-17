import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { startMockOpencode } from "./mock-opencode.mjs"
import { startRemotePlayer } from "../src/server.js"

const TOKEN = "test-token-0123456789"

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseFrame(frame) {
  let event = "message"
  const dataLines = []
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
  }
  let data = null
  if (dataLines.length) {
    try {
      data = JSON.parse(dataLines.join("\n"))
    } catch {
      data = dataLines.join("\n")
    }
  }
  return { event, data }
}

class SseReader {
  constructor(response) {
    this.reader = response.body.getReader()
    this.decoder = new TextDecoder()
    this.buffer = ""
  }

  async next(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const index = this.buffer.indexOf("\n\n")
      if (index >= 0) {
        const frame = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 2)
        return parseFrame(frame)
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error("SSE read timeout")
      const result = await Promise.race([
        this.reader.read(),
        sleep(remaining).then(() => ({ timedOut: true })),
      ])
      if (result.timedOut) throw new Error("SSE read timeout")
      if (result.done) return null
      this.buffer += this.decoder.decode(result.value, { stream: true })
    }
  }

  async until(predicate, timeoutMs = 5000) {
    const collected = []
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const event = await this.next(deadline - Date.now())
      if (!event) break
      collected.push(event)
      if (predicate(event, collected)) return collected
    }
    throw new Error(`SSE condition not met: ${JSON.stringify(collected)}`)
  }

  close() {
    try {
      this.reader.cancel()
    } catch {}
  }
}

const mock = await startMockOpencode()
const dataDir = await mkdtemp(path.join(os.tmpdir(), "orp-test-"))
let player = null
let sse = null

function pass(name) {
  console.log(`PASS  ${name}`)
}

async function request(base, pathname, { token, method = "GET", body, headers = {} } = {}) {
  const finalHeaders = { ...headers }
  if (token) finalHeaders.Authorization = `Bearer ${token}`
  if (body !== undefined && !finalHeaders["Content-Type"]) {
    finalHeaders["Content-Type"] = "application/json"
  }
  const response = await fetch(base + pathname, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: response.status, json, text }
}

try {
  const client = createOpencodeClient({ baseUrl: mock.baseUrl })
  player = await startRemotePlayer(
    {
      client,
      project: mock.projects[0],
      directory: mock.projects[0].worktree,
      worktree: mock.projects[0].worktree,
      serverUrl: new URL(mock.baseUrl),
    },
    { port: 0, token: TOKEN, dataDir },
  )

  assert.ok(player.port > 0, "server should bind a port")
  assert.equal(player.token, TOKEN)
  const base = player.url

  {
    const response = await fetch(base + "/api/state")
    assert.equal(response.status, 401)
    pass("unauthenticated API request is rejected")
  }

  {
    const response = await fetch(base + "/")
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /OpenCode Remote Player/)
    assert.match(response.headers.get("content-security-policy") || "", /default-src 'none'/)
    pass("static UI is served with a strict CSP")
  }

  {
    const response = await request(base, "/api/state", {
      token: TOKEN,
      headers: { Origin: "http://evil.example" },
    })
    assert.equal(response.status, 403)
    pass("cross-origin API requests are rejected")
  }

  {
    const current = await request(base, "/api/state", { token: TOKEN })
    assert.equal(current.status, 200)
    assert.equal(current.json.projects.length, 2)
    pass("project list is returned")
  }

  {
    const response = await fetch(base + "/api/events", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(response.status, 200)
    sse = new SseReader(response)
    await sse.until((event) => event.event === "state")
    pass("SSE stream connects")
  }

  {
    const selected = await request(base, "/api/projects/select", {
      token: TOKEN,
      method: "POST",
      body: { projectId: "proj_remote_player" },
    })
    assert.equal(selected.status, 200)
    assert.equal(selected.json.activeProjectId, "proj_remote_player")
    await sse.until(
      (event) => event.event === "state" && event.data.activeProjectId === "proj_remote_player",
    )
    pass("project selection is persisted to clients")
  }

  {
    const prompt = await request(base, "/api/prompt", {
      token: TOKEN,
      method: "POST",
      body: { text: "hello" },
    })
    assert.equal(prompt.status, 202)

    const events = await sse.until((event) => event.event === "done", 6000)
    const deltas = events.filter((event) => event.event === "delta")
    const text = deltas.map((event) => event.data.text).join("")
    assert.equal(text, "Hello from mock OpenCode!")
    assert.ok(
      !events.some((event) => JSON.stringify(event.data).includes("secret reasoning")),
      "reasoning parts must not be forwarded",
    )
    pass("prompt output streams in realtime and excludes reasoning")
  }

  {
    const prompt = await request(base, "/api/prompt", {
      token: TOKEN,
      method: "POST",
      body: { text: "please fail" },
    })
    assert.equal(prompt.status, 202)

    const events = await sse.until((event) => event.event === "done", 6000)
    const error = events.find((event) => event.event === "error")
    const retry = events.find((event) => event.event === "retry")
    assert.ok(error, "error event should be forwarded")
    assert.match(error.data.message, /upstream temporarily unavailable/)
    assert.ok(retry, "retry status should be forwarded")
    assert.match(retry.data.message, /temporarily unavailable/)
    pass("provider errors and retries are forwarded")
  }

  {
    const prompt = await request(base, "/api/prompt", {
      token: TOKEN,
      method: "POST",
      body: { text: "long" },
    })
    assert.equal(prompt.status, 202)
    await sse.until((event) => event.event === "delta", 3000)

    const aborted = await request(base, "/api/abort", {
      token: TOKEN,
      method: "POST",
      body: {},
    })
    assert.equal(aborted.status, 200)
    assert.equal(aborted.json.aborted, true)
    await sse.until((event) => event.event === "aborted", 3000)
    pass("in-flight request can be cancelled")
  }

  {
    const response = await request(base, "/api/prompt", {
      token: TOKEN,
      method: "POST",
      body: { text: "hello" },
      headers: { "Content-Type": "text/plain" },
    })
    assert.equal(response.status, 415)
    pass("non-JSON request bodies are rejected")
  }

  {
    const response = await request(base, "/server.js", { token: TOKEN })
    assert.equal(response.status, 404)
    pass("non-UI paths are not served")
  }

  console.log("\nAll smoke tests passed.")
} finally {
  sse?.close()
  if (player) await player.close()
  await mock.close()
  await rm(dataDir, { recursive: true, force: true })
}
