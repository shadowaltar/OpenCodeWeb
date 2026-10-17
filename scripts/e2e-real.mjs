import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { readFile } from "node:fs/promises"

const runtimePath = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode-remote-player",
  "runtime.json",
)
const runtime = JSON.parse(
  (await readFile(runtimePath, "utf8")).replace(/^\uFEFF/, ""),
)
const base = runtime.url
const token = runtime.token
const auth = { Authorization: `Bearer ${token}` }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class Sse {
  constructor(response) {
    this.reader = response.body.getReader()
    this.decoder = new TextDecoder()
    this.buffer = ""
  }
  async next(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const index = this.buffer.indexOf("\n\n")
      if (index >= 0) {
        const frame = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 2)
        let event = "message"
        const data = []
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim()
          else if (line.startsWith("data:")) data.push(line.slice(5).trim())
        }
        if (data.length) return { event, data: JSON.parse(data.join("\n")) }
        continue
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error("SSE timeout")
      const result = await Promise.race([
        this.reader.read(),
        sleep(remaining).then(() => ({ timedOut: true })),
      ])
      if (result.timedOut) throw new Error("SSE timeout")
      if (result.done) return null
      this.buffer += this.decoder.decode(result.value, { stream: true })
    }
  }
}

async function api(pathname, options = {}) {
  const response = await fetch(base + pathname, {
    method: options.method || "GET",
    headers: {
      ...auth,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  if (!response.ok) throw new Error(`${pathname} -> ${response.status} ${text}`)
  return json
}

const state = await api("/api/state")
const desired = process.env.ORP_TEST_PROJECT
const project =
  (desired && state.projects.find((p) => p.worktree === desired)) ||
  state.projects.find((p) => p.id !== "global") ||
  state.projects[0]
if (!project) throw new Error("No projects are available to test against")
console.log(`selecting ${project.worktree} (${project.id})`)
await api("/api/projects/select", {
  method: "POST",
  body: { projectId: project.id },
})

const eventsResponse = await fetch(base + "/api/events", { headers: auth })
assert.equal(eventsResponse.status, 200)
const sse = new Sse(eventsResponse)
await sse.next(5000)

const prompt = process.env.ORP_TEST_PROMPT || "Reply with exactly: pong"
console.log(`prompt: ${prompt}`)
const accepted = await api("/api/prompt", { method: "POST", body: { text: prompt } })
console.log(`accepted: ${JSON.stringify(accepted)}`)

let output = ""
let errorMessage = null
const deadline = Date.now() + 120_000
while (Date.now() < deadline) {
  const event = await sse.next(deadline - Date.now())
  if (!event) break
  if (event.event === "delta") {
    output += event.data.text
    process.stdout.write(event.data.text)
  } else if (event.event === "error") {
    errorMessage = event.data.message
    console.error(`\n[error] ${errorMessage}`)
  } else if (event.event === "retry") {
    console.log(`\n[retry ${event.data.attempt}] ${event.data.message}`)
  } else if (event.event === "done" || event.event === "aborted") {
    if (typeof event.data.text === "string" && event.data.text) output = event.data.text
    console.log(`\n[${event.event}]`)
    break
  }
}

console.log(`\n--- final output ---\n${output}`)
if (errorMessage) throw new Error(`provider error: ${errorMessage}`)
assert.match(output.toLowerCase(), /pong/, "expected the model to answer pong")
console.log("REAL END-TO-END PROMPT OK")
process.exit(0)
