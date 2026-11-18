import { Schema } from "effect"
import type { WireMessage } from "./prefix"
import { record, type ChatBody } from "./shared"

const id = Schema.NonEmptyString.check(Schema.isTrimmed())
const modelBudget = Schema.Struct({
  providerID: id,
  modelID: id,
  tokenizer: Schema.optionalKey(Schema.Literals(["cl100k_base", "o200k_base"])),
  thresholdTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1))),
  thresholdPercent: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100))),
})
export type ModelBudget = typeof modelBudget.Type
type ModelIdentity = Pick<ModelBudget, "providerID" | "modelID">

const read = Schema.decodeUnknownSync(Schema.Array(modelBudget).check(Schema.makeFilter<readonly ModelBudget[]>((budgets) => {
  const seen = new Set<string>()
  for (const { providerID, modelID } of budgets) {
    const key = JSON.stringify([providerID, modelID])
    if (seen.has(key)) return `Duplicate modelBudgets providerID/modelID pair: ${key}`
    seen.add(key)
  }
  return true
})), { onExcessProperty: "error" })

export function parseModelBudgets(input: unknown): readonly ModelBudget[] {
  return input === undefined ? [] : read(input)
}

export function resolveModelBudget(budgets: readonly ModelBudget[], identity: ModelIdentity): ModelBudget | undefined {
  return budgets.find(({ providerID, modelID }) => providerID === identity.providerID && modelID === identity.modelID)
}

type Encoding = Pick<typeof import("gpt-tokenizer/encoding/o200k_base"), "countTokens" | "setMergeCacheSize">
// Bun bundles each literal require but initializes only the explicitly chosen encoding.
const loadEncoding = {
  cl100k_base: (): Encoding => require("gpt-tokenizer/encoding/cl100k_base"),
  o200k_base: (): Encoding => require("gpt-tokenizer/encoding/o200k_base"),
} as const satisfies Record<NonNullable<ModelBudget["tokenizer"]>, () => Encoding>

const onlyFields = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key))
const text = (value: unknown): value is string => typeof value === "string"

function countableMessage(message: WireMessage) {
  if (!["system", "developer", "user", "assistant", "tool"].includes(message.role)) return false
  if (!onlyFields(message, ["role", "content", "name", "tool_call_id", "reasoning", "reasoning_content", "tool_calls"])) return false
  if (!["name", "tool_call_id", "reasoning", "reasoning_content"].every((key) => message[key] == null || text(message[key]))) return false
  const { content, tool_calls: calls } = message
  if (content != null && !text(content) && (!Array.isArray(content) || !content.every((part: unknown) =>
    record(part) && part.type === "text" && text(part.text) && onlyFields(part, ["type", "text"])))) return false
  return calls === undefined || Array.isArray(calls) && calls.every((call: unknown) =>
    record(call) && call.type === "function" && text(call.id) && onlyFields(call, ["type", "id", "function"])
    && record(call.function) && text(call.function.name) && text(call.function.arguments) && onlyFields(call.function, ["name", "arguments"]))
}

function functionTool(tool: unknown) {
  if (!record(tool) || tool.type !== "function" || !onlyFields(tool, ["type", "function"]) || !record(tool.function)) return false
  const definition = tool.function
  return onlyFields(definition, ["name", "description", "parameters", "strict"]) && text(definition.name)
    && (definition.description === undefined || text(definition.description))
    && (definition.parameters === undefined || record(definition.parameters))
    && (definition.strict === undefined || typeof definition.strict === "boolean")
}

function responseFormat(value: unknown) {
  if (!record(value)) return false
  if (value.type === "text" || value.type === "json_object") return onlyFields(value, ["type"])
  const schema = value.json_schema
  return value.type === "json_schema" && onlyFields(value, ["type", "json_schema"]) && record(schema)
    && onlyFields(schema, ["name", "description", "schema", "strict"]) && text(schema.name) && record(schema.schema)
    && (schema.description === undefined || text(schema.description))
    && (schema.strict === undefined || typeof schema.strict === "boolean")
}

