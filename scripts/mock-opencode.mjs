import http from "node:http"

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function startMockOpencode() {
  const projects = [
    {
      id: "proj_remote_player",
      worktree: "D:\\Projects\\OpenCodeRemotePlayer",
      time: { created: Date.now() },
    },
    {
      id: "proj_demo",
      worktree: "D:\\Projects\\Demo",
      time: { created: Date.now() },
    },
  ]

  const sessions = new Map()
  const sseClients = new Set()
  const timers = new Map()
  let counter = 0

  function emit(sessionID, payload) {
    const frame = `data: ${JSON.stringify({
      directory: projects[0].worktree,
      payload,
    })}\n\n`
    for (const res of sseClients) {
      try {
        res.write(frame)
      } catch {
        sseClients.delete(res)
      }
    }
    void sessionID
  }

  function later(sessionID, ms, fn) {
    const handle = setTimeout(() => {
      timers.delete(handle)
      fn()
    }, ms)
    if (!timers.has(sessionID)) timers.set(sessionID, new Set())
    timers.get(sessionID).add(handle)
    return handle
  }

  function clearSessionTimers(sessionID) {
    const set = timers.get(sessionID)
    if (!set) return
    for (const handle of set) clearTimeout(handle)
    timers.delete(sessionID)
  }

  function emitMessage(sessionID, id, role, extra = {}) {
    emit(sessionID, {
      type: "message.updated",
      properties: {
        info: {
          id,
          sessionID,
          role,
          time: { created: Date.now() },
          ...extra,
        },
      },
    })
  }

  function emitPart(sessionID, part) {
    emit(sessionID, {
      type: "message.part.updated",
      properties: { part: { sessionID, ...part } },
    })
  }

  function runNormal(sessionID, text) {
    emitMessage(sessionID, "msg_user", "user", { agent: "build" })
    emitPart(sessionID, {
      id: "prt_user",
      messageID: "msg_user",
      type: "text",
      text,
    })
    emitMessage(sessionID, "msg_asst", "assistant", { parentID: "msg_user" })

    emitPart(sessionID, {
      id: "prt_reasoning",
      messageID: "msg_asst",
      type: "reasoning",
      text: "secret reasoning that must never be forwarded",
      time: { start: Date.now() },
    })

    const chunks = ["Hello", " from", " mock", " OpenCode!"]
    chunks.forEach((chunk, index) => {
      later(sessionID, 60 + index * 70, () => {
        emitPart(sessionID, {
          id: "prt_asst",
          messageID: "msg_asst",
          type: "text",
          text: chunks.slice(0, index + 1).join(""),
          time: { start: Date.now() },
        })
      })
    })

    later(sessionID, 60 + chunks.length * 70 + 60, () => {
      emit(sessionID, {
        type: "session.status",
        properties: { sessionID, status: { type: "idle" } },
      })
    })
  }

  function runFailure(sessionID) {
    emitMessage(sessionID, "msg_user_fail", "user", { agent: "build" })
    emitPart(sessionID, {
      id: "prt_user_fail",
      messageID: "msg_user_fail",
      type: "text",
      text: "please fail",
    })
    emitMessage(sessionID, "msg_asst_fail", "assistant", { parentID: "msg_user_fail" })
    later(sessionID, 40, () => {
      emit(sessionID, {
        type: "session.status",
        properties: {
          sessionID,
          status: {
            type: "retry",
            attempt: 1,
            message: "provider is temporarily unavailable",
            next: Date.now() + 1000,
          },
        },
      })
    })
    later(sessionID, 120, () => {
      emit(sessionID, {
        type: "session.error",
        properties: {
          sessionID,
          error: {
            name: "APIError",
            data: {
              message: "upstream temporarily unavailable",
              statusCode: 503,
              isRetryable: true,
            },
          },
        },
      })
    })
    later(sessionID, 220, () => {
      emit(sessionID, {
        type: "session.idle",
        properties: { sessionID },
      })
    })
  }

  function runLong(sessionID) {
    emitMessage(sessionID, "msg_user_long", "user", { agent: "build" })
    emitPart(sessionID, {
      id: "prt_user_long",
      messageID: "msg_user_long",
      type: "text",
      text: "long",
    })
    emitMessage(sessionID, "msg_asst_long", "assistant", { parentID: "msg_user_long" })

    let index = 0
    const tick = () => {
      index += 1
      emitPart(sessionID, {
        id: "prt_asst_long",
        messageID: "msg_asst_long",
        type: "text",
        text: "x".repeat(index),
        time: { start: Date.now() },
      })
      if (index < 200) later(sessionID, 80, tick)
    }
    later(sessionID, 80, tick)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1")

    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === "/project" && req.method === "GET") {
      send(200, projects)
      return
    }

    if (url.pathname === "/global/event" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      })
      res.write(
        `data: ${JSON.stringify({
          directory: projects[0].worktree,
          payload: { type: "server.connected", properties: {} },
        })}\n\n`,
      )
      sseClients.add(res)
      req.on("close", () => sseClients.delete(res))
      return
    }

    if (url.pathname === "/session" && req.method === "POST") {
      counter += 1
      const id = `ses_${counter}`
      sessions.set(id, { id })
      send(200, { id, title: "Remote Player", time: { created: Date.now() } })
      return
    }

    const promptMatch = /^\/session\/([^/]+)\/prompt_async$/.exec(url.pathname)
    if (promptMatch && req.method === "POST") {
      const sessionID = promptMatch[1]
      let raw = ""
      for await (const chunk of req) raw += chunk
      let body = {}
      try {
        body = JSON.parse(raw || "{}")
      } catch {}
      const text = body.parts?.[0]?.text || ""
      res.writeHead(204)
      res.end()

      await sleep(10)
      if (text.includes("fail")) runFailure(sessionID)
      else if (text.includes("long")) runLong(sessionID)
      else runNormal(sessionID, text)
      return
    }

    const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(url.pathname)
    if (abortMatch && req.method === "POST") {
      const sessionID = abortMatch[1]
      clearSessionTimers(sessionID)
      send(200, true)
      return
    }

    send(404, { message: "not found" })
  })

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
    server.listen(0, "127.0.0.1")
  })

  const { port } = server.address()

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    projects,
    close: () =>
      new Promise((resolve) => {
        for (const res of sseClients) {
          try {
            res.end()
          } catch {}
        }
        server.close(() => resolve())
      }),
  }
}
