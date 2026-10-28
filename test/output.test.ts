import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { ToolOutputShrinker } from "../src/output"

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
const result = (output: string, metadata: Record<string, unknown> = {}) => ({ title: "fixture", output, metadata, attachments: [{ type: "file", url: "fixture://image" }] })
const lines = (count: number, width = 40) => Array.from({ length: count }, (_, index) => `${index}:` + "x".repeat(width)).join("\n")

async function artifact(value: { metadata: Record<string, unknown> }) {
  expect(typeof value.metadata.outputPath).toBe("string")
  return readFile(value.metadata.outputPath as string, "utf8")
}

describe("tool output storage reduction", () => {
  test("stores exact raw output privately and bounds the head, tail and retrieval path together", async () => {
    const data = await root()
    const shrinker = new ToolOutputShrinker({ maxBytes: 1024, maxLines: 7 }, data)
    const raw = "first-record\n" + lines(100, 90) + "\nlast-record"
    const nested = { exit: 0, command: "fixture" }
    const original = Object.freeze(result(raw, Object.freeze({ truncated: false, nested, custom: "keep" })))
    const compacted = await shrinker.apply("bash", original)

    expect(compacted).not.toBe(original)
    expect(compacted.output.startsWith("first-record\n")).toBe(true)
    expect(compacted.output.endsWith("\nlast-record")).toBe(true)
    expect(Buffer.byteLength(compacted.output)).toBeLessThanOrEqual(1024)
    expect(compacted.output.split("\n").length).toBeLessThanOrEqual(7)
    expect(compacted.output).toContain(compacted.metadata.outputPath as string)
    expect(await artifact(compacted)).toBe(raw)
    expect(compacted.title).toBe(original.title)
    expect(compacted.attachments).toBe(original.attachments)
    expect(compacted.metadata.nested).toBe(nested)
    expect(compacted.metadata.custom).toBe("keep")
    expect(compacted.metadata.truncated).toBe(true)
    expect(compacted.metadata.kvGuardOutput).toBe(1)
    expect(original.output).toBe(raw)
    expect(original.metadata).toEqual({ truncated: false, nested, custom: "keep" })
    const path = compacted.metadata.outputPath as string
    expect(basename(path)).toMatch(/^tool_kvguard_[a-f0-9]{48}$/)
    expect(await readdir(directory(data))).toEqual([basename(path)])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(directory(data))).mode & 0o777).toBe(0o700)
    expect((await stat(join(data, "opencode"))).mode & 0o777).toBe(0o700)
  })

  test("applies conservative default byte and line limits", async () => {
    const data = await root()
    const original = result(lines(800, 70))
    const compacted = await new ToolOutputShrinker(undefined, data).apply("grep", original)
    expect(compacted).not.toBe(original)
    expect(Buffer.byteLength(compacted.output)).toBeLessThanOrEqual(16 * 1024)
    expect(compacted.output.split("\n").length).toBeLessThanOrEqual(400)
    expect(await artifact(compacted)).toBe(original.output)
  })

  test("enforces line limits independently from byte limits", async () => {
    const data = await root()
    const original = result("head\n1\n" + lines(100) + "\n8\ntail" + " ".repeat(500))
    const compacted = await new ToolOutputShrinker({ maxBytes: 16384, maxLines: 5 }, data).apply("glob", original)
    expect(compacted).not.toBe(original)
    expect(compacted.output.startsWith("head\n1\n")).toBe(true)
    expect(compacted.output.endsWith("\n8\ntail" + " ".repeat(500))).toBe(true)
    expect(compacted.output.split("\n").length).toBe(5)
    expect(await artifact(compacted)).toBe(original.output)
  })

  test("cuts multibyte UTF-8 at valid boundaries in a single long line", async () => {
    const data = await root()
    const codepoints = "\u{1f600}\ud55c\u00e9"
    const raw = "HEAD:" + codepoints.repeat(500) + ":TAIL"
    const compacted = await new ToolOutputShrinker({ maxBytes: 513, maxLines: 9 }, data).apply("webfetch", result(raw))
    expect(compacted.output.startsWith("HEAD:")).toBe(true)
    expect(compacted.output.endsWith(":TAIL")).toBe(true)
    expect(compacted.output).not.toContain("\ufffd")
    expect(Buffer.from(compacted.output).toString("utf8")).toBe(compacted.output)
    expect(Buffer.byteLength(compacted.output)).toBeLessThanOrEqual(513)
    expect(await artifact(compacted)).toBe(raw)
  })

  test("strips CSI and OSC ANSI sequences even below clipping thresholds while retaining their raw bytes", async () => {
    const data = await root()
    const raw = "\u001b[31mred\u001b[0m \u001b]8;;https://example.test\u0007link\u001b]8;;\u0007"
    for (const tool of ["bash", "grep", "glob", "webfetch"]) {
      const compacted = await new ToolOutputShrinker(undefined, data).apply(tool, result(raw, { exit: 0 }))
      expect(compacted.output).toBe("red link")
      expect(compacted.metadata.exit).toBe(0)
      expect(compacted.metadata.truncated).toBe(false)
      expect(await artifact(compacted)).toBe(raw)
    }
    expect((await readdir(directory(data))).length).toBe(4)
  })

  test("leaves exact-threshold and ordinary short output untouched without artifacts", async () => {
    const data = await root()
    const shrinker = new ToolOutputShrinker({ maxBytes: 8, maxLines: 2 }, data)
    for (const raw of ["", "short", "abc\ndefg"]) {
      const original = result(raw)
      expect(await shrinker.apply("bash", original)).toBe(original)
    }
    await expect(stat(directory(data))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("never touches read/edit, other builtins, or unknown and MCP tool names", async () => {
    const data = await root()
    const shrinker = new ToolOutputShrinker({ maxBytes: 512, maxLines: 5 }, data)
    const original = result("\u001b[32m" + lines(100) + "\u001b[0m")
    for (const tool of ["read", "edit", "write", "apply_patch", "task", "websearch", "Bash", "custom", "mcp__server__bash", "server_bash", "toString", "constructor"]) {
      expect(await shrinker.apply(tool, original)).toBe(original)
    }
    expect(await new ToolOutputShrinker(false, data).apply("bash", original)).toBe(original)
    await expect(stat(directory(data))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("does not rewrite a stored preview, even through a fresh instance with stricter limits", async () => {
    const data = await root()
    const shrinker = new ToolOutputShrinker({ maxBytes: 1024, maxLines: 7 }, data)
    const compacted = await shrinker.apply("bash", result(lines(200)))
    const path = compacted.metadata.outputPath as string
    expect(await shrinker.apply("bash", compacted)).toBe(compacted)
    expect(await new ToolOutputShrinker({ maxBytes: 512, maxLines: 3 }, data).apply("bash", compacted)).toBe(compacted)
    expect(await readdir(directory(data))).toEqual([basename(path)])
    expect(await artifact(compacted)).toBe(lines(200))
  })

  test("keeps native full output instead of saving the native preview as raw", async () => {
    const data = await root()
    await mkdir(directory(data), { recursive: true })
    const path = join(directory(data), "tool_native123")
    const full = "raw-origin\n" + lines(500, 150) + "\nraw-end"
    await writeFile(path, full, { mode: 0o644 })
    const original = result(lines(100) + "\nNative preview only", { truncated: true, outputPath: path, matches: 500 })
    const compacted = await new ToolOutputShrinker({ maxBytes: 512, maxLines: 5 }, data).apply("grep", original)
    expect(compacted).not.toBe(original)
    expect(compacted.metadata.outputPath).toBe(path)
    expect(compacted.metadata.truncated).toBe(true)
    expect(compacted.metadata.matches).toBe(500)
    expect(Buffer.byteLength(compacted.output)).toBeLessThanOrEqual(512)
    expect(compacted.output.split("\n").length).toBeLessThanOrEqual(5)
    expect(await artifact(compacted)).toBe(full)
    expect(await readdir(directory(data))).toEqual([basename(path)])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(directory(data))).mode & 0o777).toBe(0o700)
  })

  test("does not treat a missing or invalid native artifact as complete raw output", async () => {
    const data = await root()
    const outside = join(data, "tool_outside")
    await writeFile(outside, "full output outside the native directory")
    await mkdir(directory(data), { recursive: true })
    const linked = join(directory(data), "tool_linked")
    await symlink(outside, linked)
    const subdirectory = join(directory(data), "tool_directory")
    await mkdir(subdirectory)
    const shrinker = new ToolOutputShrinker({ maxBytes: 512, maxLines: 5 }, data)
    for (const path of [undefined, "relative/tool_missing", join(directory(data), "tool_missing"), outside, linked, subdirectory]) {
      const original = result("\u001b[31m" + lines(100) + "\u001b[0m", { truncated: true, outputPath: path })
      expect(await shrinker.apply("bash", original)).toBe(original)
    }
    expect((await readdir(directory(data))).sort()).toEqual(["tool_directory", "tool_linked"])
    expect(await readFile(outside, "utf8")).toBe("full output outside the native directory")
  })

  test("keeps original output and metadata when artifact storage fails", async () => {
    const data = await root()
    await mkdir(join(data, "opencode"))
    await writeFile(directory(data), "not a directory")
    const original = result("\u001b[31m" + lines(100) + "\u001b[0m", { exit: 0, truncated: false })
    const compacted = await new ToolOutputShrinker({ maxBytes: 512, maxLines: 5 }, data).apply("bash", original)
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
    expect(await new ToolOutputShrinker({ maxBytes: 512, maxLines: 5 }, data).apply("bash", original)).toBe(original)
    expect(await readdir(outside)).toEqual([])
  })

  test("leaves the original intact when the retrieval hint cannot fit the requested budget", async () => {
    const data = await root()
    const original = result(lines(100))
    expect(await new ToolOutputShrinker({ maxBytes: 1, maxLines: 3 }, data).apply("bash", original)).toBe(original)
    await expect(stat(directory(data))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("preserves malformed metadata instead of dropping it during a transformation", async () => {
    const data = await root()
    const shrinker = new ToolOutputShrinker(undefined, data)
    for (const metadata of [undefined, null, "opaque", ["opaque"]]) {
      const original = { output: "\u001b[31mred\u001b[0m", metadata }
      expect(await shrinker.apply("bash", original)).toBe(original)
    }
    await expect(stat(directory(data))).rejects.toMatchObject({ code: "ENOENT" })
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
    const compacted = await shrinker.apply("bash", result("\u001b[31mred\u001b[0m"))
    expect(compacted.metadata.outputPath).toBe(join(directory(data), basename(compacted.metadata.outputPath as string)))
    expect(await artifact(compacted)).toBe("\u001b[31mred\u001b[0m")
  })

  test("validates thresholds, unknown keys, option shape and data directory", () => {
    for (const input of [null, true, [], "small", { unknown: 1 }, { maxBytes: 0 }, { maxBytes: -1 }, { maxBytes: 1.5 }, { maxBytes: Infinity }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }, { maxBytes: "100" }, { maxLines: 0 }, { maxLines: NaN }]) {
      expect(() => new ToolOutputShrinker(input)).toThrow()
    }
    expect(() => new ToolOutputShrinker({}, "relative")).toThrow()
    expect(() => new ToolOutputShrinker({ maxBytes: 512, maxLines: 3 })).not.toThrow()
  })
})
