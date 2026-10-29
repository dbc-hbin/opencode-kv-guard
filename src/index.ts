import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { admittedFetch, endpointGate, type AdmissionGate, type Fetch } from "./transport"
import { processEndpointGate } from "./process-gate"
import { canonical, Environments, ModeReminders, PrefixAudit, stripEnvironmentDate, UserTurns } from "./prefix"
import { compactSystem } from "./compact"
import { ContextOverflowError, RollingCompaction, constrainedOutput, overflowPromptTokens, providerError, readSummary, summaryRequestBase, type ChatBody, type ProviderError, type SummaryResult } from "./compaction"
import { CheckpointStore, type CheckpointSnapshot } from "./checkpoints"
import { UsageTracker, observeResponse } from "./usage"
import { parseGLMOptions, normalizeGLMRequest, createGLMChunkAdapter } from "./glm"
import { compactSkillCatalog } from "./skills"
import { compactToolDescriptions } from "./tools"
import { ToolOutputShrinker } from "./output"
import { SessionHeads, PrefixGuard } from "./heads"
import { digest as hash, record } from "./shared"

const agentHeader = "x-opencode-kv-guard-agent"
const limitsHeader = "x-opencode-kv-guard-limits"
const userHeader = "x-opencode-kv-guard-user"
const systemSuffixHeader = "x-opencode-kv-guard-system-suffix"
// Internal OpenCode agents that never own a resumable conversation.
const internalAgents = ["title", "summary", "compaction"]
// Pinned OpenCode 1.19.4 compaction prompt (core session/compaction.ts
// buildPrompt): the serialized history this plugin replaces with the cached
// wire prefix, followed by the native summary instructions it keeps.
const nativeConversationStart = "Here is the conversation so far:\n\n<conversation>\n"
const nativeConversationEnd = "\n</conversation>\n\n"
type Exchange = { target: string; headScope: string; lane: string; userID: string; body: ChatBody; assistant: ChatBody["messages"][number] }

