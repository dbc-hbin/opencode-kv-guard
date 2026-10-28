import type { Plugin } from "@opencode-ai/plugin"
import { admittedFetch, endpointGate, type Fetch } from "./transport"
import { canonical, Environments, ModeReminders, PrefixAudit, stripEnvironmentDate, UserTurns } from "./prefix"
import { compactSystem } from "./compact"
import { RollingCompaction, type ChatBody } from "./compaction"

const agentHeader = "x-opencode-kv-guard-agent"
const limitsHeader = "x-opencode-kv-guard-limits"
const userHeader = "x-opencode-kv-guard-user"

const plugin: Plugin = async ({ client }, options = {}) => {
  const allowed = ["providers", "maxConcurrent", "maxOutputTokens", "compactPrompt", "stabilizeEnvironment", "retainModeReminders", "canonicalToolSchemas", "promptCacheKey", "compaction", "diagnostics"]
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new Error(`KV guard: unknown option ${key}`)
  }
  if (!Array.isArray(options.providers) || !options.providers.length || options.providers.some((id) => typeof id !== "string" || !id)) {
    throw new Error("KV guard: providers must be a nonempty array of explicit OpenCode provider IDs")
  }
  const providers = new Set<string>(options.providers)
  const activeProviders = new Set<string>()
  const maxConcurrent = options.maxConcurrent ?? 1
  if (typeof maxConcurrent !== "number" || !Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new Error("KV guard: maxConcurrent must be a positive integer")
  }
  const maxOutputTokens = options.maxOutputTokens
  if (maxOutputTokens !== undefined && (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)) {
    throw new Error("KV guard: maxOutputTokens must be a positive integer")
  }
  for (const key of ["compactPrompt", "stabilizeEnvironment", "retainModeReminders", "canonicalToolSchemas", "promptCacheKey", "diagnostics"]) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") throw new Error(`KV guard: ${key} must be boolean`)
  }

  const environments = new Environments()
  const reminders = new ModeReminders()
  const audit = new PrefixAudit()
  const compaction = new RollingCompaction(options.compaction)
  const userTurns = new UserTurns()

  return {
    async config(config) {
      // Resolve every target before mutating config. The v1.19.4 provider loader
      // runs this hook before constructing SDK instances and copies options.fetch.
      const targets = [...providers].map((id) => {
        const provider = config.provider?.[id]
        if (!provider || provider.npm !== "@ai-sdk/openai-compatible") {
          throw new Error(`KV guard: ${id} must be explicitly configured with @ai-sdk/openai-compatible`)
        }
        const configuredURL = provider.options?.baseURL
        if (typeof configuredURL !== "string" || !configuredURL) throw new Error(`KV guard: ${id} needs options.baseURL`)
        const baseURL = configuredURL.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
          const value = process.env[key]
          if (value === undefined) throw new Error(`KV guard: unresolved baseURL environment variable ${key}`)
          return value
        })
        if (baseURL.includes("${")) throw new Error(`KV guard: ${id} has unresolved baseURL variables`)
        const endpoint = new URL(baseURL.replace(/\/$/, "") + "/chat/completions")
        if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error(`KV guard: ${id} needs an HTTP baseURL`)
        const custom = provider.options?.fetch
        if (custom !== undefined && typeof custom !== "function") throw new Error(`KV guard: ${id} has a non-function fetch`)
        return { id, provider, baseURL, endpoint, gate: endpointGate(baseURL, maxConcurrent), fetch: (custom ?? globalThis.fetch) as Fetch }
      })
      for (const target of targets) {
        target.provider.options ??= {}
        target.provider.options.baseURL = target.baseURL
        target.provider.options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          const method = init?.method ?? (input instanceof Request ? input.method : "GET")
          if (method.toUpperCase() !== "POST" || url.origin !== target.endpoint.origin || url.pathname !== target.endpoint.pathname) {
            return target.fetch(input, init)
          }
          const request = new Request(input instanceof Request ? input.clone() : input, init)
          let body = await request.json() as ChatBody
          const headers = new Headers(request.headers)
          const session = headers.get("x-opencode-session-id") ?? headers.get("x-session-id")
          const agent = headers.get(agentHeader)
          const encodedLimits = headers.get(limitsHeader)
          const expectedUser = headers.get(userHeader)
          headers.delete(agentHeader)
          headers.delete(limitsHeader)
          headers.delete(userHeader)
          headers.delete("content-length")
          const currentUser = userTurns.consume(body.messages, session && expectedUser ? userTurns.marker(session, expectedUser) : undefined)
          const lane = JSON.stringify([target.id, body.model, session, agent])
          if (session && !headers.has("x-litellm-session-id")) {
            // Preserve OpenCode's parent-session affinity for subagents.
            headers.set("x-litellm-session-id", headers.get("x-parent-session-id") ?? session)
          }
          // Core mode expansion camel-cases arbitrary wire fields; compatible
          // 2.0.41 only translates its small set of recognized SDK options.
          for (const [camel, wire] of [
            ["promptCacheKey", "prompt_cache_key"], ["cacheSalt", "cache_salt"],
            ["chatTemplateKwargs", "chat_template_kwargs"], ["enableThinking", "enable_thinking"],
            ["preserveThinking", "preserve_thinking"], ["maxTokens", "max_tokens"],
            ["maxCompletionTokens", "max_completion_tokens"],
          ] as const) {
            if (!Object.hasOwn(body, camel)) continue
            if (camel === "maxTokens" && typeof body.maxTokens === "number" && typeof body.max_tokens === "number") {
              // max_tokens is also populated by the SDK itself; a smaller
              // mode limit must not be discarded as if it were explicit.
              body.max_tokens = Math.min(body.max_tokens, body.maxTokens)
            } else if (!Object.hasOwn(body, wire)) body[wire] = body[camel]
            delete body[camel]
          }
          if (options.promptCacheKey === true && session) body.prompt_cache_key ??= session
          if (maxOutputTokens !== undefined) {
            // Provider-specific passthrough fields can override chat.params.
            if (typeof body.max_completion_tokens === "number") {
              body.max_completion_tokens = Math.min(body.max_completion_tokens, maxOutputTokens)
              delete body.max_tokens
            } else body.max_tokens = Math.min(typeof body.max_tokens === "number" ? body.max_tokens : maxOutputTokens, maxOutputTokens)
          }
          if (options.canonicalToolSchemas !== false && body.tools) body.tools = canonical(body.tools)
          if (session && agent && options.stabilizeEnvironment !== false) environments.apply(body.messages, session, lane)
          if (session && agent && encodedLimits) {
            const allowSummary = !["title", "summary", "compaction"].includes(agent)
            if (allowSummary && options.compaction !== false && !currentUser) {
              throw new Error("KV guard: current user provenance was removed by another transform; cannot compact safely")
            }
            const limits: unknown = JSON.parse(encodedLimits)
            if (!limits || typeof limits !== "object" || !("context" in limits) || typeof limits.context !== "number") {
              throw new Error("KV guard: invalid model context metadata")
            }
            const output = body.max_completion_tokens ?? body.max_tokens
            if (typeof output !== "number") throw new Error("KV guard: an actual completion token limit is required")
            const prepared = await compaction.prepare(body, {
              session, lane, contextWindow: limits.context,
              inputLimit: "input" in limits && typeof limits.input === "number" && limits.input > 0 ? limits.input : undefined,
              outputLimit: output, signal: request.signal,
              allowSummary, currentUser,
              completeSummary: (summary) => admittedFetch(target.fetch, target.gate, input, {
                ...init, headers, body: JSON.stringify(summary), signal: request.signal,
              }),
            })
            if ("response" in prepared) return prepared.response
            body = prepared.body
            if (options.diagnostics === true && prepared.report) {
              await client.app.log({ body: { service: "kv-guard", level: "info", message: "Preflight compaction estimate (not tokenizer usage)", extra: prepared.report } })
            }
          }
          if (session && agent && options.diagnostics === true) {
            const report = audit.observe(body, session, lane)
            // Only hashes/count comparisons; no prompts, credentials, paths, or tool arguments.
            await client.app.log({ body: { service: "kv-guard", level: "info", message: "Request prefix comparison (not a token-cache hit measurement)", extra: report } })
          }
          return admittedFetch(target.fetch, target.gate, input, { ...init, headers, body: JSON.stringify(body), signal: request.signal })
        }
        activeProviders.add(target.id)
      }
    },
    async "chat.params"(input, output) {
      if (!activeProviders.has(input.model.providerID) || maxOutputTokens === undefined) return
      output.maxOutputTokens = Math.min(output.maxOutputTokens ?? maxOutputTokens, maxOutputTokens)
    },
    async "chat.headers"(input, output) {
      if (!activeProviders.has(input.model.providerID)) return
      output.headers[agentHeader] = input.agent
      output.headers[limitsHeader] = JSON.stringify(input.model.limit)
      if (options.compaction !== false) output.headers[userHeader] = input.message.id
    },
    async "experimental.chat.system.transform"(input, output) {
      if (!activeProviders.has(input.model.providerID)) return
      if (options.compactPrompt !== false) compactSystem(output.system)
      stripEnvironmentDate(output.system)
    },
    async "experimental.chat.messages.transform"(_input, output) {
      userTurns.clean(output.messages)
      if (options.retainModeReminders !== false) reminders.apply(output.messages, activeProviders)
      if (options.compaction !== false) userTurns.mark(output.messages, activeProviders)
    },
    async event({ event }) {
      if (event.type !== "session.deleted") return
      const session = event.properties.info.id
      environments.delete(session)
      reminders.delete(session)
      audit.delete(session)
      compaction.delete(session)
    },
    async dispose() {
      environments.clear()
      reminders.clear()
      audit.clear()
      compaction.clear()
    },
  }
}

export default plugin