function countableEnvelope(body: Omit<ChatBody, "messages">) {
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue
    switch (key) {
      case "tools":
        if (!Array.isArray(value) || !value.every(functionTool)) return false
        break
      case "response_format":
        if (!responseFormat(value)) return false
        break
      case "tool_choice":
        if (value === "auto" || value === "none" || value === "required") break
        if (!record(value) || value.type !== "function" || !onlyFields(value, ["type", "function"])
          || !record(value.function) || !onlyFields(value.function, ["name"]) || !text(value.function.name)) return false
        break
      case "stream_options":
        if (!record(value) || !onlyFields(value, ["include_usage", "include_obfuscation"])
          || !Object.values(value).every((flag) => typeof flag === "boolean")) return false
        break
      case "chat_template_kwargs":
        if (!record(value) || !onlyFields(value, ["enable_thinking", "preserve_thinking", "clear_thinking", "reasoning_effort"])
          || !Object.entries(value).every(([name, flag]) => name === "reasoning_effort" ? text(flag) : typeof flag === "boolean")) return false
        break
      case "stop":
        if (value !== null && !text(value) && (!Array.isArray(value) || !value.every(text))) return false
        break
      case "max_tokens": case "max_completion_tokens": case "max_output_tokens": case "temperature":
      case "top_p": case "top_k": case "frequency_penalty": case "presence_penalty": case "n": case "seed":
        if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) return false
        break
      case "stream": case "parallel_tool_calls": case "enable_thinking": case "preserve_thinking":
        if (typeof value !== "boolean") return false
        break
      case "model": case "user": case "reasoning_effort": case "verbosity":
      case "prompt_cache_key": case "cache_salt": case "service_tier":
        if (!text(value)) return false
        break
      default:
        return false
    }
  }
  return true
}

const inputLimit = 1024 * 1024
const mergeWorkLimit = 16 * inputLimit

// Bound the JSON walk before serializing large/deep schemas. Wire bodies are plain
// JSON, but internally assembled candidates may still have undefined fields.
function boundedJson(body: ChatBody) {
  let units = inputLimit
  let nodes = 32768
  const visit = (value: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 64) return false
    if (text(value)) return (units -= value.length) >= 0
    if (value == null || typeof value === "boolean") return true
    if (typeof value === "number") return Number.isFinite(value)
    if (Array.isArray(value)) {
      if (value.length > nodes) return false
      for (const child of value) if (child === undefined || !visit(child, depth + 1)) return false
      return true
    }
    if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
    return Object.entries(value).every(([key, child]) => (units -= key.length) >= 0 && visit(child, depth + 1))
  }
  return visit(body, 0)
}

export function makeModelEstimator(budget: ModelBudget | undefined): ((body: ChatBody) => number | undefined) | undefined {
  if (!budget?.tokenizer) return undefined
  const { countTokens, setMergeCacheSize } = loadEncoding[budget.tokenizer]()
  // Do not keep prompt text in the tokenizer's process-global merge cache.
  setMergeCacheSize(0)
  const ordinaryText = { disallowedSpecial: new Set<string>() }
  return (body) => {
    if (!boundedJson(body)) return undefined
    const { messages, ...envelope } = body
    if (!countableEnvelope(envelope) || !messages.every(countableMessage)) return undefined

    // Separate segments keep the appended estimate independent of prior bytes.
    // Include JSON syntax, roles, calls, tools and schemas, plus framing rather
    // than assuming the provider uses one exact chat template.
    const segments = [JSON.stringify(envelope), ...messages.map((message) => JSON.stringify(message))]
    let units = 0
    let mergeWork = 0
    for (const segment of segments) {
      units += segment.length
      if (units > inputLimit) return undefined
      // BPE merges can be quadratic for long runs such as pasted base64.
      for (const [run] of segment.matchAll(/\s+|\S+/g)) {
        mergeWork += run.length * run.length
        if (run.length > 1024 || mergeWork > mergeWorkLimit) return undefined
      }
    }
    return segments.reduce((tokens, segment) => tokens + countTokens(segment, ordinaryText), 3 + 4 * messages.length)
  }
}
