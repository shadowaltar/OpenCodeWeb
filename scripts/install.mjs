import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const configDir =
  process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode")
const pluginsDir = path.join(configDir, "plugins")
const targetDir = path.join(configDir, "remote-player")

const files = ["plugin.js", "server.js", "ui.html", "ui.css", "ui.js"]

await rm(targetDir, { recursive: true, force: true })
await mkdir(targetDir, { recursive: true })
for (const file of files) {
  await cp(path.join(root, "src", file), path.join(targetDir, file))
}

await mkdir(pluginsDir, { recursive: true })
await writeFile(
  path.join(pluginsDir, "opencode-remote-player.js"),
  'export { default } from "../remote-player/plugin.js"\n',
  "utf8",
)

console.log(`Installed OpenCode Remote Player into ${targetDir}`)
console.log(`Plugin shim: ${path.join(pluginsDir, "opencode-remote-player.js")}`)
console.log(
  `Restart OpenCode, then read the token from ${path.join(
    os.homedir(),
    ".local",
    "share",
    "opencode-remote-player",
    "runtime.json",
  )}`,
)
