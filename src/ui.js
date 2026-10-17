const $ = (id) => document.getElementById(id)

const connEl = $("conn")
const projectEl = $("project")
const projectHintEl = $("project-hint")
const refreshBtn = $("refresh")
const outputEl = $("output")
const promptEl = $("prompt")
const sendBtn = $("send")
const statusEl = $("status")
const authEl = $("auth")
const authForm = $("auth-form")
const tokenEl = $("token")
const authErrorEl = $("auth-error")

const TOKEN_KEY = "opencode.remote.player.token"

let token = ""
let state = { projects: [], activeProjectId: null, busy: false, text: "" }
let eventsAbort = null
let reconnectTimer = null
let activeProjectShown = undefined
let hadError = false

function readToken() {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : ""
  if (hash) {
    const match = /^(?:token=)?(.+)$/.exec(hash)
    token = decodeURIComponent(match ? match[1] : hash)
    try {
      sessionStorage.setItem(TOKEN_KEY, token)
    } catch {}
    history.replaceState(null, "", location.pathname + location.search)
    return
  }
  try {
    token = sessionStorage.getItem(TOKEN_KEY) || ""
  } catch {
    token = ""
  }
}

async function api(pathname, options = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.body !== undefined) headers["Content-Type"] = "application/json"

  const response = await fetch(pathname, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  })

  if (response.status === 401) {
    showAuth("Invalid or missing token.")
    throw new Error("Unauthorized")
  }

  let data = null
  try {
    data = await response.json()
  } catch {}

  if (!response.ok) {
    throw new Error((data && data.message) || `HTTP ${response.status}`)
  }
  return data
}

function setConn(ok, text) {
  connEl.textContent = text
  connEl.classList.toggle("ok", !!ok)
  connEl.classList.toggle("bad", !ok)
}

function setStatus(text) {
  statusEl.textContent = text || ""
}

function showAuth(message) {
  authEl.classList.remove("hidden")
  if (message) authErrorEl.textContent = message
  tokenEl.focus()
}

function hideAuth() {
  authEl.classList.add("hidden")
  authErrorEl.textContent = ""
}

function applyState(next) {
  if (!next || !Array.isArray(next.projects)) return
  state = { ...state, ...next }
  render()
}

function render() {
  const selected = state.activeProjectId || ""

  projectEl.textContent = ""

  if (state.projects.length === 0) {
    const option = document.createElement("option")
    option.value = ""
    option.textContent = "No projects found"
    projectEl.appendChild(option)
    projectHintEl.textContent = "Open a folder in OpenCode to make it available here."
  } else {
    const placeholder = document.createElement("option")
    placeholder.value = ""
    placeholder.textContent = "Select a project..."
    projectEl.appendChild(placeholder)

    for (const project of state.projects) {
      const option = document.createElement("option")
      option.value = project.id
      option.textContent = project.worktree
      projectEl.appendChild(option)
    }
    projectHintEl.textContent = ""
  }

  if (selected && state.projects.some((project) => project.id === selected)) {
    projectEl.value = selected
  } else {
    projectEl.value = ""
  }

  projectEl.disabled = state.busy || state.projects.length === 0
  refreshBtn.disabled = state.busy
  sendBtn.textContent = state.busy ? "Stop" : "Send"
  sendBtn.classList.toggle("stop", !!state.busy)

  if (activeProjectShown !== state.activeProjectId) {
    activeProjectShown = state.activeProjectId
    hadError = false
    outputEl.value = state.busy && typeof state.text === "string" ? state.text : ""
    if (!state.activeProjectId) setStatus("select a project to begin")
    else if (!state.busy) setStatus("ready")
  }
}

async function connect() {
  if (!token) {
    showAuth()
    return
  }
  hideAuth()
  try {
    const current = await api("/api/state")
    applyState(current)
    setConn(true, "connected")
    startEvents()
  } catch (error) {
    setConn(false, "error")
    setStatus(`error: ${error.message}`)
  }
}

function stopEvents() {
  if (eventsAbort) {
    try {
      eventsAbort.abort()
    } catch {}
  }
  eventsAbort = null
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, 2000)
}

