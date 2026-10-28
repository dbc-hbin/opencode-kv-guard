import type { ChatBody } from "./compaction"

export type ReasoningEffort = "low" | "high" | "max"
export type GLMOptions = {
  models: string[]
  reasoningEffort: ReasoningEffort
  clearThinking: boolean
  cumulativeReasoning: boolean
}
export type GLMPolicyReport = {
  targeted: boolean
  cumulativeReasoning: boolean
  reasoningEffort?: ReasoningEffort
  clearThinking?: boolean
  effortSource?: "profile" | "request" | "conflict" | "opaque"
  clearThinkingSource?: "profile" | "request" | "conflict" | "opaque"
  changes: string[]
  conflicts: string[]
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const effort = (value: unknown): value is ReasoningEffort => value === "low" || value === "high" || value === "max"

export function parseGLMOptions(input: unknown): GLMOptions | false {
  if (input === undefined || input === false) return false
  if (!record(input)) throw new Error("KV guard: glm must be false or an options object")
  for (const key of Object.keys(input)) {
    if (!["models", "reasoningEffort", "clearThinking", "cumulativeReasoning"].includes(key)) throw new Error(`KV guard: unknown glm option ${key}`)
  }
  if (!Array.isArray(input.models) || !input.models.length || input.models.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim())) {
    throw new Error("KV guard: glm.models must be a nonempty array of exact model IDs")
  }
  if (input.reasoningEffort !== undefined && !effort(input.reasoningEffort)) throw new Error("KV guard: glm.reasoningEffort must be low, high or max")
  for (const key of ["clearThinking", "cumulativeReasoning"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`KV guard: glm.${key} must be boolean`)
  }
  // Public nvidia/GLM-5.3-NVFP4 chat_template.jinja starts with the effort
  // system segment (default max), and defaults clear_thinking to false.
  return {
    models: [...input.models],
    reasoningEffort: effort(input.reasoningEffort) ? input.reasoningEffort : "max",
    clearThinking: input.clearThinking === true,
    cumulativeReasoning: input.cumulativeReasoning === true,
  }
}

export function normalizeGLMRequest(body: ChatBody, options: GLMOptions | false): { body: ChatBody; report: GLMPolicyReport } {
  const targeted = options !== false && options.models.includes(body.model)
  const report: GLMPolicyReport = { targeted, cumulativeReasoning: targeted && options.cumulativeReasoning, changes: [], conflicts: [] }
  if (!targeted) return { body, report }

  let result = body
  const containers = ["chat_template_kwargs", "chatTemplateKwargs"] as const
  const present = containers.filter((key) => Object.hasOwn(body, key))
  const opaque = present.some((key) => !record(body[key]))
  const dual = present.length > 1
  if (dual || opaque) report.conflicts.push(...present)

  // Inspect all aliases before canonicalizing anything. A conflicting spelling
  // is left intact rather than choosing a precedence the server did not promise.
  for (const [camel, wire, fallback] of [
    ["reasoningEffort", "reasoning_effort", options.reasoningEffort],
    ["clearThinking", "clear_thinking", options.clearThinking],
  ] as const) {
    const fields: { path: string; value: unknown }[] = []
    for (const key of [wire, camel]) if (Object.hasOwn(body, key)) fields.push({ path: key, value: body[key] })
    for (const container of present) {
      const kwargs = body[container]
      if (!record(kwargs)) continue
      for (const key of [wire, camel]) if (Object.hasOwn(kwargs, key)) fields.push({ path: `${container}.${key}`, value: kwargs[key] })
    }
    const invalid = fields.filter((field) => wire === "reasoning_effort" ? !effort(field.value) : typeof field.value !== "boolean")
    const conflict = fields.some((field) => !Object.is(field.value, fields[0]?.value))
    const source = conflict || dual ? "conflict" : opaque || invalid.length ? "opaque" : fields.length ? "request" : "profile"
    if (conflict) report.conflicts.push(...fields.map((field) => field.path))
    if (source === "opaque") report.conflicts.push(...invalid.map((field) => field.path))
    const effective = source === "profile" ? fallback : source === "request" ? fields[0]!.value : undefined
    if (wire === "reasoning_effort") {
      report.effortSource = source
      if (effort(effective)) report.reasoningEffort = effective
    } else {
      report.clearThinkingSource = source
      if (typeof effective === "boolean") report.clearThinking = effective
    }
    if (source === "conflict" || source === "opaque") continue
    if (result === body) result = { ...body }
    if (!fields.length) {
      if (wire === "reasoning_effort") {
        result[wire] = fallback
        report.changes.push(wire)
      } else {
        // clear_thinking is a template argument, not an invented thinking-off
        // control. Never remove historical plaintext reasoning from messages.
        const container = present[0] ?? "chat_template_kwargs"
        result[container] = { ...(record(result[container]) ? result[container] : {}), [wire]: fallback }
        report.changes.push(`${container}.${wire}`)
      }
      continue
    }
    if (Object.hasOwn(result, camel)) {
      if (!Object.hasOwn(result, wire)) result[wire] = result[camel]
      delete result[camel]
      report.changes.push(`${camel}->${wire}`)
    }
    for (const container of present) {
      const kwargs = result[container]
      if (!record(kwargs) || !Object.hasOwn(kwargs, camel)) continue
      const normalized = { ...kwargs }
      if (!Object.hasOwn(normalized, wire)) normalized[wire] = normalized[camel]
      delete normalized[camel]
      result[container] = normalized
      report.changes.push(`${container}.${camel}->${wire}`)
    }
  }
  if (!dual && !opaque && Object.hasOwn(result, "chatTemplateKwargs")) {
    if (result === body) result = { ...body }
    result.chat_template_kwargs = result.chatTemplateKwargs
    delete result.chatTemplateKwargs
    report.changes.push("chatTemplateKwargs->chat_template_kwargs")
  }
  return { body: report.changes.length ? result : body, report }
}

