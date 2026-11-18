import type { Plugin } from "@opencode/plugin"
import { join } from "node:path"
import { CheckpointConflictError, CheckpointStore, type CheckpointSnapshot } from "./checkpoints"
import { RollingCompaction } from "./compaction"
import type { CompactionOptions } from "./compaction-policy"
import { PrefixGuard } from "./heads"
import { makeModelEstimator, resolveModelBudget, type ModelBudget } from "./model-budget"
import { ToolArtifacts } from "./output"
import type { TransportCompletion, TransportRequest } from "./server-transport"
import { busy, digest, type ChatBody } from "./shared"
import { UsageTracker } from "./usage"

const historyEvents = [
  "session.forked",
  "session.revert.staged",
  "session.revert.cleared",
  "session.revert.committed",
  "session.compaction.ended",
  "session.deleted",
] as const
type EventStream = ReturnType<Plugin.Context["event"]["subscribe"]>
type HistoryEvent = EventStream extends AsyncIterable<infer Event> ? Extract<Event, { type: typeof historyEvents[number] }> : never
type OwnedState = {
  readonly prefix: PrefixGuard
  readonly usage: UsageTracker
  readonly lanes: Set<string>
  compaction?: CheckpointSnapshot["compaction"]
}
type SpeculationSource = { readonly binding: string; readonly length: number; readonly fingerprint: string }
type StagedCompaction = SpeculationSource & { readonly rolling: RollingCompaction; ready: boolean }
type SpeculationPlan = {
  readonly session: string
  readonly source: SpeculationSource
  readonly rolling: RollingCompaction
  readonly compute: () => Promise<boolean> | undefined
}
const maxSpeculativeSessions = 32

export type StateOptions = {
  readonly providers: readonly string[]
  readonly diagnostics: boolean
  readonly persistence: boolean
  readonly prefixGuard: boolean
  readonly usageAccounting: boolean
  readonly stateDirectory: string
  readonly compaction?: CompactionOptions
  readonly prefixHandoff?: boolean
  readonly speculativeCompaction?: boolean
  readonly modelBudgets?: readonly ModelBudget[]
  readonly supersedeReads?: boolean
}

const loggedFields = new Set([
  "model", "tools", "tool_choice", "role", "content", "name", "tool_calls", "tool_call_id",
  "reasoning", "reasoning_content", "temperature", "top_p", "top_k", "stop", "stream", "stream_options",
  "max_tokens", "max_completion_tokens", "response_format", "prompt_cache_key", "reasoning_effort",
])

export class ServerState {
  private readonly store: CheckpointStore | undefined
  private readonly memory = new Map<string, CheckpointSnapshot | null>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly providers: ReadonlySet<string>
  private readonly artifacts: ToolArtifacts | undefined
  private readonly pendingBoundaries = new Map<string, number>()
  private readonly compactions = new Map<string, AbortController>()
  private readonly speculation = new Map<string, StagedCompaction>()
  private readonly plans = new WeakMap<AbortSignal, SpeculationPlan>()
  private active = true

  constructor(project: string, private readonly options: StateOptions) {
    this.providers = new Set(options.providers)
    this.store = options.persistence ? new CheckpointStore(join(options.stateDirectory, "checkpoints"), project, "opencode-v2-wire") : undefined
    this.artifacts = options.compaction ? new ToolArtifacts() : undefined
  }

  private log(event: string, details: Record<string, unknown>) {
    if (this.options.diagnostics) console.error(JSON.stringify({ service: "kv-guard", event, ...details }))
  }

  private serial<T>(session: string, operation: () => T | Promise<T>): Promise<T> {
    const pending = (this.tails.get(session) ?? Promise.resolve()).then(operation)
    const tail = pending.then(() => {}, () => {})
    this.tails.set(session, tail)
    void tail.then(() => { if (this.tails.get(session) === tail) this.tails.delete(session) })
    return pending
  }

  private clearSpeculation(session: string) {
    this.speculation.get(session)?.rolling.clear()
    this.speculation.delete(session)
  }

  private startSpeculation(plan: SpeculationPlan) {
    if (!this.active || this.pendingBoundaries.has(plan.session)) {
      plan.rolling.clear()
      return
    }
    this.clearSpeculation(plan.session)
    if (this.speculation.size >= maxSpeculativeSessions) {
      const oldest = this.speculation.keys().next().value
      if (oldest !== undefined) this.clearSpeculation(oldest)
    }
    const entry: StagedCompaction = { ...plan.source, rolling: plan.rolling, ready: false }
    this.speculation.set(plan.session, entry)
    void Promise.resolve(plan.compute()).then((ready) => {
      if (this.speculation.get(plan.session) !== entry) return
      if (!ready) {
        this.clearSpeculation(plan.session)
        return
      }
      entry.ready = true
      this.log("wire.compaction-staged", { session: digest(plan.session) })
    })
  }

