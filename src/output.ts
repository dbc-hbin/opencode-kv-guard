import type { Result } from "@opencode/plugin/promise/tool"
import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { chmod, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { contentArtifactName } from "./compaction-shake"
import { record } from "./shared"

export type ToolOutputOptions = { readonly maxBytes?: number; readonly maxLines?: number }
type Limits = Required<ToolOutputOptions>
const tools: ReadonlySet<string> = new Set(["shell", "grep", "glob", "webfetch", "execute"])

function edge(text: string, maxBytes: number, tail = false): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  if (tail) {
    let start = bytes.length - maxBytes
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
    return bytes.subarray(start).toString("utf8")
  }
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString("utf8")
}

// These limits include the retrieval hint, not just the visible source excerpt.
function preview(text: string, path: string, limits: Limits): string | undefined {
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

// Windows has no O_NOFOLLOW/O_NONBLOCK; Node leaves them undefined there.
// Symlinks are also rejected with lstat, which works on every platform but
// cannot close the check-to-open window where O_NOFOLLOW is missing.
const noFollow = constants.O_NOFOLLOW ?? 0
const noBlock = constants.O_NONBLOCK ?? 0
const linkUnsupported = new Set(["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"])

// Private raw files in OpenCode's tool-output directory.
export class ToolArtifacts {
  readonly directory: string

  // dataDirectory is the XDG data base, not the plugin's checkpoint directory.
  constructor(dataDirectory = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")) {
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

  async native(path: unknown): Promise<boolean> {
    if (typeof path !== "string" || !isAbsolute(path) || path !== resolve(path)) return false
    const toolOutput = dirname(path) === this.directory && /^tool_[a-f0-9]{12}[A-Za-z0-9_-]+$/.test(basename(path))
    const shell = dirname(dirname(path)) === join(dirname(this.directory), "shell") && /^sh_[a-f0-9]{12}[A-Za-z0-9]+\.out$/.test(basename(path))
    if (!toolOutput && !shell) return false
    if (toolOutput) await this.directories(false)
    if (shell) {
      for (const directory of [dirname(this.directory), dirname(dirname(path)), dirname(path)]) {
        const info = await lstat(directory)
        if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) return false
      }
    }
    if (!(await lstat(path)).isFile()) return false
    const file = await open(path, constants.O_RDONLY | noFollow | noBlock)
    try {
      const info = await file.stat()
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) return false
      await file.chmod(0o600)
      return true
    } finally { await file.close() }
  }

  path() {
    // OpenCode 2.3's seven-day cleanup matches only tool_ followed by 12 hex digits.
    const key = randomBytes(30).toString("hex")
    return join(this.directory, `tool_${key.slice(0, 12)}_kvguard_${key.slice(12)}`)
  }

  async save(path: string, raw: string) {
    await this.directories(true)
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
    try {
      await file.writeFile(raw, "utf8")
      await file.close()
    } catch (error) {
      await file.close().catch(() => {})
      await unlink(path).catch(() => {})
      throw error
    }
  }

  contentPath(text: string) {
    return join(this.directory, contentArtifactName(text))
  }

  async saveContent(path: string, text: string) {
    if (path !== this.contentPath(text)) throw new Error("Content artifact path does not match its text")
    if (await this.matches(path, text)) return
    const temporary = this.path()
    await this.save(temporary, text)
    try {
      await link(temporary, path)
    } catch (error) {
      const code = record(error) && typeof error.code === "string" ? error.code : ""
      if (code === "EEXIST" && await this.matches(path, text)) return
      if (code !== "EEXIST" && !linkUnsupported.has(code)) throw error
      // A complete temporary file is published atomically on filesystems
      // without hard links, or to repair a mismatched regular file.
      await rename(temporary, path)
      if (!await this.matches(path, text)) throw new Error("Tool output artifact was replaced during publication")
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  private async matches(path: string, text: string) {
    let file
    try {
      await this.directories(false)
      if (!(await lstat(path)).isFile()) throw new Error("Content artifact must be a regular file")
      file = await open(path, constants.O_RDWR | noFollow | noBlock)
    } catch (error) {
      if (record(error) && error.code === "ENOENT") return false
      throw error
    }
    try {
      const info = await file.stat()
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) throw new Error("Content artifact must be owned by the current user")
      await file.chmod(0o600)
      if (await file.readFile("utf8") !== text) return false
      const now = new Date()
      await file.utimes(now, now)
      return true
    } finally {
      await file.close()
    }
  }
}

export class ToolOutputShrinker {
  private readonly limits: Limits
  private readonly artifacts: ToolArtifacts

  constructor(input: ToolOutputOptions = {}, dataDirectory?: string) {
    this.limits = { maxBytes: input.maxBytes ?? 16 * 1024, maxLines: input.maxLines ?? 400 }
    this.artifacts = new ToolArtifacts(dataDirectory)
  }

  supports(tool: string) {
    return tools.has(tool)
  }

  async apply(tool: string, result: Result): Promise<Result> {
    if (!this.supports(tool) || result.content === undefined) return result
    if (result.metadata !== undefined && !record(result.metadata)) return result
    const metadata = result.metadata ?? {}
    if (metadata.kvGuardOutput === 1 || (tool === "shell" && metadata.status === "running")) return result
    const content = typeof result.content === "string"
      ? [{ type: "text" as const, text: result.content }]
      : result.content
    const first = content.findIndex((item) => item.type === "text")
    const primary = content[first]
    if (primary?.type !== "text") return result
    const original = primary.text
    const text = stripVTControlCharacters(original)
    // The shell's exit/timeout notice is a separate text part; never shorten it
    // or confuse text printed by the command with a native notice.
    const trailing = content.slice(first + 1).flatMap((item) => item.type === "text" ? [item.text] : [])
    const limits = {
      maxBytes: this.limits.maxBytes - trailing.reduce((sum, item) => sum + Buffer.byteLength(item) + 1, 0),
      maxLines: this.limits.maxLines - trailing.reduce((sum, item) => sum + item.split("\n").length, 0),
    }
    const clipped = Buffer.byteLength(text) > limits.maxBytes || text.split("\n").length > limits.maxLines
    if (text === original && !clipped) return result
    const structured: unknown = result.output
    const suppliedPath: unknown = tool === "shell" && record(structured) ? structured.outputPath : metadata.outputPath
    // Glob and grep's truncated bit describes a bounded match set, not an
    // existing artifact. Their emitted result is complete for that match set.
    const native = metadata.truncated === true && (tool === "shell" || "outputPath" in metadata)
    try {
      // A native preview cannot be promoted to a full raw artifact. If its raw
      // file is unavailable, keep the complete existing result untouched.
      if (native && (typeof suppliedPath !== "string" || !await this.artifacts.native(suppliedPath))) return result
      const path = native && typeof suppliedPath === "string" ? suppliedPath : this.artifacts.path()
      const excerpt = preview(text, path, limits)
      if (excerpt === undefined) return result
      if (!native) await this.artifacts.save(path, original)
      return {
        ...result,
        content: typeof result.content === "string" ? excerpt : content.map((item, index) =>
          index === first ? { type: "text" as const, text: excerpt } : item),
        metadata: { ...metadata, truncated: clipped || metadata.truncated === true, outputPath: path, kvGuardOutput: 1 },
      }
    } catch {
      // A hook failure must not turn a successful tool call into a lost result.
      return result
    }
  }
}
