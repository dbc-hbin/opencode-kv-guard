import { afterEach, describe, expect, test } from "bun:test"
import type { Result } from "@opencode/plugin/promise/tool"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { parseOptions } from "../src/options"
import { ToolArtifacts, ToolOutputShrinker } from "../src/output"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root() {
  const directory = await mkdtemp(join(tmpdir(), "kv-guard-output-"))
  roots.push(directory)
  return directory
}

const directory = (data: string) => join(data, "opencode", "tool-output")
const attachment = { type: "file", uri: "fixture://image", mime: "image/png" } as const
const paragraph = (text: string) => ({ type: "text", text } as const)
const result = (content: string, metadata: Record<string, unknown> = {}) => ({
  output: { value: content }, content: [paragraph(content), attachment], metadata,
})
const lines = (count: number, width = 40) => Array.from({ length: count }, (_, index) => `${index}:` + "x".repeat(width)).join("\n")

function text(result: Result) {
  return typeof result.content === "string" ? result.content : result.content?.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n") ?? ""
}

function path(result: Result) {
  const value: unknown = result.metadata?.outputPath
  if (typeof value !== "string") throw new Error("Expected a retrievable output path")
  return value
}

function artifact(result: Result) {
  return readFile(path(result), "utf8")
}

describe("tool output storage reduction", () => {
  test("compaction reuses and recreates a native-cleanup-compatible raw artifact", async () => {
    const data = await root()
    const artifacts = new ToolArtifacts(data)
    const raw = "원본 output\n" + lines(100)
    const path = artifacts.contentPath(raw)
    await Promise.all([artifacts.saveContent(path, raw), artifacts.saveContent(path, raw)])
    expect(basename(path)).toMatch(/^tool_[a-f0-9]{12}_kvguard_[a-f0-9]{52}$/)
    expect(await readFile(path, "utf8")).toBe(raw)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(directory(data))).toEqual([basename(path)])

    const old = new Date(0)
    await utimes(path, old, old)
    const resumed = new ToolArtifacts(data)
    await resumed.saveContent(path, raw)
    expect((await stat(path)).mtimeMs).toBeGreaterThan(old.getTime())
    await rm(path)
    await resumed.saveContent(path, raw)
    expect(await readFile(path, "utf8")).toBe(raw)

    await rm(path)
    const elsewhere = join(data, "other-file")
    await writeFile(elsewhere, "unrelated data")
    await symlink(elsewhere, path)
    await expect(resumed.saveContent(path, raw)).rejects.toThrow()
    expect(await readFile(elsewhere, "utf8")).toBe("unrelated data")
  })

  test("stores exact raw output privately and bounds the head, tail and retrieval path together", async () => {
    const data = await root()
    const shrinker = new ToolOutputShrinker({ maxBytes: 1024, maxLines: 7 }, data)
    const raw = "first-record\n" + lines(100, 90) + "\nlast-record"
    const nested = { exit: 0, command: "fixture" }
    const original = Object.freeze(result(raw, Object.freeze({ truncated: false, nested, custom: "keep" })))
    const compacted = await shrinker.apply("shell", original)

    expect(compacted).not.toBe(original)
    expect(text(compacted).startsWith("first-record\n")).toBe(true)
    expect(text(compacted).endsWith("\nlast-record")).toBe(true)
    expect(Buffer.byteLength(text(compacted))).toBeLessThanOrEqual(1024)
    expect(text(compacted).split("\n").length).toBeLessThanOrEqual(7)
    expect(text(compacted)).toContain(path(compacted))
    expect(await artifact(compacted)).toBe(raw)
    expect(compacted.output).toBe(original.output)
    expect(Array.isArray(compacted.content) ? compacted.content.at(-1) : undefined).toBe(attachment)
    expect(compacted.metadata?.nested).toBe(nested)
    expect(compacted.metadata?.custom).toBe("keep")
    expect(compacted.metadata?.truncated).toBe(true)
    expect(text(original)).toBe(raw)
    expect(original.metadata).toEqual({ truncated: false, nested, custom: "keep" })
    const saved = path(compacted)
    // OpenCode's hourly retention scanner recognizes only this name prefix.
    expect(basename(saved)).toMatch(/^tool_[a-f0-9]{12}/)
    expect(await readdir(directory(data))).toEqual([basename(saved)])
    expect((await stat(saved)).mode & 0o777).toBe(0o600)
    expect((await stat(directory(data))).mode & 0o777).toBe(0o700)
    expect((await stat(join(data, "opencode"))).mode & 0o777).toBe(0o700)
  })

  test("applies conservative default byte and line limits", async () => {
    const data = await root()
    const original = result(lines(800, 70))
    const compacted = await new ToolOutputShrinker(undefined, data).apply("grep", original)
    expect(compacted).not.toBe(original)
    expect(Buffer.byteLength(text(compacted))).toBeLessThanOrEqual(16 * 1024)
    expect(text(compacted).split("\n").length).toBeLessThanOrEqual(400)
    expect(await artifact(compacted)).toBe(text(original))
  })

  test("enforces line limits independently from byte limits", async () => {
    const data = await root()
    const original = result("head\n1\n" + lines(100) + "\n8\ntail" + " ".repeat(500), { truncated: true })
    const compacted = await new ToolOutputShrinker({ maxBytes: 16384, maxLines: 5 }, data).apply("glob", original)
    expect(compacted).not.toBe(original)
    expect(text(compacted).startsWith("head\n1\n")).toBe(true)
    expect(text(compacted).endsWith("\n8\ntail" + " ".repeat(500))).toBe(true)
    expect(text(compacted).split("\n").length).toBe(5)
    expect(await artifact(compacted)).toBe(text(original))
  })

  test("cuts multibyte UTF-8 at valid boundaries in a single long line", async () => {
    const data = await root()
    const codepoints = "\u{1f600}\ud55c\u00e9"
    const raw = "HEAD:" + codepoints.repeat(500) + ":TAIL"
    const compacted = await new ToolOutputShrinker({ maxBytes: 513, maxLines: 9 }, data).apply("webfetch", result(raw))
    expect(text(compacted).startsWith("HEAD:")).toBe(true)
    expect(text(compacted).endsWith(":TAIL")).toBe(true)
    expect(text(compacted)).not.toContain("\ufffd")
    expect(Buffer.from(text(compacted)).toString("utf8")).toBe(text(compacted))
    expect(Buffer.byteLength(text(compacted))).toBeLessThanOrEqual(513)
    expect(await artifact(compacted)).toBe(raw)
  })

  test("strips CSI and OSC ANSI sequences even below clipping thresholds while retaining their raw bytes", async () => {
    const data = await root()
    const raw = "\u001b[31mred\u001b[0m \u001b]8;;https://example.test\u0007link\u001b]8;;\u0007"
    for (const tool of ["shell", "grep", "glob", "webfetch"]) {
      const compacted = await new ToolOutputShrinker(undefined, data).apply(tool, result(raw, { exit: 0 }))
      expect(text(compacted)).toBe(`red link\n[Output shortened; full output: ${JSON.stringify(path(compacted))}]`)
      expect(compacted.metadata?.exit).toBe(0)
      expect(compacted.metadata?.truncated).toBe(false)
      expect(await artifact(compacted)).toBe(raw)
    }
    expect((await readdir(directory(data))).length).toBe(4)
  })

  test("keeps an OSC hyperlink target retrievable after ANSI-only cleanup", async () => {
    const data = await root()
    const raw = "\u001b]8;;https://example.test/hidden-target\u0007click here\u001b]8;;\u0007"
    const compacted = await new ToolOutputShrinker({ maxBytes: 512, maxLines: 2 }, data).apply("shell", result(raw))
    expect(text(compacted).startsWith("click here\n")).toBe(true)
    expect(text(compacted)).toContain(`[Output shortened; full output: ${JSON.stringify(path(compacted))}]`)
    expect(text(compacted).split("\n").length).toBeLessThanOrEqual(2)
    expect(await artifact(compacted)).toBe(raw)
  })

  test("leaves exact-threshold and ordinary short output untouched without artifacts", async () => {
    const data = await root()
    const shrinker = new ToolOutputShrinker({ maxBytes: 8, maxLines: 2 }, data)
    for (const raw of ["", "short", "abc\ndefg"]) {
      const original = result(raw)
      expect(await shrinker.apply("shell", original)).toBe(original)
    }
    await expect(stat(directory(data))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("never touches read/edit, other builtins, or unknown and MCP tool names", async () => {
    const data = await root()
    const shrinker = new ToolOutputShrinker({ maxBytes: 512, maxLines: 5 }, data)
    const original = result("\u001b[32m" + lines(100) + "\u001b[0m")
    for (const tool of ["read", "edit", "write", "patch", "subagent", "websearch", "Shell", "custom", "mcp__server__shell", "server_shell", "toString", "constructor"]) {
      expect(await shrinker.apply(tool, original)).toBe(original)
    }
    await expect(stat(directory(data))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("does not rewrite a stored preview, even through a fresh instance with stricter limits", async () => {
    const data = await root()
    const shrinker = new ToolOutputShrinker({ maxBytes: 1024, maxLines: 7 }, data)
    const compacted = await shrinker.apply("shell", result(lines(200)))
    expect(await shrinker.apply("shell", compacted)).toBe(compacted)
    expect(await new ToolOutputShrinker({ maxBytes: 512, maxLines: 3 }, data).apply("shell", compacted)).toBe(compacted)
    expect(await readdir(directory(data))).toEqual([basename(path(compacted))])
    expect(await artifact(compacted)).toBe(lines(200))
  })

  test("keeps native full output instead of saving the native preview as raw", async () => {
    const data = await root()
    await mkdir(directory(data), { recursive: true })
    const path = join(directory(data), "tool_01998b84ef42native123")
    const full = "raw-origin\n" + lines(500, 150) + "\nraw-end"
    await writeFile(path, full, { mode: 0o644 })
    const original = result(lines(100) + "\nNative preview only", { truncated: true, outputPath: path, matches: 500 })
    const compacted = await new ToolOutputShrinker({ maxBytes: 512, maxLines: 5 }, data).apply("grep", original)
    expect(compacted).not.toBe(original)
    expect(compacted.metadata?.outputPath).toBe(path)
    expect(compacted.metadata?.truncated).toBe(true)
    expect(compacted.metadata?.matches).toBe(500)
    expect(Buffer.byteLength(text(compacted))).toBeLessThanOrEqual(512)
    expect(text(compacted).split("\n").length).toBeLessThanOrEqual(5)
    expect(await artifact(compacted)).toBe(full)
    expect(await readdir(directory(data))).toEqual([basename(path)])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(directory(data))).mode & 0o777).toBe(0o700)
  })

  test("does not treat a missing or invalid native artifact as complete raw output", async () => {
    const data = await root()
    const outside = join(data, "tool_01998b84ef42outside")
    await writeFile(outside, "full output outside the native directory")
    await mkdir(directory(data), { recursive: true })
    const linked = join(directory(data), "tool_01998b84ef42linked")
    await symlink(outside, linked)
    const subdirectory = join(directory(data), "tool_01998b84ef42directory")
    await mkdir(subdirectory)
    const shrinker = new ToolOutputShrinker({ maxBytes: 512, maxLines: 5 }, data)
    for (const path of [undefined, "relative/tool_missing", join(directory(data), "tool_01998b84ef42missing"), outside, linked, subdirectory]) {
      const original = result("\u001b[31m" + lines(100) + "\u001b[0m", { truncated: true, outputPath: path })
      expect(await shrinker.apply("grep", original)).toBe(original)
    }
    expect((await readdir(directory(data))).sort()).toEqual([basename(subdirectory), basename(linked)])
    expect(await readFile(outside, "utf8")).toBe("full output outside the native directory")
  })

  test("keeps original output and metadata when artifact storage fails", async () => {
    const data = await root()
    await mkdir(join(data, "opencode"))
    await writeFile(directory(data), "not a directory")
    const original = result("\u001b[31m" + lines(100) + "\u001b[0m", { exit: 0, truncated: false })
    const compacted = await new ToolOutputShrinker({ maxBytes: 512, maxLines: 5 }, data).apply("shell", original)
    expect(compacted).toBe(original)
    expect(original.metadata).toEqual({ exit: 0, truncated: false })
    expect(await readFile(directory(data), "utf8")).toBe("not a directory")
  })

  test("refuses a symlinked artifact directory without writing through it", async () => {
    const data = await root()
    const outside = join(data, "outside")
    await mkdir(outside)
    await mkdir(join(data, "opencode"))
    await symlink(outside, directory(data))
    const original = result(lines(100))
    expect(await new ToolOutputShrinker({ maxBytes: 512, maxLines: 5 }, data).apply("shell", original)).toBe(original)
    expect(await readdir(outside)).toEqual([])
  })

  test("leaves the original intact when the retrieval hint cannot fit the requested budget", async () => {
    const data = await root()
    const original = result(lines(100))
    expect(await new ToolOutputShrinker({ maxBytes: 1, maxLines: 3 }, data).apply("shell", original)).toBe(original)
    await expect(stat(directory(data))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("shortens results with no metadata, as native execute and other leaves may return", async () => {
    const data = await root()
    const raw = "\u001b[31mred\u001b[0m"
    const original = { content: raw }
    const compacted = await new ToolOutputShrinker(undefined, data).apply("execute", original)
    expect(text(compacted)).toBe(`red\n[Output shortened; full output: ${JSON.stringify(path(compacted))}]`)
    expect(await artifact(compacted)).toBe(raw)
  })

  test("uses XDG_DATA_HOME at construction rather than the plugin checkpoint location", async () => {
    const data = await root()
    const previous = process.env.XDG_DATA_HOME
    let shrinker: ToolOutputShrinker
    try {
      process.env.XDG_DATA_HOME = data
      shrinker = new ToolOutputShrinker()
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previous
    }
    const compacted = await shrinker.apply("shell", result("\u001b[31mred\u001b[0m"))
    expect(path(compacted)).toBe(join(directory(data), basename(path(compacted))))
    expect(await artifact(compacted)).toBe("\u001b[31mred\u001b[0m")
  })

  test("validates thresholds, unknown keys, option shape and data directory", () => {
    for (const input of [null, true, [], "small", { unknown: 1 }, { maxBytes: 0 }, { maxBytes: -1 }, { maxBytes: 1.5 }, { maxBytes: Infinity }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }, { maxBytes: "100" }, { maxLines: 0 }, { maxLines: NaN }]) {
      expect(() => parseOptions({ providers: ["local"], shrinkToolOutputs: input })).toThrow()
    }
    expect(() => new ToolOutputShrinker({}, "relative")).toThrow()
    expect(() => new ToolOutputShrinker({ maxBytes: 512, maxLines: 3 })).not.toThrow()
  })
})
