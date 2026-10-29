import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { record } from "./shared"

export type ToolOutputOptions = false | { maxBytes?: number; maxLines?: number }
type Options = Required<Exclude<ToolOutputOptions, false>>
const tools: Record<string, true> = { bash: true, grep: true, glob: true, webfetch: true }

function options(input: unknown): Options | false {
  if (input === false) return false
  if (input !== undefined && !record(input)) throw new Error("shrinkToolOutputs must be false or an options object")
  const result: Options = { maxBytes: 16 * 1024, maxLines: 400 }
  for (const [key, value] of Object.entries(input ?? {})) {
    if (key !== "maxBytes" && key !== "maxLines") throw new Error(`Unknown shrinkToolOutputs option: ${key}`)
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`shrinkToolOutputs.${key} must be a positive integer`)
    result[key] = value
  }
  return result
}

function edge(text: string, maxBytes: number, tail = false): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  if (tail) {
    let start = bytes.length - maxBytes
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
    return bytes.subarray(start).toString("utf8")
  }
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString("utf8")
}

// These limits include the retrieval hint, not just the visible source excerpt.
function preview(text: string, path: string, limits: Options): string | undefined {
  const marker = `[Output shortened; full output: ${JSON.stringify(path)}]`
  const complete = `${text}\n${marker}`
  if (Buffer.byteLength(complete) <= limits.maxBytes && complete.split("\n").length <= limits.maxLines) return complete
  const available = limits.maxBytes - Buffer.byteLength(marker) - 2
  if (available < 0 || limits.maxLines < 3) return
  const lines = text.split("\n")
  const head = edge(lines.slice(0, Math.ceil((limits.maxLines - 1) / 2)).join("\n"), Math.ceil(available / 2))
  const tail = edge(lines.slice(-Math.floor((limits.maxLines - 1) / 2)).join("\n"), Math.floor(available / 2), true)
  return [head, marker, tail].filter((part) => part.length > 0).join("\n")
}

export class ToolOutputShrinker {
  readonly limits: Readonly<Options> | false
  private readonly directory: string

  // dataDirectory is the XDG data base, not the plugin's checkpoint directory.
  constructor(input?: unknown, dataDirectory = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")) {
    this.limits = options(input)
    if (!isAbsolute(dataDirectory)) throw new Error("Tool output data directory must be an absolute path")
    this.directory = join(resolve(dataDirectory), "opencode", "tool-output")
  }

  private async directories(create: boolean) {
    for (const directory of [dirname(this.directory), this.directory]) {
      if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error("Tool output directory must be owned by the current user and must not be a symlink")
      await chmod(directory, 0o700)
    }
  }

  private async nativeArtifact(path: unknown): Promise<boolean> {
    if (typeof path !== "string" || !isAbsolute(path) || dirname(path) !== this.directory || !/^tool_[A-Za-z0-9_-]+$/.test(basename(path))) return false
    await this.directories(false)
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) return false
      await file.chmod(0o600)
      return true
    } finally { await file.close() }
  }

  private async save(path: string, raw: string) {
    await this.directories(true)
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      await file.writeFile(raw, "utf8")
      await file.close()
    } catch (error) {
      await file.close().catch(() => {})
      await unlink(path).catch(() => {})
      throw error
    }
  }

  async apply<T extends { output: string; metadata: unknown }>(tool: string, result: T): Promise<T> {
    if (!this.limits || !Object.hasOwn(tools, tool) || !record(result.metadata) || result.metadata.kvGuardOutput === 1) return result
    const text = stripVTControlCharacters(result.output)
    const clipped = Buffer.byteLength(text) > this.limits.maxBytes || text.split("\n").length > this.limits.maxLines
    if (text === result.output && !clipped) return result
    const metadata = result.metadata
    const native = metadata.truncated === true
    try {
      // A native preview cannot be promoted to a full raw artifact. If its raw
      // file is unavailable, keep the complete existing result untouched.
      if (native && !await this.nativeArtifact(metadata.outputPath)) return result
      const path = native ? metadata.outputPath as string : join(this.directory, `tool_kvguard_${randomBytes(24).toString("hex")}`)
      // OpenCode appends shell status after saving the raw command output.
      // Match only that final block: command output can contain a literal one.
      const annotation = native && tool === "bash" ? text.match(/\n\n<shell_metadata>\n(?:(?!<\/?shell_metadata>)[\s\S])*\n<\/shell_metadata>$/)?.[0] ?? "" : ""
      const excerpt = annotation ? text.slice(0, -annotation.length) : text
      const output = preview(excerpt, path, {
        maxBytes: this.limits.maxBytes - Buffer.byteLength(annotation),
        maxLines: this.limits.maxLines - (annotation.match(/\n/g)?.length ?? 0),
      })
      if (output === undefined) return result
      if (!native) await this.save(path, result.output)
      return { ...result, output: output + annotation, metadata: { ...metadata, truncated: native || clipped, outputPath: path, kvGuardOutput: 1 } }
    } catch {
      // A hook failure must not turn a successful tool call into a lost result.
      return result
    }
  }
}
