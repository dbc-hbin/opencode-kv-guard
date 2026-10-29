import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Message } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"

type CacheUsage = { read: number; prompt: number }

function cacheUsage(message: Message): CacheUsage {
  if (message.role !== "assistant") return { read: 0, prompt: 0 }
  // OpenCode subtracts cache reads and writes from input (session.ts).
  return { read: message.tokens.cache.read, prompt: message.tokens.input + message.tokens.cache.read + message.tokens.cache.write }
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
    for (const message of props.api.state.session.messages(props.session_id)) {
      if (message.role !== "assistant") continue
      const current = cacheUsage(message)
      lastRead = current.read
      lastPrompt = current.prompt
    }
    const total = usage()
    return {
      last: lastPrompt > 0 ? `${Math.round((lastRead / lastPrompt) * 100)}%` : "-",
      session: total && total.prompt > 0 ? `${Math.round((total.read / total.prompt) * 100)}%` : "-",
      read: total?.read ?? 0,
      prompt: total?.prompt ?? 0,
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
