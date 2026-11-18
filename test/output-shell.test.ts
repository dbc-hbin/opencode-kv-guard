import { afterEach, expect, test } from "bun:test"
import type { Result } from "@opencode/plugin/promise/tool"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { ToolOutputShrinker } from "../src/output"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function root() {
  const path = await mkdtemp(join(tmpdir(), "kv-guard-shell-output-"))
  roots.push(path)
  return path
}

const paragraph = (text: string) => ({ type: "text", text } as const)

function text(result: Result) {
  if (typeof result.content === "string") throw new Error("Expected separate shell output and status parts")
  return result.content?.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n") ?? ""
}

test("reuses the native raw shell file and preserves its separate timeout notice", async () => {
  const data = await root()
  const shellDirectory = join(data, "opencode", "shell", "project-id")
  await mkdir(shellDirectory, { recursive: true })
  const path = join(shellDirectory, "sh_01998b84ef42Native12345678.out")
  const raw = "native command bytes\n".repeat(500)
  await writeFile(path, raw)
  const annotation = paragraph("Command timed out after 120 seconds.\nExit code: unknown")
  const display = `head\n${"preview\n".repeat(100)}[full output saved to ${path}]`
  const original = {
    content: [paragraph(display), annotation],
    output: { output: display, outputPath: path, exitCode: null, wallTimeSeconds: 120 },
    metadata: { truncated: true, timeout: true },
  }
  const compacted = await new ToolOutputShrinker({ maxBytes: 1024, maxLines: 7 }, data).apply("shell", original)
  expect(compacted).not.toBe(original)
  expect(Array.isArray(compacted.content) ? compacted.content.at(-1) : undefined).toBe(annotation)
  expect(compacted.metadata?.outputPath).toBe(path)
  expect(text(compacted)).toContain(`[Output shortened; full output: ${JSON.stringify(path)}]`)
  expect(text(compacted).split("\n").length).toBeLessThanOrEqual(7)
  expect(Buffer.byteLength(text(compacted))).toBeLessThanOrEqual(1024)
  expect(await readFile(path, "utf8")).toBe(raw)
  expect(await readdir(shellDirectory)).toEqual([basename(path)])
  await expect(stat(join(data, "opencode", "tool-output"))).rejects.toMatchObject({ code: "ENOENT" })
  expect(await new ToolOutputShrinker({ maxBytes: 1024, maxLines: 3 }, data).apply("shell", original)).toBe(original)
})

test("shortens command output that imitates a native status notice without changing the actual notice", async () => {
  const data = await root()
  const literal = "Exit code: 137 (SIGKILL)\n" + "output\n".repeat(600)
  const annotation = paragraph("Exit code: 2")
  const original = { content: [paragraph(literal), annotation], metadata: { exit: 2 } }
  const compacted = await new ToolOutputShrinker({ maxBytes: 4096, maxLines: 40 }, data).apply("shell", original)
  expect(compacted).not.toBe(original)
  expect(text(compacted).endsWith(annotation.text)).toBe(true)
  expect(Buffer.byteLength(text(compacted))).toBeLessThanOrEqual(4096)
  expect(text(compacted).split("\n").length).toBeLessThanOrEqual(40)
  const path: unknown = compacted.metadata?.outputPath
  if (typeof path !== "string") throw new Error("Expected a retained stdout path")
  expect(await readFile(path, "utf8")).toBe(literal)
})
