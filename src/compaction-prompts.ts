// OMP 1c291b87e4b889398cc4b8e4ccdfa650b56a0486, MIT; see THIRD_PARTY_NOTICES.
import handoff from "./prompts/compaction/handoff-document.md" with { type: "text" }
import thresholdFocus from "./prompts/compaction/auto-handoff-threshold-focus.md" with { type: "text" }
import system from "./prompts/compaction/summarization-system.md" with { type: "text" }
import initial from "./prompts/compaction/compaction-summary.md" with { type: "text" }
import update from "./prompts/compaction/compaction-update-summary.md" with { type: "text" }
import turnPrefix from "./prompts/compaction/compaction-turn-prefix.md" with { type: "text" }
import summaryContext from "./prompts/compaction/compaction-summary-context.md" with { type: "text" }

// prompt.render() uses OMP's default post-render formatter: no symbol or RFC
// rewriting, but whitespace/XML/table normalization outside fenced code.
export function formatCompactionPrompt(text: string) {
  const lines = text.split("\n")
  const result: string[] = []
  let fenced = false
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!.trimEnd()
    const trimmed = line.trimStart()
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fenced = !fenced
      result.push(line)
      continue
    }
    if (fenced) { result.push(line); continue }
    if (/^\|[-:\s|]+\|$/.test(trimmed)) {
      const cells = trimmed.split("|").filter((cell) => cell.trim()).map((cell) => {
        const value = cell.trim()
        return value.startsWith(":") ? value.endsWith(":") ? ":---:" : ":---" : value.endsWith(":") ? "---:" : "---"
      })
      line = `${line.slice(0, line.length - trimmed.length)}|${cells.join("|")}|`
    } else if (/^\|.*\|$/.test(trimmed)) line = line.slice(0, line.length - trimmed.length) + trimmed.split("|").map((cell) => cell.trim()).join("|")
    if (!line) {
      if (lines[index + 1] === undefined || !lines[index + 1]!.trim()) {
        while (result.at(-1) === "") result.pop()
        while (index + 1 < lines.length && !lines[index + 1]!.trim()) index++
        continue
      }
      if (!result.length || result.at(-1) === "") continue
    }
    if (/^<\/[a-z_-]+>$/.test(trimmed)) while (result.at(-1) === "") result.pop()
    result.push(line)
  }
  while (result.at(-1) === "") result.pop()
  return result.join("\n")
}

export const summarizationSystem = formatCompactionPrompt(system)

// This is the upstream template's only conditional, not a general template engine.
export function handoffPrompt(automatic: boolean, scope?: string) {
  const additionalFocus = [automatic ? thresholdFocus.trim() : "", scope ?? ""].filter(Boolean).join("\n\n")
  return formatCompactionPrompt(handoff.replace(/{{#if additionalFocus}}\n([\s\S]*?){{\/if}}\n?/, (_, content: string) =>
    additionalFocus ? content.replace("{{additionalFocus}}", () => additionalFocus) : ""))
}

export function escapeSummaryBoundaries(text: string) {
  return text.replace(/<\s*\/?\s*(?:conversation|previous-summary)\s*>/gi, (tag) => `&lt;${tag.slice(1)}`)
}

export function summaryPrompt(conversation: string, previous?: string, splitTurn = false, context: string[] = []) {
  const prior = previous ? `<previous-summary>\n${escapeSummaryBoundaries(previous)}\n</previous-summary>\n\n` : ""
  const additional = context.length ? `<additional-context>\n${context.map((line) => `- ${line}`).join("\n")}\n</additional-context>\n\n` : ""
  const instructions = splitTurn ? turnPrefix : previous ? update : initial
  return `<conversation>\n${escapeSummaryBoundaries(conversation)}\n</conversation>\n\n${prior}${additional}${formatCompactionPrompt(instructions)}`
}

export function summaryMessage(summary: string) {
  return formatCompactionPrompt(summaryContext.replace("{{summary}}", () => summary))
}