  private update<T>(
    request: TransportRequest,
    change: (session: string, state: OwnedState) => T | undefined | Promise<T | undefined>,
    committed?: (value: T) => void,
  ) {
    const { sessionID: session, kind, providerID } = request
    const { diagnostics, usageAccounting, prefixGuard } = this.options
    if (!session || kind !== "primary" || !this.providers.has(providerID) || !(diagnostics || usageAccounting || prefixGuard || this.options.compaction)) return
    return this.serial(session, async () => {
      const memory = this.memory.get(session)
      if (!this.active || request.signal.aborted || memory === null) return
      const loaded = await this.store?.load(session)
      if (loaded?.reason === "deleted") return
      if (loaded?.reason) this.log("checkpoint.cache-miss", { session: digest(session), reason: loaded.reason })
      const persisted = loaded?.snapshot
      // A fresh event on an untracked session opens no checkpoint file. If
      // another process then initializes it, prefer the newer local boundary.
      const snapshot = (memory?.boundary ?? -1) > (persisted?.boundary ?? -1) ? memory : persisted ?? memory
      const prefix = new PrefixGuard()
      const usage = new UsageTracker()
      if (snapshot) {
        prefix.restore(session, snapshot.prefix)
        usage.restore(snapshot.usage)
      }
      const lanes = new Set(snapshot?.usage.lanes.map(({ lane }) => lane))
      const state: OwnedState = { prefix, usage, lanes, compaction: this.options.compaction ? snapshot?.compaction : undefined }
      const result = await change(session, state)
      if (result instanceof Response) return result
      if (result === undefined || !this.active || request.signal.aborted) return
      if (request.compaction && this.pendingBoundaries.has(session)) return
      const next: CheckpointSnapshot = {
        boundary: snapshot?.boundary,
        prefix: prefix.snapshot(session),
        usage: usage.snapshot(lanes),
        ...(state.compaction?.lanes.length ? { compaction: state.compaction } : {}),
      }
      if (this.store && loaded) {
        await this.store.save(session, next, loaded.revision)
        this.memory.delete(session)
      } else this.memory.set(session, next)
      if (this.active && !request.signal.aborted) {
        committed?.(result)
        return result
      }
    })
  }