const plugin: Plugin = async ({ client, project, directory, worktree }, options = {}) => {
  const allowed = ["providers", "maxConcurrent", "maxOutputTokens", "compactPrompt", "stabilizeEnvironment", "retainModeReminders", "canonicalToolSchemas", "promptCacheKey", "compaction", "diagnostics", "usageAccounting", "crossProcess", "persistence", "stateDirectory", "glm", "compactSkills", "compactTools", "sessionHeads", "prefixGuard", "prefixHandoff", "shrinkToolOutputs", "continueTruncated", "speculativeCompaction"]
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
  for (const key of ["compactPrompt", "stabilizeEnvironment", "retainModeReminders", "canonicalToolSchemas", "promptCacheKey", "diagnostics", "usageAccounting", "crossProcess", "persistence", "compactSkills", "compactTools", "sessionHeads", "prefixGuard", "prefixHandoff", "continueTruncated", "speculativeCompaction"]) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") throw new Error(`KV guard: ${key} must be boolean`)
  }
  if (options.stateDirectory !== undefined && (typeof options.stateDirectory !== "string" || !isAbsolute(options.stateDirectory))) {
    throw new Error("KV guard: stateDirectory must be an absolute path")
  }
  const stateDirectory = options.stateDirectory ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode-kv-guard")
  const glm = parseGLMOptions(options.glm)
  const outputShrinker = options.shrinkToolOutputs === false ? undefined : new ToolOutputShrinker(options.shrinkToolOutputs)
  const outputSessions = new Set<string>()
  const outputCalls = new Map<string, Set<string>>()

  const environments = new Environments()
  const reminders = new ModeReminders()
  const audit = new PrefixAudit()
  const heads = new SessionHeads()
  const prefixGuard = new PrefixGuard()
  const compaction = new RollingCompaction(options.compaction)
  const userTurns = new UserTurns()
  const usage = new UsageTracker()
  const sessionLanes = new Map<string, Set<string>>()
  const parentHeadLanes = new Map<string, Map<string, string>>()
  const stateTails = new Map<string, Promise<void>>()
  const pendingDeletions = new Map<string, Promise<void>>()
  const deletionFailures: unknown[] = []
  const deleted = new Set<string>()
  // Last completed main request per session, kept so a manual /compact can
  // summarize by extending that exact prefix instead of a fresh transcript.
  const lastExchanges = new Map<string, Exchange>()
  const nativeCompactions = new Set<string>()
  // Provider targets observed rejecting tool_choice "none" on a summary.
  const toolChoiceNoneRejected = new Set<string>()
  const manualHandoff = options.compaction !== false && options.prefixHandoff !== false
  const disposed = new AbortController()
  let store: CheckpointStore | undefined
  const log = async (message: string, extra: Record<string, unknown>) => {
    if (options.diagnostics === true) await client.app.log({ body: { service: "kv-guard", level: "info", message, extra } })
  }
  // Rolling compaction runs inside the provider fetch, so OpenCode never shows
  // its own compaction feedback. Mirror it with TUI toasts titled like the
  // builtin notifier (session title, then the event message).
  const compactionNotice = (session: string) => {
    let title: Promise<string | undefined> | undefined
    let started = false
    const show = (message: string, variant: "info" | "success") => {
      title ??= Promise.resolve().then(() => client.session.get({ path: { id: session } })).then((result) => result.data?.title)
      void title.then((resolved) => client.tui.showToast({ body: { title: resolved, message, variant } })).catch((error) =>
        Promise.resolve().then(() => client.app.log({ body: { service: "kv-guard", level: "warn", message: "Compaction notification failed", extra: { error: error instanceof Error ? error.message : String(error) } } })).catch(() => {}))
    }
    return {
      summary(run: () => Promise<Response>) {
        if (!started) { started = true; show("Compacting session", "info") }
        return run()
      },
      finished(report?: Record<string, unknown>) {
        if (typeof report?.summaryRequests === "number" && report.summaryRequests > 0 || report?.speculative === true) show("Session compacted", "success")
      },
    }
  }
  // OpenCode ends the loop silently when a response stops at the output
  // limit without a tool call, which leaves reasoning-only or cut-off turns
  // unfinished. Continue such a turn with a synthetic (model-only) prompt,
  // at most three times in a row, as current harnesses do.
  const truncatedHandled = new Map<string, { assistant: string; count: number }>()
  const truncatedLimit = 3
  const truncatedReminder = "<system-reminder>\nThe previous response stopped at the output token limit before finishing. Continue the task from where it stopped. Keep reasoning brief and split large outputs or edits into smaller steps.\n</system-reminder>"
  const truncatedPending = new Set<string>()
  const continueTruncated = async (session: string) => {
    // One check per session at a time; a second idle event during it would
    // otherwise see the same truncated response and continue it twice.
    if (options.continueTruncated === false || deleted.has(session) || truncatedPending.has(session)) return
    truncatedPending.add(session)
    try {
      const messages = (await client.session.messages({ path: { id: session } })).data ?? []
      const last = messages.at(-1)?.info
      const prior = truncatedHandled.get(session)
      // OpenCode stores the finish reason before a cancelled step records its
      // error and completion time, and can publish idle in between; only a
      // completed assistant is a real truncation.
      if (last?.role !== "assistant" || last.finish !== "length" || !last.time.completed || last.error || last.summary || !activeProviders.has(last.providerID) || internalAgents.includes(last.mode)) {
        truncatedHandled.delete(session)
        return
      }
      if (prior?.assistant === last.id) return
      // A subagent's result was already returned to its parent task.
      if ((await client.session.get({ path: { id: session } })).data?.parentID) return
      // Count consecutive continuations only; a real user turn starts over.
      const parent = messages.find((message) => message.info.id === last.parentID)
      const continued = !!parent?.parts.length && parent.parts.every((part) => part.type === "text" && part.synthetic && part.text === truncatedReminder)
      const count = (continued ? prior?.count ?? 0 : 0) + 1
      truncatedHandled.set(session, { assistant: last.id, count })
      if (count > truncatedLimit) {
        await client.tui.showToast({ body: { message: `Response hit the output limit ${truncatedLimit} times in a row; not continuing automatically`, variant: "warning" } }).catch(() => {})
        return
      }
      // Repeat the turn's own settings: an omitted variant is stored as the
      // session default, and a different system prompt breaks the prefix.
      // The 1.19.4 v1 SDK types omit variant/format, which the server accepts.
      const user = parent?.info.role === "user" ? parent.info as typeof parent.info & { model: { variant?: string }; format?: unknown } : undefined
      await client.session.promptAsync({
        path: { id: session },
        body: {
          agent: user?.agent ?? last.mode,
          model: { providerID: last.providerID, modelID: last.modelID },
          ...(user?.system !== undefined ? { system: user.system } : {}),
          ...(user?.model.variant !== undefined ? { variant: user.model.variant } : {}),
          ...(user?.format !== undefined ? { format: user.format } : {}),
          parts: [{ type: "text", synthetic: true, text: truncatedReminder }],
        } as NonNullable<Parameters<typeof client.session.promptAsync>[0]["body"]>,
      })
      await log("Continued a response truncated at the output limit", { attempt: count })
    } catch (error) {
      await client.app.log({ body: { service: "kv-guard", level: "warn", message: "Truncated response continuation failed", extra: { error: error instanceof Error ? error.message : String(error) } } }).catch(() => {})
    } finally {
      truncatedPending.delete(session)
    }
  }
  // A manual /compact may reuse the recorded exchange only when nothing was
  // added since: the compaction marker must follow that exact user turn,
  // and the recorded response must be its last completed assistant step.
  const manualExchange = async (session: string, targetID: string, headScope: string, model: string): Promise<Exchange | undefined> => {
    const exchange = lastExchanges.get(session)
    if (!exchange || exchange.target !== targetID || exchange.headScope !== headScope || exchange.body.model !== model) return undefined
    const stored = await client.session.messages({ path: { id: session } })
    const messages = stored.data ?? []
    const marker = messages.findLastIndex((message) => message.info.role === "user" && message.parts.some((part) => part.type === "compaction"))
    if (marker < 0) return undefined
    const user = messages.slice(0, marker).findLastIndex((message) => message.info.role === "user")
    if (user < 0 || messages[user]!.info.id !== exchange.userID) return undefined
    const between = messages.slice(user + 1, marker).map((message) => message.info)
    if (!between.length) return undefined
    for (const info of between) {
      if (info.role !== "assistant" || info.error || !info.finish || info.summary) return undefined
    }
    const last = between.at(-1)!
    if (last.role !== "assistant" || ["tool-calls", "unknown"].includes(last.finish ?? "")) return undefined
    return exchange
  }
  const checkpoint = async <T>(session: string, action: () => T | Promise<T>, completedResponse = false): Promise<T> => {
    const prior = stateTails.get(session) ?? Promise.resolve()
    const pending = prior.then(async () => {
      if (!completedResponse) disposed.signal.throwIfAborted()
      if (deleted.has(session)) throw new Error("KV guard: session was deleted")
      const loaded = store ? await store.load(session) : undefined
      if (loaded?.reason === "deleted") throw new Error("KV guard: session checkpoint was deleted")
      const empty: CheckpointSnapshot = { modes: { messages: [] }, environments: { lanes: [] }, compaction: { lanes: [] } }
      if (loaded) {
        const snapshot = loaded.snapshot ?? empty
        if (!await compaction.restore(session, snapshot.compaction) || !reminders.restore(session, snapshot.modes) || !environments.restore(session, snapshot.environments) || !heads.restore(session, snapshot.heads ?? { version: 1, session, lanes: [] }) || !prefixGuard.restore(session, snapshot.prefixGuard ?? { version: 1, session, lanes: [] })) {
          throw new Error("KV guard: checkpoint cannot be restored during concurrent state changes")
        }
        if (loaded.reason) await log("Checkpoint cache miss", { reason: loaded.reason })
      }
      const result = await action()
      try {
        if (!completedResponse) disposed.signal.throwIfAborted()
        if (deleted.has(session)) throw new Error("KV guard: session was deleted during preparation")
        if (store && loaded) {
          const snapshot = { modes: reminders.snapshot(session), environments: environments.snapshot(session), compaction: compaction.snapshot(session), heads: heads.snapshot(session), prefixGuard: prefixGuard.snapshot(session) }
          if (JSON.stringify(snapshot) !== JSON.stringify(loaded.snapshot ?? empty)) await store.save(session, snapshot, loaded.revision)
        }
        return result
      } catch (error) {
        // An unpublished summary response still owns its admission slot.
        if (result instanceof Response) await result.body?.cancel().catch(() => {})
        throw error
      }
    })
    const tail = pending.then(() => {}, () => {})
    stateTails.set(session, tail)
    void tail.then(() => { if (stateTails.get(session) === tail) stateTails.delete(session) })
    return pending
  }

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
        // OpenCode 1.19.4 timeoutFetch applies these provider options outside
        // our wrapper; detached summaries reapply them per request.
        const headerTimeout = provider.options?.headerTimeout === false ? undefined : provider.options?.headerTimeout ?? 300_000
        const requestTimeout = provider.options?.timeout === false || provider.options?.timeout == null ? undefined : provider.options.timeout
        const summaryTimeouts = { header: typeof headerTimeout === "number" ? headerTimeout : undefined, request: typeof requestTimeout === "number" ? requestTimeout : undefined }
        const local = endpointGate(baseURL, maxConcurrent)
        const shared = options.crossProcess === false ? undefined : processEndpointGate(baseURL, maxConcurrent, join(stateDirectory, "admission"))
        const gate: AdmissionGate = shared ? {
          capacity: maxConcurrent,
          async acquire(signal) {
            const releaseLocal = await local.acquire(signal)
            try {
              const releaseShared = await shared.acquire(signal)
              return async () => { try { await releaseShared() } finally { releaseLocal() } }
            } catch (error) {
              releaseLocal()
              throw error
            }
          },
        } : local
        return { id, provider, baseURL, endpoint, gate, summaryTimeouts, fetch: (custom ?? globalThis.fetch) as Fetch }
      })
      if (options.persistence !== false) store = new CheckpointStore(
        join(stateDirectory, "checkpoints"), JSON.stringify([project?.id, directory, worktree]),
        JSON.stringify(canonical({
          version: 1, providers: [...providers].sort(), compaction: compaction.options,
          compactPrompt: options.compactPrompt !== false, compactSkills: options.compactSkills !== false, compactTools: options.compactTools !== false,
          stabilizeEnvironment: options.stabilizeEnvironment !== false, retainModeReminders: options.retainModeReminders !== false,
          canonicalToolSchemas: options.canonicalToolSchemas !== false, glm,
          sessionHeads: options.sessionHeads !== false, prefixGuard: options.prefixGuard !== false,
          prefixHandoff: options.prefixHandoff !== false, shrinkToolOutputs: outputShrinker?.limits ?? false,
        })),
      )
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
          const signal = AbortSignal.any([request.signal, disposed.signal])
          let body = await request.json() as ChatBody
          const headers = new Headers(request.headers)
          const session = headers.get("x-opencode-session-id") ?? headers.get("x-session-id")
          const agent = headers.get(agentHeader)
          const encodedLimits = headers.get(limitsHeader)
          const expectedUser = headers.get(userHeader)
          const encodedSystemSuffix = headers.get(systemSuffixHeader)
          headers.delete(agentHeader)
          headers.delete(limitsHeader)
          headers.delete(userHeader)
          headers.delete(systemSuffixHeader)
          headers.delete("content-length")
          const currentUser = userTurns.consume(body.messages, session && expectedUser ? userTurns.marker(session, expectedUser) : undefined)
          // Endpoint and credential identity isolate restored state and usage
          // even when provider aliases or session affinity headers are shared.
          url.hash = ""
          const lane = hash(JSON.stringify([target.id, url.href, [...headers].filter(([name]) => name !== "x-opencode-request").sort(([a], [b]) => a.localeCompare(b)), body.model, session, agent]))
          const headScope = hash(JSON.stringify([target.id, url.href, [...headers].filter(([name]) => !["x-opencode-request", "x-opencode-session-id", "x-session-id", "x-opencode-parent-session-id", "x-parent-session-id", "x-session-affinity", "x-litellm-session-id"].includes(name)).sort(([a], [b]) => a.localeCompare(b)), body.model]))
          const headLane = hash(JSON.stringify([headScope, agent]))
          if (session) {
            const lanes = sessionLanes.get(session) ?? new Set<string>()
            lanes.add(lane)
            sessionLanes.set(session, lanes)
          }
          if (session && !headers.has("x-litellm-session-id")) {
            // Preserve OpenCode's parent-session affinity for subagents.
            headers.set("x-litellm-session-id", headers.get("x-parent-session-id") ?? session)
          }
          // Inspect both spellings before the generic repair can discard a
          // conflicting GLM template container.
          const normalized = normalizeGLMRequest(body, glm)
          body = normalized.body
          if (normalized.report.targeted) await log("GLM request policy", { ...normalized.report })
          // Core mode expansion camel-cases arbitrary wire fields; compatible
          // 2.0.41 only translates its small set of recognized SDK options.
          for (const [camel, wire] of [
            ["promptCacheKey", "prompt_cache_key"], ["cacheSalt", "cache_salt"],
            ["chatTemplateKwargs", "chat_template_kwargs"], ["enableThinking", "enable_thinking"],
            ["preserveThinking", "preserve_thinking"], ["maxTokens", "max_tokens"],
            ["maxCompletionTokens", "max_completion_tokens"],
          ] as const) {
            if (camel === "chatTemplateKwargs" && normalized.report.targeted) continue
            if (!Object.hasOwn(body, camel)) continue
            if (camel === "maxTokens" && typeof body.maxTokens === "number" && typeof body.max_tokens === "number") {
              // max_tokens is also populated by the SDK itself; a smaller
              // mode limit must not be discarded as if it were explicit.
              body.max_tokens = Math.min(body.max_tokens, body.maxTokens)
            } else if (!Object.hasOwn(body, wire)) body[wire] = body[camel]
            delete body[camel]
          }
          if (options.promptCacheKey === true && session) body.prompt_cache_key ??= session
          if (options.usageAccounting !== false && target.provider.options?.includeUsage !== false && body.stream === true && (body.stream_options === undefined || body.stream_options && typeof body.stream_options === "object" && !Array.isArray(body.stream_options))) {
            body.stream_options = { include_usage: true, ...body.stream_options as Record<string, unknown> | undefined }
          }
          if (maxOutputTokens !== undefined) {
            // Provider-specific passthrough fields can override chat.params.
            if (typeof body.max_completion_tokens === "number") {
              body.max_completion_tokens = Math.min(body.max_completion_tokens, maxOutputTokens)
              delete body.max_tokens
            } else body.max_tokens = Math.min(typeof body.max_tokens === "number" ? body.max_tokens : maxOutputTokens, maxOutputTokens)
          }
          if (options.compactTools !== false && Array.isArray(body.tools)) {
            const compacted = compactToolDescriptions(body.tools)
            body.tools = compacted.tools
            if (compacted.report) await log("Tool description compression", { ...compacted.report })
          }
          if (options.canonicalToolSchemas !== false && body.tools) body.tools = canonical(body.tools)
          if (options.compactSkills !== false && encodedSystemSuffix) {
            const suffix: unknown = JSON.parse(encodedSystemSuffix)
            if (!suffix || typeof suffix !== "object" || !("length" in suffix) || typeof suffix.length !== "number" || !Number.isSafeInteger(suffix.length) || suffix.length < 0 || !("hash" in suffix) || typeof suffix.hash !== "string" || !/^[a-f0-9]{64}$/.test(suffix.hash)) throw new Error("KV guard: invalid user system suffix metadata")
            const compacted = compactSkillCatalog(body, { userSystem: suffix.length ? { length: suffix.length, hash: suffix.hash } : undefined })
            body = compacted.body
            if (compacted.report) await log("Skill catalog compression", { ...compacted.report })
          }
          let replayReceipt: string | undefined
          // Summary handoffs keep the cached tools and ask for no tool calls.
          // A server that rejects tool_choice "none" (other than as overflow)
          // gets "auto" plus the summary instruction, and is remembered so
          // later summaries do not repeat the failing request.
          // `attempt` sends one summary request; detached summaries pass one that
          // applies fresh provider deadlines to each actual send.
          const sendSummary = async (outgoing: ChatBody, attempt = (body: ChatBody) => send(body, "summary")) => {
            if (outgoing.tool_choice !== "none") return attempt(outgoing)
            if (toolChoiceNoneRejected.has(target.id)) return attempt({ ...outgoing, tool_choice: "auto" })
            const response = await attempt(outgoing)
            if (response.ok) return response
            const error = await providerError(response)
            if (!error) return response
            if (error.overflow) return error.response()
            toolChoiceNoneRejected.add(target.id)
            await log("Summary tool_choice none was rejected; using auto", { status: response.status })
            return attempt({ ...outgoing, tool_choice: "auto" })
          }
          let afterMain: (() => void) | undefined
          const send = async (outgoing: ChatBody, label: "main" | "summary", requestSignal = signal) => {
            if (session && agent && label === "main" && !internalAgents.includes(agent)) lastExchanges.delete(session)
            const requestLane = label === "summary" ? `${lane}:summary` : lane
            const ticket = usage.begin(outgoing, requestLane)
            let admissionWaitMs = 0
            const gate: AdmissionGate = {
              capacity: target.gate.capacity,
              async acquire(waitSignal) {
                const started = performance.now()
                const release = await target.gate.acquire(waitSignal)
                admissionWaitMs = performance.now() - started
                return release
              },
            }
            const response = await admittedFetch(target.fetch, gate, input, { ...init, headers, body: JSON.stringify(outgoing), signal: requestSignal })
            return observeResponse(response, {
              body: outgoing, lane: requestLane, tracker: usage, request: ticket, signal: requestSignal, label,
              transform: glm && glm.models.includes(outgoing.model) ? createGLMChunkAdapter(outgoing.model, glm) : undefined,
              onAssistant: session && agent && label === "main" && (options.prefixGuard !== false || manualHandoff && !internalAgents.includes(agent)) ? (assistant) => {
                if (manualHandoff && !internalAgents.includes(agent) && expectedUser) lastExchanges.set(session, { target: target.id, headScope, lane, userID: expectedUser, body: outgoing, assistant })
                if (options.prefixGuard === false) return
                // Enqueue synchronously before EOF so the next request cannot
                // restore an older checkpoint over this completed response.
                void checkpoint(session, () => prefixGuard.record(outgoing, assistant, { session, lane, outcome: "success", finishReason: assistant.tool_calls ? "tool_calls" : "stop", receipt: replayReceipt }), true)
                  .catch(() => log("Response replay checkpoint was not retained", { laneFingerprint: lane }).catch(() => {}))
              } : undefined,
              onReport: (report) => {
                // The endpoint is free once the main response has ended, and
                // stays free while OpenCode runs tools or waits for the user.
                if (label === "main" && report.outcome === "complete") afterMain?.()
                return log("Request usage and lifecycle", { ...report, admissionWaitMs, upstreamHeaderMs: Math.max(0, report.headerMs - admissionWaitMs) })
              },
            })
          }
          // Manual /compact: summarize by extending the last dispatched main
          // request, so the prefix stays KV-cached, and answer OpenCode's own
          // compaction request with that summary. Any mismatch keeps the
          // native request unchanged.
          const manualCompaction = async (sessionID: string): Promise<Response | undefined> => {
            // The native request is [compaction system, one user prompt]. Keep
            // its instructions (template, prior summary, plugin context) and
            // drop only the serialized history the cached prefix replaces.
            const prompt = body.messages.at(-1)
            const text = prompt?.role === "user" && typeof prompt.content === "string" ? prompt.content : undefined
            const end = text?.startsWith(nativeConversationStart) ? text.indexOf(nativeConversationEnd) : -1
            if (!text || end < 0) {
              await log("Manual compaction kept the native request", { reason: "unrecognized compaction prompt" })
              return undefined
            }
            const system = body.messages.filter((message) => message.role === "system")
            if (system.some((message) => typeof message.content !== "string")) return undefined
            // Keep custom agent prompts and system-transform output without
            // rewriting the cached system prefix that this handoff extends.
            const systemInstructions = system.map((message) => message.content).join("\n\n")
            const instructions = text.slice(end + nativeConversationEnd.length)
            let exchange: Exchange | undefined
            try { exchange = await manualExchange(sessionID, target.id, headScope, body.model) } catch (error) {
              await log("Manual compaction kept the native request", { reason: "history unavailable", error: error instanceof Error ? error.message : String(error) })
              return undefined
            }
            if (!exchange) {
              await log("Manual compaction kept the native request", { reason: "no matching cached exchange" })
              return undefined
            }
            const prior = exchange.body
            if (constrainedOutput(prior)) {
              await log("Manual compaction kept the native request", { reason: "constrained output" })
              return undefined
            }
            const limits: unknown = JSON.parse(encodedLimits!)
            const output = typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : typeof body.max_tokens === "number" ? body.max_tokens : undefined
            if (!record(limits) || typeof limits.context !== "number" || output === undefined) return undefined
            const handoff: ChatBody = {
              ...summaryRequestBase(prior),
              ...(prior.tools !== undefined ? { tools: prior.tools, tool_choice: "none" } : {}),
              messages: [...prior.messages, exchange.assistant, {
                role: "user",
                content: `<conversation> consists of every message above in this request. This is a summary handoff: do not continue the task, answer questions in it, or call tools.\n\nFor this handoff, follow these compaction-agent system instructions instead of the task instructions in the conversation above:\n<compaction-system-instructions>\n${systemInstructions}\n</compaction-system-instructions>\n\n${instructions}`,
              }],
              stream: false,
              ...(prior.max_completion_tokens !== undefined ? { max_completion_tokens: output } : { max_tokens: output }),
            }
            const fallback = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / (compaction.options ? compaction.options.bytesPerToken : 4))
            const size = options.usageAccounting === false ? fallback(handoff) : usage.estimate(handoff, exchange.lane, fallback)
            const budget = Math.min(typeof limits.input === "number" && limits.input > 0 ? limits.input : Infinity, limits.context - output) - (compaction.options ? compaction.options.marginTokens : 0)
            if (size > budget) {
              await log("Manual compaction kept the native request", { reason: "handoff exceeds budget", estimated: size, budget })
              return undefined
            }
            const notice = compactionNotice(sessionID)
            const response = await notice.summary(() => sendSummary(handoff))
            if (!response.ok) {
              const error = await providerError(response)
              // The handoff is longer than OpenCode's own serialized request;
              // an overflow here does not mean the native request overflows.
              if (error?.overflow) {
                await log("Manual compaction kept the native request", { reason: "handoff context overflow" })
                return undefined
              }
              return error ? error.response() : response
            }
            let summary: SummaryResult
            try { summary = await readSummary(response, signal) } catch (error) {
              await log("Manual compaction kept the native request", { reason: "summary rejected", error: error instanceof Error ? error.message : String(error) })
              return undefined
            }
            notice.finished({ summaryRequests: 1 })
            lastExchanges.delete(sessionID)
            await log("Manual compaction via prefix handoff", { estimated: size, budget, cachedMessages: prior.messages.length + 1 })
            const id = typeof summary.completion.id === "string" ? summary.completion.id : `kv-guard-${hash(summary.content).slice(0, 16)}`
            const created = Math.floor(Date.now() / 1000)
            const usageField = summary.completion.usage !== undefined ? { usage: summary.completion.usage } : {}
            if (body.stream !== true) return Response.json({ id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: summary.content }, finish_reason: "stop" }], ...usageField })
            // OpenCode streams compaction like any turn; replay the validated
            // summary as one SSE completion so the SDK consumes it unchanged.
            const frames = [
              { choices: [{ index: 0, delta: { role: "assistant", content: summary.content }, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
              ...(summary.completion.usage !== undefined ? [{ choices: [], ...usageField }] : []),
            ]
            const events = frames.map((frame) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, ...frame })}\n\n`).join("")
            return new Response(events + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
          }
          if (session && agent === "compaction" && manualHandoff && encodedLimits) {
            const handled = await manualCompaction(session)
            if (handled) return handled
          }
          const prepare = async (overflow?: { promptTokens?: number }) => {
            const parentSession = headers.get("x-opencode-parent-session-id") ?? headers.get("x-parent-session-id") ?? undefined
            const headContext = { session: session ?? "", lane: headLane, currentUser, parentSession, parentLane: parentSession ? parentHeadLanes.get(parentSession)?.get(headScope) : undefined }
            const replacements = new Map<ChatBody["messages"][number], ChatBody["messages"][number]>()
            if (session && agent && options.prefixGuard !== false) {
              const sources = new Set(body.messages)
              let probe = { ...body, messages: [...body.messages] }
              if (options.stabilizeEnvironment !== false) environments.apply(probe.messages, session, lane, { reconstruct: true })
              if (options.sessionHeads !== false) probe = heads.apply(probe, { ...headContext, reconstruct: true }).body
              if (encodedLimits && options.compaction !== false) probe = compaction.reconstruct(probe, { session, lane, currentUser })
              const restored = prefixGuard.apply(probe, { session, lane, currentUser, observe: false })
              for (const { index } of restored.report.replayed) {
                const source = probe.messages[index]!
                if (sources.has(source)) replacements.set(source, restored.body.messages[index]!)
              }
            }
            // Proofs affect anchor validation only. Emit the raw source objects:
            // a real policy/history reset must still invalidate final wire replay.
            if (session && agent && options.stabilizeEnvironment !== false) environments.apply(body.messages, session, lane, { replacements })
            if (session && agent && options.sessionHeads !== false) {
              const prepared = heads.apply(body, { ...headContext, replacements })
              body = prepared.body
              await log("Session head contract", { ...prepared.report })
              if (!internalAgents.includes(agent)) {
                const lanes = parentHeadLanes.get(session) ?? new Map<string, string>()
                lanes.set(headScope, headLane)
                parentHeadLanes.set(session, lanes)
              }
            }
            if (session && agent && options.prefixGuard !== false && (!encodedLimits || options.compaction === false)) {
              const guarded = prefixGuard.apply(body, { session, lane, currentUser, observe: false })
              body = guarded.body
            }
            if (session && agent && encodedLimits) {
              const allowSummary = !internalAgents.includes(agent)
              if (allowSummary && options.compaction !== false && !currentUser) {
                throw new Error("KV guard: current user provenance was removed by another transform; cannot compact safely")
              }
              const limits: unknown = JSON.parse(encodedLimits)
              if (!limits || typeof limits !== "object" || !("context" in limits) || typeof limits.context !== "number") {
                throw new Error("KV guard: invalid model context metadata")
              }
              const output = body.max_completion_tokens ?? body.max_tokens
              if (typeof output !== "number") throw new Error("KV guard: an actual completion token limit is required")
              const notice = compactionNotice(session)
              const compactionContext = {
                session, lane, contextWindow: limits.context,
                inputLimit: "input" in limits && typeof limits.input === "number" && limits.input > 0 ? limits.input : undefined,
                outputLimit: output, signal,
                allowSummary, currentUser, prefixHandoff: options.prefixHandoff !== false,
                restoreReasoning: options.prefixGuard === false ? undefined : (effective: ChatBody) => prefixGuard.apply(effective, { session, lane, currentUser, observe: false }).body,
                estimate: options.usageAccounting === false ? undefined : (candidate: ChatBody, fallback: (value: unknown) => number) => usage.estimate(candidate, lane, fallback),
                overflow,
                speculate: options.speculativeCompaction === true && allowSummary,
                completeSummary: (summary: ChatBody) => notice.summary(() => sendSummary(summary)),
              }
              const history = body
              const prepared = await compaction.prepare(body, compactionContext)
              if ("response" in prepared) return prepared.response
              notice.finished(prepared.report)
              if (prepared.report?.speculate) {
                // Near the trigger: once this response ends, compact the same
                // history in the background, independent of this request's
                // lifetime. It is adopted only if history still matches it.
                afterMain = () => {
                  afterMain = undefined
                  compaction.speculate(history, {
                    ...compactionContext, signal: disposed.signal, overflow: undefined,
                    // Like timeoutFetch, each detached request gets the provider's
                    // header deadline (cleared once headers arrive) and total timeout.
                    completeSummary: (summary, summarySignal) => sendSummary(summary, async (body) => {
                      const header = target.summaryTimeouts.header === undefined ? undefined : new AbortController()
                      const timer = header && setTimeout(() => header.abort(new DOMException("Summary header timeout", "TimeoutError")), target.summaryTimeouts.header)
                      const signals = [summarySignal ?? disposed.signal, ...(header ? [header.signal] : []), ...(target.summaryTimeouts.request === undefined ? [] : [AbortSignal.timeout(target.summaryTimeouts.request)])]
                      // The header deadline ends when this attempt's headers arrive.
                      try { return await send(body, "summary", AbortSignal.any(signals)) } finally { clearTimeout(timer) }
                    }),
                  })
                  void log("Speculative compaction started", { estimated: prepared.report?.estimatedAfter ?? null })
                }
              }
              body = prepared.body
              if (prepared.report) await log("Preflight budget (usage-anchored when available; otherwise estimated)", prepared.report)
            }
            if (session && agent && options.prefixGuard !== false) {
              const guarded = prefixGuard.apply(body, { session, lane, currentUser, replay: false })
              body = guarded.body
              replayReceipt = guarded.report.receipt
              await log("Prefix guard comparison", { ...guarded.report })
            }
          }
          // Preparation rewrites the body and splices its messages; keep the
          // incoming list so an overflow retry prepares the same history again.
          const incoming = { ...body, messages: [...body.messages] }
          const observePrefix = async () => {
            if (!session || !agent || options.diagnostics !== true) return
            const report = audit.observe(body, session, lane)
            // Only hashes/count comparisons; no prompts, credentials, paths, or tool arguments.
            await client.app.log({ body: { service: "kv-guard", level: "info", message: "Request prefix comparison (not a token-cache hit measurement)", extra: report } })
          }
          const canRecover = !!session && !!agent && !!encodedLimits && options.compaction !== false && !internalAgents.includes(agent)
          // Overflow recovery prepares the same history once more with the
          // provider's report applied, then resends. Used when either the main
          // request or a summary handoff that extends it overflows.
          const recover = async (error: ProviderError) => {
            const overflow = { promptTokens: overflowPromptTokens(error.text) }
            body = { ...incoming, messages: [...incoming.messages] }
            try {
              const retried = await checkpoint(session!, () => prepare(overflow))
              if (retried) return retried
            } catch (cause) {
              if (signal.aborted) throw cause
              await log("Context overflow recovery failed", { error: cause instanceof Error ? cause.message : String(cause) })
              return error.response()
            }
            await log("Context overflow recovery", { reportedPromptTokens: overflow.promptTokens ?? null })
            await observePrefix()
            return send(body, "main")
          }
          let failed: Response | undefined
          try {
            failed = session && agent ? await checkpoint(session, () => prepare()) : await prepare()
          } catch (error) {
            if (!(error instanceof ContextOverflowError) || !canRecover) throw error
            return recover(error.error)
          }
          if (failed) return failed
          await observePrefix()
          const response = await send(body, "main")
          // The byte estimate can undercount. When the provider rejects the
          // request as too long, compact below its reported size and resend
          // once, as current harnesses do, instead of failing the turn.
          if (response.ok || !canRecover) return response
          const error = await providerError(response)
          if (!error?.overflow) return error ? error.response() : response
          return recover(error)
        }
        activeProviders.add(target.id)
      }
    },
    async "chat.params"(input, output) {
      if (!activeProviders.has(input.model.providerID) || maxOutputTokens === undefined) return
      output.maxOutputTokens = Math.min(output.maxOutputTokens ?? maxOutputTokens, maxOutputTokens)
    },
    async "chat.headers"(input, output) {
      if (input.agent === "compaction") nativeCompactions.delete(input.sessionID)
      if (!internalAgents.includes(input.agent)) {
        if (activeProviders.has(input.model.providerID)) outputSessions.add(input.sessionID)
        else outputSessions.delete(input.sessionID)
      }
      if (!activeProviders.has(input.model.providerID)) return
      output.headers[agentHeader] = input.agent
      output.headers[limitsHeader] = JSON.stringify(input.model.limit)
      const system = input.message.system ?? ""
      output.headers[systemSuffixHeader] = JSON.stringify({ length: system.length, hash: hash(system) })
      if (options.compaction !== false) output.headers[userHeader] = input.message.id
    },
    async "tool.execute.before"(input) {
      if (!outputShrinker || !outputSessions.has(input.sessionID)) return
      const calls = outputCalls.get(input.sessionID) ?? new Set<string>()
      calls.add(input.callID)
      outputCalls.set(input.sessionID, calls)
    },
    async "tool.execute.after"(input, output) {
      const calls = outputCalls.get(input.sessionID)
      const selected = calls?.delete(input.callID)
      if (!calls?.size) outputCalls.delete(input.sessionID)
      if (!outputShrinker || !selected) return
      Object.assign(output, await outputShrinker.apply(input.tool, output))
    },
    async "experimental.chat.system.transform"(input, output) {
      if (!activeProviders.has(input.model.providerID)) return
      if (options.compactPrompt !== false) compactSystem(output.system)
      stripEnvironmentDate(output.system)
    },
    async "experimental.session.compacting"(input) {
      // Native compaction transforms a selected history without its marker part.
      // The next transform for this session serializes text, not a guarded request.
      nativeCompactions.add(input.sessionID)
    },
    async "experimental.chat.messages.transform"(_input, output) {
      userTurns.clean(output.messages)
      const current = output.messages.findLast((message) => message.info.role === "user")
      // Set by experimental.session.compacting immediately before this transform;
      // session.idle clears a flag left by a compaction cancelled in between.
      const nativeCompaction = current ? nativeCompactions.delete(current.info.sessionID) : false
      if (current?.info.role === "user" && activeProviders.has(current.info.model.providerID)) {
        await checkpoint(current.info.sessionID, () => {
          if (options.retainModeReminders !== false) reminders.apply(output.messages, activeProviders)
        })
      }
      if (options.compaction !== false && !nativeCompaction) userTurns.mark(output.messages, activeProviders)
    },
    async event({ event }) {
      if (event.type === "session.idle") {
        // A compaction cancelled between its hooks never reaches its transform.
        nativeCompactions.delete(event.properties.sessionID)
        return continueTruncated(event.properties.sessionID)
      }
      if (event.type !== "session.deleted") return
      const session = event.properties.info.id
      const pending = pendingDeletions.get(session)
      if (pending) return pending
      deleted.add(session)
      truncatedHandled.delete(session)
      outputSessions.delete(session)
      outputCalls.delete(session)
      lastExchanges.delete(session)
      nativeCompactions.delete(session)
      compaction.delete(session)
      // OpenCode fires event hooks without awaiting them. Own this work until
      // the tombstone commits, including when plugin disposal follows deletion.
      const deletion = (async () => {
        await stateTails.get(session)
        await store?.delete(session, () => {
          void log("Waiting for checkpoint writer", { operation: "delete", state: "waiting" }).catch(() => {})
        })
        environments.delete(session)
        reminders.delete(session)
        audit.delete(session)
        heads.delete(session)
        prefixGuard.delete(session)
        compaction.delete(session)
        for (const lane of sessionLanes.get(session) ?? []) {
          usage.delete(lane)
          usage.delete(`${lane}:summary`)
        }
        sessionLanes.delete(session)
        parentHeadLanes.delete(session)
      })().catch(async (error) => {
        deletionFailures.push(error)
        await client.app.log({ body: { service: "kv-guard", level: "error", message: "Checkpoint deletion failed; durable cleanup is incomplete", extra: { operation: "delete", state: "failed" } } }).catch(() => {})
      }).finally(() => { pendingDeletions.delete(session) })
      pendingDeletions.set(session, deletion)
      return deletion
    },
    async dispose() {
      disposed.abort(new Error("KV guard disposed"))
      await Promise.all(stateTails.values())
      while (pendingDeletions.size) await Promise.all(pendingDeletions.values())
      environments.clear()
      reminders.clear()
      audit.clear()
      heads.clear()
      prefixGuard.clear()
      compaction.clear()
      usage.clear()
      sessionLanes.clear()
      parentHeadLanes.clear()
      outputSessions.clear()
      outputCalls.clear()
      lastExchanges.clear()
      nativeCompactions.clear()
      truncatedHandled.clear()
      toolChoiceNoneRejected.clear()
      if (deletionFailures.length) throw new AggregateError(deletionFailures, "KV guard could not complete durable session deletion")
    },
  }
}

export default plugin