async function startEvents() {
  stopEvents()
  eventsAbort = new AbortController()

  try {
    const response = await fetch("/api/events", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: eventsAbort.signal,
    })

    if (response.status === 401) {
      showAuth("Invalid or missing token.")
      return
    }
    if (!response.ok || !response.body) {
      throw new Error(`events HTTP ${response.status}`)
    }

    setConn(true, "connected")

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        handleFrame(frame)
      }
    }

    if (!eventsAbort.signal.aborted) {
      setConn(false, "disconnected")
      scheduleReconnect()
    }
  } catch (error) {
    if (eventsAbort.signal.aborted) return
    setConn(false, "disconnected")
    scheduleReconnect()
  }
}

function handleFrame(frame) {
  let event = "message"
  const dataLines = []
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return
  let payload
  try {
    payload = JSON.parse(dataLines.join("\n"))
  } catch {
    return
  }
  handleEvent(event, payload)
}

function handleEvent(event, data) {
  switch (event) {
    case "state":
      applyState(data)
      break
    case "status":
      if (data.status === "busy") {
        state.busy = true
        render()
        setStatus("working...")
      } else {
        state.busy = false
        render()
        if (statusEl.textContent === "working...") setStatus("")
      }
      break
    case "delta":
      outputEl.value += data.text
      outputEl.scrollTop = outputEl.scrollHeight
      break
    case "retry":
      setStatus(`retrying (attempt ${data.attempt}): ${data.message}`)
      break
    case "error":
      hadError = true
      setStatus(`error: ${data.message}`)
      outputEl.value += `${outputEl.value ? "\n\n" : ""}[error] ${data.message}`
      outputEl.scrollTop = outputEl.scrollHeight
      break
    case "done":
      if (typeof data.text === "string" && data.text) outputEl.value = data.text
      state.busy = false
      render()
      setStatus(hadError ? "done (with errors)" : "done")
      hadError = false
      break
    case "aborted":
      if (typeof data.text === "string" && data.text) outputEl.value = data.text
      state.busy = false
      render()
      setStatus("aborted")
      hadError = false
      break
    default:
      break
  }
}

async function sendPrompt() {
  const text = promptEl.value.trim()
  if (!text || state.busy) return
  if (!state.activeProjectId) {
    setStatus("select a project first")
    return
  }

  outputEl.value = ""
  hadError = false
  setStatus("sending...")
  try {
    await api("/api/prompt", { method: "POST", body: { text } })
    promptEl.value = ""
    state.busy = true
    render()
    setStatus("working...")
  } catch (error) {
    state.busy = false
    render()
    setStatus(`error: ${error.message}`)
  }
}

async function abortRequest() {
  setStatus("stopping...")
  try {
    await api("/api/abort", { method: "POST", body: {} })
  } catch (error) {
    setStatus(`error: ${error.message}`)
  }
}

async function selectProject() {
  const projectId = projectEl.value
  if (!projectId) return
  setStatus("selecting...")
  try {
    const next = await api("/api/projects/select", {
      method: "POST",
      body: { projectId },
    })
    applyState(next)
    setStatus("ready")
  } catch (error) {
    setStatus(`error: ${error.message}`)
  }
}

async function refreshProjects() {
  try {
    const current = await api("/api/state")
    applyState(current)
    setStatus("refreshed")
  } catch (error) {
    setStatus(`error: ${error.message}`)
  }
}

sendBtn.addEventListener("click", () => {
  if (state.busy) abortRequest()
  else sendPrompt()
})

refreshBtn.addEventListener("click", refreshProjects)
projectEl.addEventListener("change", selectProject)

promptEl.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault()
    if (!state.busy) sendPrompt()
  }
})

authForm.addEventListener("submit", (event) => {
  event.preventDefault()
  const value = tokenEl.value.trim()
  if (!value) return
  token = value
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
  } catch {}
  tokenEl.value = ""
  connect()
})

readToken()
render()
setConn(false, "connecting...")

if (token) connect()
else showAuth()