  readonly onRequest = async (request: TransportRequest) => {
    const lane = digest(request.lane)
    const modelBudget = request.modelID === undefined ? undefined
      : resolveModelBudget(this.options.modelBudgets ?? [], { providerID: request.providerID, modelID: request.modelID })
    const countPrompt = makeModelEstimator(modelBudget)
    const prepared = await this.update(request, async (session, state) => {
      const { prefix, usage, lanes } = state
      const context = { session, lane, receipt: request.id, replay: this.options.prefixGuard }
      let effective = request.body
      let plan: SpeculationPlan | undefined
      const capability = request.compaction
      if (this.options.compaction && capability && this.artifacts) {
        if (this.pendingBoundaries.has(session)) throw new Error("KV guard: session history changed before compaction")
        const controller = new AbortController()
        const signal = AbortSignal.any([request.signal, controller.signal])
        this.compactions.set(session, controller)
        let options = this.options.compaction
        if (modelBudget?.thresholdTokens !== undefined || modelBudget?.thresholdPercent !== undefined) {
          const { thresholdTokens: _tokens, thresholdPercent: _percent, ...base } = options
          options = {
            ...base,
            ...(modelBudget.thresholdTokens === undefined ? {} : { thresholdTokens: modelBudget.thresholdTokens }),
            ...(modelBudget.thresholdPercent === undefined ? {} : { thresholdPercent: modelBudget.thresholdPercent }),
          }
        }
        const { messages: _messages, ...requestPolicy } = request.body
        const binding = digest(JSON.stringify([lane, requestPolicy, capability.limits, modelBudget, state.compaction]))
        const staged = this.speculation.get(session)
        const reusable = staged?.ready && staged.binding === binding && !capability.overflow
          && request.body.messages.length >= staged.length
          && digest(JSON.stringify(request.body.messages.slice(0, staged.length))) === staged.fingerprint
        if (reusable) this.speculation.delete(session)
        else this.clearSpeculation(session)
        const rolling = reusable ? staged.rolling : new RollingCompaction(options)
        try {
          if (state.compaction) await rolling.restore(session, state.compaction)
          const { limits, currentUser, completeSummary, overflow } = capability
          const artifacts = this.artifacts
          const compactionContext = {
            ...context,
            contextWindow: limits.context, inputLimit: limits.input, modelOutputLimit: limits.output,
            outputLimit: limits.wireOutput,
            currentUser, allowSummary: true, signal, overflow, completeSummary,
            prefixHandoff: this.options.prefixHandoff !== false,
            speculate: this.options.speculativeCompaction === true && capability.backgroundSummary !== undefined,
            countPrompt,
            readEvidence: this.options.supersedeReads ? capability.readEvidence : undefined,
            restoreReasoning: this.options.prefixGuard ? (candidate: ChatBody) => prefix.apply(candidate, { ...context, observe: false }).body : undefined,
            estimate: this.options.usageAccounting ? (candidate: ChatBody, fallback: (value: ChatBody) => number) => usage.estimate(candidate, lane, fallback) : undefined,
            artifacts: { path: (text: string) => artifacts.contentPath(text), save: (path: string, text: string) => artifacts.saveContent(path, text) },
          }
          const result = await rolling.prepare(effective, compactionContext)
          if (signal.aborted && "response" in result) await result.response.body?.cancel(signal.reason)
          signal.throwIfAborted()
          if ("response" in result) return result.response
          effective = result.body
          state.compaction = rolling.snapshot(session)
          const background = capability.backgroundSummary
          if (result.report?.speculate && !result.report.compacted && background) {
            plan = {
              session, rolling,
              source: { binding, length: request.body.messages.length, fingerprint: digest(JSON.stringify(request.body.messages)) },
              compute: () => {
                let sent = false
                let exceeded = false
                return rolling.speculate(request.body, {
                  ...compactionContext, signal: undefined,
                  completeSummary: (body, signal) => {
                    if (!signal) throw new Error("KV guard: missing speculative compaction signal")
                    if (sent) {
                      exceeded = true
                      throw new Error("KV guard: speculative summary may send only one request")
                    }
                    sent = true
                    return background(body, signal)
                  },
                })?.then((ready) => ready && !exceeded)
              },
            }
          }
          if (result.report) this.log("wire.compaction", { lane, ...result.report })
        } finally {
          this.compactions.delete(session)
          if (!plan) rolling.clear()
        }
      } else this.clearSpeculation(session)
      const { body, report } = prefix.apply(effective, context)
      let estimatedPromptTokens: number | undefined
      if (this.options.usageAccounting) {
        if (this.options.diagnostics) {
          const rawCount = (value: ChatBody) => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4)
          const calibrated = countPrompt?.(body)
          estimatedPromptTokens = usage.estimate(body, lane, calibrated === undefined ? rawCount
            : (value) => value === body ? calibrated : countPrompt?.(value) ?? rawCount(value))
        }
        usage.begin(body, lane, usage.prepare(lane, request.id))
        lanes.add(lane)
      } else {
        lanes.delete(lane)
      }
      return { body, report, estimatedPromptTokens, plan }
    }, (result) => {
      if (!(result instanceof Response) && result.plan) this.plans.set(request.signal, result.plan)
    })
    if (this.options.compaction && request.compaction && (!prepared || (request.sessionID && this.pendingBoundaries.has(request.sessionID)))) {
      if (prepared instanceof Response) await prepared.body?.cancel()
      throw new Error("KV guard: compaction checkpoint is no longer current")
    }
    if (prepared instanceof Response) return prepared
    if (!prepared) return
    if (this.options.diagnostics) {
      const { divergences, ...report } = prepared.report
      this.log("wire.prefix", {
        ...report, endpoint: request.endpoint, lane, estimatedPromptTokens: prepared.estimatedPromptTokens,
        divergences: divergences.map(({ field, ...item }) => ({
          ...item,
          field: field === undefined || loggedFields.has(field) ? field : digest(field),
        })),
      })
    }
    return prepared.body
  }

  readonly onComplete = async (request: TransportRequest, completion: TransportCompletion) => {
    if (!request.sessionID || request.kind !== "primary" || !this.providers.has(request.providerID)) return
    const lane = digest(request.lane)
    const plan = this.plans.get(request.signal)
    this.plans.delete(request.signal)
    let recorded
    try {
      recorded = await this.update(request, (session, { prefix, usage }) => {
        const context = { session, lane, receipt: request.id }
        if (!prefix.accepts(request.body, context)) return
        const { assistant, finishReason, cachedTokens, promptTokens } = completion
        const reasoning = !!(this.options.prefixGuard && assistant && finishReason && prefix.record(request.body, assistant, { ...context, outcome: "success", finishReason }))
        const anchor = this.options.usageAccounting && promptTokens !== undefined && (cachedTokens === undefined || cachedTokens <= promptTokens)
          && usage.record(usage.begin(request.body, lane, request.id), request.body, lane, promptTokens)
        const speculate = plan !== undefined && (finishReason === "stop" || finishReason === "tool_calls")
        return reasoning || anchor || speculate ? { reasoning, anchor, speculate } : undefined
      }, (result) => {
        if (result.speculate && plan) this.startSpeculation(plan)
      })
    } catch (error) {
      if (!(error instanceof CheckpointConflictError) && !busy(error)) throw error
      // A competing writer advanced the revision. A valid provider response
      // stays valid, but it cannot overwrite the winning session state.
      this.log("checkpoint.completion-conflict", { receipt: request.id })
    }
    if (!recorded?.speculate) plan?.rolling.clear()
    const { promptTokens, cachedTokens, completionTokens, totalTokens } = completion
    this.log("wire.usage", {
      receipt: request.id, endpoint: request.endpoint, lane,
      promptTokens, cachedTokens, completionTokens, totalTokens,
      anchorRecorded: recorded?.anchor ?? false, reasoningRecorded: recorded?.reasoning ?? false,
    })
  }

  onEvent(event: HistoryEvent): Promise<void> {
    const { sessionID: session } = event.data
    const sequence = event.durable.seq
    const deleted = event.type === "session.deleted"
    if (this.options.compaction) {
      // Fence an in-flight summary immediately; the durable reset runs in
      // session order after that request unwinds.
      this.pendingBoundaries.set(session, (this.pendingBoundaries.get(session) ?? 0) + 1)
      this.clearSpeculation(session)
      this.compactions.get(session)?.abort(new Error("KV guard: session history changed during compaction"))
    }
    return this.serial(session, async () => {
      const snapshot = this.memory.get(session)
      if (snapshot === null || (!deleted && (snapshot?.boundary ?? -1) >= sequence)) return
      if (deleted) this.memory.set(session, null)
      const durable = await this.store?.reset(session, { sequence, deleted }, () => {
        this.log("checkpoint.history-wait", { session: digest(session), cause: event.type, sequence })
      })
      if (!durable && !deleted) {
        this.memory.set(session, {
          boundary: sequence, prefix: { version: 2, session: digest(session), lanes: [] }, usage: { lanes: [] },
        })
      }
      this.log("history.invalidated", { session: digest(session), cause: event.type, sequence })
    }).finally(() => {
      const outstanding = this.pendingBoundaries.get(session) ?? 0
      if (outstanding <= 1) this.pendingBoundaries.delete(session)
      else this.pendingBoundaries.set(session, outstanding - 1)
    })
  }

  subscriptionFailed(error?: unknown) {
    this.active = false
    for (const session of this.speculation.keys()) this.clearSpeculation(session)
    for (const controller of this.compactions.values()) controller.abort(error)
    this.log("history.subscription-failed", { reason: error instanceof Error ? error.name : "closed" })
  }

  async dispose() {
    this.active = false
    for (const session of this.speculation.keys()) this.clearSpeculation(session)
    for (const controller of this.compactions.values()) controller.abort()
    await Promise.all(this.tails.values())
    this.memory.clear()
  }
}

export function registerServerState(ctx: Pick<Plugin.Context, "location" | "event">, options: StateOptions) {
  const state = new ServerState(ctx.location.project.id, options)
  const controller = new AbortController()
  const history = ctx.event.subscribe({ types: historyEvents, signal: controller.signal })
  const observer = (async () => {
    try {
      for await (const event of history) void state.onEvent(event).catch((error: unknown) => state.subscriptionFailed(error))
      if (!controller.signal.aborted) state.subscriptionFailed()
    } catch (error) {
      if (!controller.signal.aborted) state.subscriptionFailed(error)
    }
  })()
  return {
    onRequest: state.onRequest,
    onComplete: state.onComplete,
    async dispose() {
      controller.abort()
      await observer
      await state.dispose()
    },
  }
}
