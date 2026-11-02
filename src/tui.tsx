import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, Index, onCleanup } from "solid-js"

type CacheUsage = { read: number; prompt: number }

function cacheUsage(message: Message): CacheUsage {
  if (message.role !== "assistant") return { read: 0, prompt: 0 }
  // OpenCode subtracts cache reads and writes from input (session.ts).
  return { read: message.tokens.cache.read, prompt: message.tokens.input + message.tokens.cache.read + message.tokens.cache.write }
}

export function responsePerformance(messages: ReadonlyArray<Message>, parts: (messageID: string) => ReadonlyArray<Part>) {
  const message = messages.findLast((message) => message.role === "assistant")
  if (!message) return { ttftMs: undefined, throughput: undefined, generationThroughput: undefined, e2eMs: undefined }
  const elapsed = message.time.completed === undefined ? undefined : message.time.completed - message.time.created
  const e2eMs = elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined
  // Tool argument streaming has no persisted start timestamp. Do not mistake
  // a later text/reasoning part, or tool execution start, for its first token.
  const first = parts(message.id).find((part) => {
    switch (part.type) {
      case "tool": return true
      case "reasoning": return part.text.length > 0
      case "text": return !part.synthetic && !part.ignored && part.text.length > 0
      default: return false
    }
  })
  const start = first?.type === "text" || first?.type === "reasoning" ? first.time?.start : undefined
  let ttftMs: number | undefined
  if (start !== undefined) {
    const lead = start - message.time.created
    if (Number.isFinite(lead) && lead >= 0) ttftMs = lead
  }
  if (message.time.completed !== undefined) {
    if (e2eMs === undefined) ttftMs = undefined
    else if (ttftMs !== undefined && ttftMs > e2eMs) ttftMs = undefined
  }
  // OMP's status-line rate uses reported output / elapsed request time, with
  // a 100 ms minimum. OpenCode stores reasoning separately from output.
  const output = message.tokens.output + message.tokens.reasoning
  const rate = (duration: number | undefined) => {
    if (!Number.isFinite(output) || output <= 0 || duration === undefined || duration < 100) return undefined
    const value = output * 1000 / duration
    return Number.isFinite(value) && value > 0 ? value : undefined
  }
  return {
    ttftMs,
    throughput: rate(e2eMs),
    generationThroughput: rate(e2eMs !== undefined && ttftMs !== undefined ? e2eMs - ttftMs : undefined),
    e2eMs,
  }
}

export function watchSessionUsage(api: Pick<TuiPluginApi, "client" | "event">, sessionID: string, update: (usage: CacheUsage) => void, failed?: (error: unknown) => void) {
  const messages = new Map<string, CacheUsage>()
  const changed = new Set<string>()
  let ready = false
  let active = true
  let read = 0
  let prompt = 0
  const put = (id: string, usage?: CacheUsage) => {
    const previous = messages.get(id)
    read += (usage?.read ?? 0) - (previous?.read ?? 0)
    prompt += (usage?.prompt ?? 0) - (previous?.prompt ?? 0)
    if (usage) messages.set(id, usage)
    else messages.delete(id)
    if (ready) update({ read, prompt })
  }
  // The TUI state keeps only 100 messages; omit limit to load the whole session.
  // A failed load is retried on the next update for this session; until one
  // succeeds, event-only totals are incomplete and are not reported.
  let loading = false
  const load = () => {
    if (loading || ready || !active) return
    loading = true
    void api.client.session.messages({ sessionID }, { throwOnError: true }).then(({ data }) => {
      loading = false
      if (!active) return
      for (const { info } of data) {
        if (!changed.has(info.id)) put(info.id, cacheUsage(info))
      }
      changed.clear()
      ready = true
      update({ read, prompt })
    }, (error: unknown) => {
      // Clear before reporting so a reaction to the failure can retry at once.
      loading = false
      failed?.(error)
    })
  }
  // Subscribe before fetching so streaming updates/removals win over the snapshot.
  const offUpdate = api.event.on("message.updated", ({ properties: { info } }) => {
    if (info.sessionID !== sessionID) return
    if (!ready) changed.add(info.id)
    put(info.id, cacheUsage(info))
    load()
  })
  const offRemove = api.event.on("message.removed", ({ properties }) => {
    if (properties.sessionID !== sessionID) return
    if (!ready) changed.add(properties.messageID)
    put(properties.messageID)
  })
  load()
  return () => {
    active = false
    offUpdate()
    offRemove()
  }
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [usage, setUsage] = createSignal<CacheUsage>()
  createEffect(() => {
    setUsage(undefined)
    onCleanup(watchSessionUsage(props.api, props.session_id, setUsage))
  })
  const stats = createMemo(() => {
    let lastRead = 0
    let lastPrompt = 0
    const messages = props.api.state.session.messages(props.session_id)
    for (const message of messages) {
      if (message.role !== "assistant") continue
      const current = cacheUsage(message)
      lastRead = current.read
      lastPrompt = current.prompt
    }
    const total = usage()
    const performance = responsePerformance(messages, props.api.state.part)
    return {
      last: lastPrompt > 0 ? `${Math.round((lastRead / lastPrompt) * 100)}%` : "-",
      session: total && total.prompt > 0 ? `${Math.round((total.read / total.prompt) * 100)}%` : "-",
      read: total?.read ?? 0,
      prompt: total?.prompt ?? 0,
      performance: [
        { label: "TTFT", value: performance.ttftMs === undefined ? "-" : `${(performance.ttftMs / 1000).toFixed(2)} s` },
        { label: "Throughput", value: performance.throughput === undefined ? "-" : `${performance.throughput.toFixed(1)} tok/s` },
        { label: "Gen Throughput", value: performance.generationThroughput === undefined ? "-" : `${performance.generationThroughput.toFixed(1)} tok/s` },
        { label: "E2E delay", value: performance.e2eMs === undefined ? "-" : `${(performance.e2eMs / 1000).toFixed(2)} s` },
      ],
    }
  })

  return (
    <box>
      <text fg={props.api.theme.current.text}>
        <b>Cache</b>
      </text>
      <text fg={props.api.theme.current.textMuted}>{stats().last} last request</text>
      <text fg={props.api.theme.current.textMuted}>{stats().session} session</text>
      <text fg={props.api.theme.current.textMuted}>
        {stats().read.toLocaleString()} / {stats().prompt.toLocaleString()} cached
      </text>
      <text marginTop={1} fg={props.api.theme.current.text}>
        <b>Performance</b>
      </text>
      <Index each={stats().performance}>{(metric) => (
        <box flexDirection="row" justifyContent="space-between">
          <text fg={props.api.theme.current.textMuted}>{metric().label}</text>
          <text fg={props.api.theme.current.textMuted}>{metric().value}</text>
        </box>
      )}</Index>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    // Builtin Context is 100 and MCP is 200: place the rate directly after Context.
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule = { id: "opencode-kv-guard:cache-rate", tui }

export default plugin
