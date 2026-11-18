import { describe, expect, test } from "bun:test"
import { makeModelEstimator, parseModelBudgets, resolveModelBudget, type ModelBudget } from "../src/model-budget"
import type { ChatBody } from "../src/shared"

const identity = { providerID: "team/gateway", modelID: "catalog/model" }
const model = "backend/deployment"
const prompt: ChatBody = { model, messages: [{ role: "user", content: "Can you help?" }] }

function estimateText(tokenizer: NonNullable<ModelBudget["tokenizer"]>) {
  const estimate = makeModelEstimator({ ...identity, tokenizer })
  if (!estimate) throw new Error(`Configured ${tokenizer} is unavailable`)
  return estimate
}

function measured(estimate: ReturnType<typeof estimateText>, body: ChatBody): number {
  const count = estimate(body)
  if (count === undefined) throw new Error("The text-only test request should be countable")
  return count
}

describe("explicit model budgets", () => {
  test("resolves the exact provider and catalog ID, not an equal suffix or wire model", () => {
    const budgets = parseModelBudgets([
      { ...identity, thresholdTokens: 1234 },
      { ...identity, providerID: "other/gateway", thresholdPercent: 52.5 },
      { providerID: "team", modelID: "gateway/catalog/model", thresholdTokens: 5678 },
    ])

    expect(resolveModelBudget(budgets, identity)?.thresholdTokens).toBe(1234)
    expect(resolveModelBudget(budgets, { ...identity, providerID: "other/gateway" })?.thresholdPercent).toBe(52.5)
    expect(resolveModelBudget(budgets, { providerID: "team", modelID: "gateway/catalog/model" })?.thresholdTokens).toBe(5678)
    for (const miss of [
      { ...identity, providerID: "gateway" },
      { ...identity, modelID: model },
      { ...identity, modelID: "model" },
      { ...identity, modelID: "CATALOG/model" },
    ]) expect(resolveModelBudget(budgets, miss)).toBeUndefined()
  })

  test("leaves the existing byte estimator in place unless an exact profile opts in", () => {
    const profile = { ...identity, thresholdTokens: -1 }
    expect(makeModelEstimator(resolveModelBudget(parseModelBudgets(undefined), identity))).toBeUndefined()
    expect(makeModelEstimator(resolveModelBudget(parseModelBudgets([profile]), identity))).toBeUndefined()
  })

  test.each([
    ["non-array", { ...identity }],
    ["null", null],
    ["unknown field", [{ ...identity, model }]],
    ["missing model ID", [{ providerID: identity.providerID, tokenizer: "o200k_base" }]],
    ["whitespace in ID", [{ ...identity, providerID: ` ${identity.providerID}` }]],
    ["blank model ID", [{ ...identity, modelID: "" }]],
    ["unknown encoding", [{ ...identity, tokenizer: "guess" }]],
    ["string token threshold", [{ ...identity, thresholdTokens: "1" }]],
    ["fractional token threshold", [{ ...identity, thresholdTokens: 1.1 }]],
    ["unsafe token threshold", [{ ...identity, thresholdTokens: Number.MAX_SAFE_INTEGER + 1 }]],
    ["invalid negative sentinel", [{ ...identity, thresholdTokens: -2 }]],
    ["out-of-range percent", [{ ...identity, thresholdPercent: 101 }]],
    ["nonfinite percent", [{ ...identity, thresholdPercent: Number.NaN }]],
    ["duplicate identity", [{ ...identity, thresholdTokens: 800 }, { ...identity, tokenizer: "cl100k_base" }]],
  ] as const)("rejects invalid configuration: %s", (_name, config) => {
    expect(() => parseModelBudgets(config)).toThrow()
  })
})

describe("tokenizer-based prompt budgeting", () => {
  test("uses the explicit encoding on text, not a model-name heuristic", () => {
    const body: ChatBody = { ...prompt, messages: [{ role: "user", content: "お誕生日おめでとう".repeat(20) }] }
    const cl100k = measured(estimateText("cl100k_base"), body)
    const o200k = measured(estimateText("o200k_base"), body)

    // For this Japanese phrase the cl100k encoding needs more tokens.
    expect(cl100k).toBeGreaterThan(o200k)
  })

  test("counts literal tokenizer control spellings as text without rejecting them", () => {
    const estimate = estimateText("o200k_base")
    const body: ChatBody = { ...prompt, messages: [{ role: "user", content: "<|endoftext|>".repeat(16) }] }

    expect(measured(estimate, body) - measured(estimate, prompt)).toBeGreaterThan(16)
  })

  test.each([
    ["function definition", {
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object", description: "model visible ".repeat(64) } } }],
    }],
    ["structured response schema", {
      response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "string", description: "model visible ".repeat(64) } } },
    }],
  ] as const)("accounts for the %s even if messages do not change", (_name, envelope) => {
    const estimate = estimateText("o200k_base")
    const withSchema: ChatBody = { ...prompt, ...envelope }

    expect(measured(estimate, withSchema) - measured(estimate, prompt)).toBeGreaterThan(100)
  })

  test("keeps tool turn estimates additive for usage anchors on different prefixes", () => {
    const estimate = estimateText("o200k_base")
    const added = [
      { role: "assistant", content: null, reasoning_content: "Use the tool first.",
        tool_calls: [{ type: "function", id: "call_fixture", function: { name: "read", arguments: '{"filePath":"/tmp/notes"}' } }] },
      { role: "tool", tool_call_id: "call_fixture", content: "Detailed tool output.".repeat(20) },
    ]
    const second: ChatBody = { ...prompt, messages: [{ role: "developer", content: "Policy" }, { role: "user", content: "Start!" }] }
    const increment = (prefix: ChatBody) =>
      measured(estimate, { ...prefix, messages: [...prefix.messages, ...added] }) - measured(estimate, prefix)

    const incrementOnFirst = increment(prompt)
    expect(incrementOnFirst).toBeGreaterThan(80)
    expect(increment(second)).toBe(incrementOnFirst)
  })

  test.each([
    ["image content", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/image" } }] }] }],
    ["unknown content type", { messages: [{ role: "user", content: [{ type: "future_part", text: "opaque" }] }] }],
    ["signed tool metadata", { messages: [{ role: "assistant", tool_calls: [{ type: "function", id: "c", function: { name: "read", arguments: "{}" }, extra_content: { google: { thought_signature: "opaque" } } }] }] }],
    ["provider-defined tool", { tools: [{ type: "web_search" }] }],
    ["unknown template option", { chat_template_kwargs: { add_hidden_context: "opaque" } }],
    ["unknown request option", { provider_specific_payload: "opaque" }],
    ["pathologically long BPE piece", { messages: [{ role: "user", content: "a".repeat(2048) }] }],
    ["too many expensive BPE pieces", { messages: [{ role: "user", content: `${"a".repeat(512)} `.repeat(70) }] }],
    ["total input beyond the bounded tokenizer", { messages: [{ role: "user", content: "word ".repeat(220_000) }] }],
  ] as const)("defers to the existing estimator for %s", (_name, candidate) => {
    const estimate = estimateText("o200k_base")
    const body: ChatBody = { ...prompt, ...candidate, messages: [...("messages" in candidate ? candidate.messages : prompt.messages)] }

    expect(estimate(body)).toBeUndefined()
  })
})
