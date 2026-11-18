import type { TokenUsageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup } from "solid-js"

type SessionCacheRates = { readonly last: number | undefined; readonly session: number | undefined }
type UsageByStep = Map<string, TokenUsageInfo | undefined>

type HistorySource = {
  readonly client: {
    readonly message: Pick<Plugin.Context["client"]["message"], "list">
    readonly session: Pick<Plugin.Context["client"]["session"], "get">
  }
  readonly data: Pick<Plugin.Context["data"], "listen">
}

type SidebarHost = HistorySource & Readonly<{
  theme: { readonly text: Pick<Plugin.Context["theme"]["text"], "base" | "muted"> }
  ui: Pick<Plugin.Context["ui"], "slot">
}>

export function watchSessionUsage(source: HistorySource, sessionID: string, update: (rates?: SessionCacheRates) => void) {
  const { client, data } = source
  let current: AbortController | undefined
  let history: UsageByStep | undefined
  const live: UsageByStep = new Map()

  const publish = (usage: UsageByStep) => {
    let last: number | undefined
    let read = 0
    let prompt = 0
    for (const tokens of usage.values()) {
      if (!tokens) {
        last = undefined
        continue
      }
      const input = tokens.input + tokens.cache.read + tokens.cache.write
      last = input ? Math.round(tokens.cache.read * 100 / input) : undefined
      read += tokens.cache.read
      prompt += input
    }
    update({ last, session: prompt ? Math.round(read * 100 / prompt) : undefined })
  }

  const refresh = () => {
    current?.abort()
    const request = new AbortController()
    current = request
    history = undefined
    live.clear()
    update(undefined)

    void (async () => {
      const options = { signal: request.signal }
      const { revert } = await client.session.get({ sessionID }, options)
      // Revert is exclusive, and IDs (including fork copies) are not ordered by sequence.
      let visible = !revert
      const newestFirst: UsageByStep = new Map()
      const query = { sessionID, limit: 200, type: revert ? undefined : "assistant" as const }
      let page = await client.message.list({ ...query, order: "desc" }, options)
      while (!request.signal.aborted) {
        for (const message of page.data) {
          if (visible && message.type === "assistant" && (message.tokens || message.time.completed !== undefined)) {
            newestFirst.set(message.id, message.tokens)
          }
          if (message.id === revert?.messageID) visible = true
        }
        const cursor = page.cursor.next
        if (!cursor) break
        page = await client.message.list({ ...query, cursor }, options)
      }
      // The boundary can disappear if the server commits during the read.
      if (!visible) return
      return { usage: new Map([...newestFirst].reverse()), reverted: Boolean(revert) }
    })().then((snapshot) => {
      if (request.signal.aborted) return
      current = undefined
      if (!snapshot) return
      history = snapshot.usage
      if (!snapshot.reverted) for (const [id, tokens] of live) history.set(id, tokens)
      live.clear()
      publish(history)
    }, () => {
      // Do not show partial totals. A later session event or reconnect retries the read.
      if (!request.signal.aborted) current = undefined
    })
  }

  // Subscribe before paging: live usage replaces any overlapping snapshot row.
  const off = data.listen(({ details: event }) => {
    switch (event.type) {
      case "server.connected":
        refresh()
        return
      case "session.revert.staged":
      case "session.revert.cleared":
      case "session.revert.committed":
        if (event.data.sessionID === sessionID) refresh()
        return
      case "session.step.ended":
      case "session.step.failed": {
        if (event.data.sessionID !== sessionID) return
        const { assistantMessageID, tokens } = event.data
        if (!current && !history) refresh()
        if (history) {
          history.set(assistantMessageID, tokens)
          publish(history)
        } else {
          live.set(assistantMessageID, tokens)
        }
        return
      }
    }
  })
  refresh()
  return () => {
    off()
    current?.abort()
  }
}

function View(props: { readonly context: SidebarHost; readonly sessionID: string }) {
  const [rates, setRates] = createSignal<SessionCacheRates>()
  createEffect(() => onCleanup(watchSessionUsage(props.context, props.sessionID, (value) => setRates(value))))
  const display = (rate?: number) => rate === undefined ? "-" : `${rate}%`

  return (
    <box>
      <text fg={props.context.theme.text.base}><b>Input cache</b></text>
      <text fg={props.context.theme.text.muted}>Last request: {display(rates()?.last)}</text>
      <text fg={props.context.theme.text.muted}>Session: {display(rates()?.session)}</text>
    </box>
  )
}

const plugin = {
  id: "opencode-kv-guard:cache-rate",
  setup(context: SidebarHost) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <View context={context} sessionID={props.sessionID} />,
    })
  },
} satisfies Plugin.Definition

export default plugin
