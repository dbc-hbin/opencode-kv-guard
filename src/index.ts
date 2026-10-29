import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { admittedFetch, endpointGate, type AdmissionGate, type Fetch } from "./transport"
import { processEndpointGate } from "./process-gate"
import { canonical, Environments, ModeReminders, PrefixAudit, stripEnvironmentDate, UserTurns } from "./prefix"
import { compactSystem } from "./compact"
import { RollingCompaction, type ChatBody } from "./compaction"
import { CheckpointStore, type CheckpointSnapshot } from "./checkpoints"
import { UsageTracker, observeResponse } from "./usage"
import { parseGLMOptions, normalizeGLMRequest, createGLMChunkAdapter } from "./glm"
import { compactSkillCatalog } from "./skills"
import { compactToolDescriptions } from "./tools"
import { ToolOutputShrinker } from "./output"
import { SessionHeads, PrefixGuard } from "./heads"
import { digest as hash } from "./shared"

const agentHeader = "x-opencode-kv-guard-agent"
const limitsHeader = "x-opencode-kv-guard-limits"
const userHeader = "x-opencode-kv-guard-user"
const systemSuffixHeader = "x-opencode-kv-guard-system-suffix"
// Internal OpenCode agents that never own a resumable conversation.
const internalAgents = ["title", "summary", "compaction"]

const plugin: Plugin = async ({ client, project, directory, worktree }, options = {}) => {
  const allowed = ["providers", "maxConcurrent", "maxOutputTokens", "compactPrompt", "stabilizeEnvironment", "retainModeReminders", "canonicalToolSchemas", "promptCacheKey", "compaction", "diagnostics", "usageAccounting", "crossProcess", "persistence", "stateDirectory", "glm", "compactSkills", "compactTools", "sessionHeads", "prefixGuard", "prefixHandoff", "shrinkToolOutputs"]
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
  for (const key of ["compactPrompt", "stabilizeEnvironment", "retainModeReminders", "canonicalToolSchemas", "promptCacheKey", "diagnostics", "usageAccounting", "crossProcess", "persistence", "compactSkills", "compactTools", "sessionHeads", "prefixGuard", "prefixHandoff"]) {
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
        if (typeof report?.summaryRequests === "number" && report.summaryRequests > 0) show("Session compacted", "success")
      },
    }
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
      if (!completedResponse) disposed.signal.throwIfAborted()
      if (deleted.has(session)) throw new Error("KV guard: session was deleted during preparation")
      if (store && loaded) {
        const snapshot = { modes: reminders.snapshot(session), environments: environments.snapshot(session), compaction: compaction.snapshot(session), heads: heads.snapshot(session), prefixGuard: prefixGuard.snapshot(session) }
        if (JSON.stringify(snapshot) !== JSON.stringify(loaded.snapshot ?? empty)) await store.save(session, snapshot, loaded.revision)
      }
      return result
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
        return { id, provider, baseURL, endpoint, gate, fetch: (custom ?? globalThis.fetch) as Fetch }
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
          const send = async (outgoing: ChatBody, label: "main" | "summary") => {
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
            const response = await admittedFetch(target.fetch, gate, input, { ...init, headers, body: JSON.stringify(outgoing), signal })
            return observeResponse(response, {
              body: outgoing, lane: requestLane, tracker: usage, request: ticket, signal, label,
              transform: glm && glm.models.includes(outgoing.model) ? createGLMChunkAdapter(outgoing.model, glm) : undefined,
              onAssistant: session && agent && label === "main" && options.prefixGuard !== false ? (assistant) => {
                // Enqueue synchronously before EOF so the next request cannot
                // restore an older checkpoint over this completed response.
                void checkpoint(session, () => prefixGuard.record(outgoing, assistant, { session, lane, outcome: "success", finishReason: assistant.tool_calls ? "tool_calls" : "stop", receipt: replayReceipt }), true)
                  .catch(() => log("Response replay checkpoint was not retained", { laneFingerprint: lane }).catch(() => {}))
              } : undefined,
              onReport: (report) => log("Request usage and lifecycle", { ...report, admissionWaitMs, upstreamHeaderMs: Math.max(0, report.headerMs - admissionWaitMs) }),
            })
          }
          const prepare = async () => {
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
              const prepared = await compaction.prepare(body, {
                session, lane, contextWindow: limits.context,
                inputLimit: "input" in limits && typeof limits.input === "number" && limits.input > 0 ? limits.input : undefined,
                outputLimit: output, signal,
                allowSummary, currentUser, prefixHandoff: options.prefixHandoff !== false,
                restoreReasoning: options.prefixGuard === false ? undefined : (effective) => prefixGuard.apply(effective, { session, lane, currentUser, observe: false }).body,
                estimate: options.usageAccounting === false ? undefined : (candidate, fallback) => usage.estimate(candidate, lane, fallback),
                completeSummary: (summary) => notice.summary(() => send(summary, "summary")),
              })
              if ("response" in prepared) return prepared.response
              notice.finished(prepared.report)
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
          const failed = session && agent ? await checkpoint(session, prepare) : await prepare()
          if (failed) return failed
          if (session && agent && options.diagnostics === true) {
            const report = audit.observe(body, session, lane)
            // Only hashes/count comparisons; no prompts, credentials, paths, or tool arguments.
            await client.app.log({ body: { service: "kv-guard", level: "info", message: "Request prefix comparison (not a token-cache hit measurement)", extra: report } })
          }
          return send(body, "main")
        }
        activeProviders.add(target.id)
      }
    },
    async "chat.params"(input, output) {
      if (!activeProviders.has(input.model.providerID) || maxOutputTokens === undefined) return
      output.maxOutputTokens = Math.min(output.maxOutputTokens ?? maxOutputTokens, maxOutputTokens)
    },
    async "chat.headers"(input, output) {
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
    async "experimental.chat.messages.transform"(_input, output) {
      userTurns.clean(output.messages)
      const current = output.messages.findLast((message) => message.info.role === "user")
      if (current?.info.role === "user" && activeProviders.has(current.info.model.providerID)) {
        await checkpoint(current.info.sessionID, () => {
          if (options.retainModeReminders !== false) reminders.apply(output.messages, activeProviders)
        })
      }
      if (options.compaction !== false) userTurns.mark(output.messages, activeProviders)
    },
    async event({ event }) {
      if (event.type !== "session.deleted") return
      const session = event.properties.info.id
      const pending = pendingDeletions.get(session)
      if (pending) return pending
      deleted.add(session)
      outputSessions.delete(session)
      outputCalls.delete(session)
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
      if (deletionFailures.length) throw new AggregateError(deletionFailures, "KV guard could not complete durable session deletion")
    },
  }
}

export default plugin