const reasoningAliases = ["reasoning_content", "reasoning", "reasoning_text"] as const
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0

// Instantiate once for each response. This only adapts parsed JSON; the response
// observer owns framing, cancellation, usage collection and stream lifetime.
export function createGLMChunkAdapter(model: string, options: GLMOptions | false): (value: unknown) => unknown {
  if (options === false || !options.models.includes(model)) return (value) => value
  const snapshots = new Map<number, string>()
  return (value) => {
    if (!record(value) || !Array.isArray(value.choices)) return value
    const inputChoices = value.choices
    const indices = new Set<number>()
    const choices = inputChoices.map((choice) => {
      if (!record(choice)) return choice
      const key = record(choice.delta) ? "delta" : record(choice.message) ? "message" : undefined
      if (!key) return choice
      const message = choice[key] as Record<string, unknown>
      if ((message.role !== undefined && message.role !== "assistant") ||
        (message.content !== undefined && message.content !== null && typeof message.content !== "string") ||
        Object.keys(message).some((name) => !["role", "content", "tool_calls", "function_call", "refusal", ...reasoningAliases].includes(name)) ||
        reasoningAliases.some((name) => message[name] !== undefined && message[name] !== null && typeof message[name] !== "string")) return choice
      const alias = reasoningAliases.find((name) => nonempty(message[name]))
      if (!alias) return choice
      const text = message[alias] as string
      let normalized = message
      let delta = text
      if (options.cumulativeReasoning && key === "delta") {
        // Missing indices are unambiguous only in a single-choice chunk.
        const index = typeof choice.index === "number" && Number.isSafeInteger(choice.index) && choice.index >= 0 ? choice.index : inputChoices.length === 1 && choice.index === undefined ? 0 : undefined
        if (index === undefined) throw new Error("KV guard: GLM cumulative reasoning requires an unambiguous choice index")
        if (indices.has(index)) throw new Error("KV guard: GLM cumulative reasoning requires unique choice indices")
        indices.add(index)
        const previous = snapshots.get(index) ?? ""
        if (!text.startsWith(previous)) throw new Error("KV guard: GLM cumulative reasoning must be append-only")
        snapshots.set(index, text)
        delta = text.slice(previous.length)
      }
      // SDK 2.0.41 uses reasoning_content ?? reasoning. An empty primary
      // otherwise masks a nonempty supported fallback, including cumulative deltas.
      if (alias === "reasoning" && message.reasoning_content === "") {
        normalized = { ...normalized }
        delete normalized.reasoning_content
      }
      if (alias === "reasoning_text") {
        normalized = { ...normalized, reasoning_content: delta }
        delete normalized.reasoning_text
      } else if (delta !== text) normalized = { ...normalized, [alias]: delta }
      // Do not manufacture a second copy when a gateway mirrors the same text.
      // Other aliases can carry distinct data and remain byte-for-byte intact.
      if (normalized !== message) {
        for (const other of reasoningAliases) {
          if (other !== alias && other !== "reasoning_content" && normalized[other] === text) delete normalized[other]
        }
      }
      return normalized === message ? choice : { ...choice, [key]: normalized }
    })
    return choices.every((choice, index) => choice === inputChoices[index]) ? value : { ...value, choices }
  }
}
