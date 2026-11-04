// Adapted from OMP compaction/utils.ts and utils/path-tree.ts; see THIRD_PARTY_NOTICES.
import type { WireMessage } from "./prefix"
import { record } from "./shared"
import { formatCompactionPrompt } from "./compaction-prompts"
import template from "./prompts/compaction/file-operations.md" with { type: "text" }

export function withFileOperations(summary: string, messages: WireMessage[]) {
  const read = new Set<string>()
  const modified = new Set<string>()
  const range = /^(?:L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?)(?:,L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?)*$/i
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      if (!record(call) || !record(call.function) || !["read", "write", "edit"].includes(String(call.function.name)) || typeof call.function.arguments !== "string") continue
      let args: unknown
      try { args = JSON.parse(call.function.arguments) } catch { continue }
      const value = record(args) ? args.path ?? args.filePath : undefined
      if (typeof value !== "string" || !value || /[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue
      let path = value
      if (call.function.name === "read") {
        const colon = path.lastIndexOf(":")
        const selector = path.slice(colon + 1)
        if (colon > 0 && (range.test(selector) || /^(?:raw|conflicts)$/i.test(selector))) {
          path = path.slice(0, colon)
          const inner = path.lastIndexOf(":")
          const innerSelector = path.slice(inner + 1)
          if (inner > 0 && (/^raw$/i.test(selector) && range.test(innerSelector) || range.test(selector) && /^raw$/i.test(innerSelector))) path = path.slice(0, inner)
        }
        read.add(path)
      } else modified.add(path)
    }
  }
  const all = [...new Set([...read, ...modified])].sort()
  // Source history remains authoritative across checkpoints, so generated or
  // stale file lists cannot invent file operations on the next update.
  const base = summary.replace(/<files>[\s\S]*?<\/files>\s*/g, "").replace(/<read-files>[\s\S]*?<\/read-files>\s*/g, "").replace(/<modified-files>[\s\S]*?<\/modified-files>\s*/g, "").trimEnd()
  if (!all.length) return base
  type Node = { files: { name: string; path: string }[]; dirs: Map<string, Node> }
  const root: Node = { files: [], dirs: new Map() }
  for (const path of all.slice(0, 20)) {
    const normalized = path.replace(/\\/g, "/")
    const parts = normalized.replace(/\/$/, "").split("/")
    let node = root
    const directories = normalized.endsWith("/") ? parts.length : parts.length - 1
    for (const directory of parts.slice(0, directories)) {
      let child = node.dirs.get(directory)
      if (!child) { child = { files: [], dirs: new Map() }; node.dirs.set(directory, child) }
      node = child
    }
    if (!normalized.endsWith("/") && !node.files.some((file) => file.name === parts.at(-1))) node.files.push({ name: parts.at(-1)!, path })
  }
  const lines: string[] = []
  const walk = (node: Node, depth: number) => {
    for (const file of node.files) lines.push(`${file.name} (${modified.has(file.path) ? read.has(file.path) ? "RW" : "Write" : "Read"})`)
    for (const [directory, child] of node.dirs) {
      let nested = child
      const names = [directory]
      while (!nested.files.length && nested.dirs.size === 1) {
        const [name, next] = [...nested.dirs][0]!
        names.push(name)
        nested = next
      }
      lines.push(`${"#".repeat(depth + 1)} ${names.join("/")}/`)
      walk(nested, depth + 1)
    }
  }
  walk(root, 0)
  if (all.length > 20) lines.push(`[…${all.length - 20} files elided…]`)
  const files = formatCompactionPrompt(template.replace(/{{#if files}}|{{\/if}}/g, "").replace('{{#xml "files"}}', "<files>").replace("{{/xml}}", "</files>").replace("{{files}}", () => lines.join("\n")))
  return base ? `${base}\n\n${files}` : files
}
