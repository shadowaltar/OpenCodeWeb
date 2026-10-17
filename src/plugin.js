import { appendFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startRemotePlayer } from "./server.js"

const FALLBACK_DIR = path.join(os.homedir(), ".local", "share", "opencode-remote-player")
const FALLBACK_LOG = path.join(FALLBACK_DIR, "remote-player.log")

async function fallbackLog(message) {
  try {
    await mkdir(FALLBACK_DIR, { recursive: true })
    await appendFile(
      FALLBACK_LOG,
      `[${new Date().toISOString()}] [plugin] ${message}\n`,
      "utf8",
    )
  } catch {}
}

async function opencodeLog(input, level, message) {
  try {
    await input.client.app.log({
      body: { service: "opencode-remote-player", level, message },
    })
  } catch {}
}

export default async function opencodeRemotePlayer(input) {
  try {
    const { hooks, url, token, port } = await startRemotePlayer(input)
    if (token) {
      await opencodeLog(
        input,
        "info",
        `OpenCode Remote Player listening at ${url}#${token}`,
      )
      await fallbackLog(`started on port ${port}`)
    }
    return hooks
  } catch (error) {
    const detail = error?.stack || error?.message || String(error)
    await fallbackLog(`failed to start: ${detail}`)
    await opencodeLog(input, "error", `failed to start: ${detail}`)
    return {}
  }
}
