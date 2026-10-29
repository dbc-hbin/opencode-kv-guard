import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const stats = createMemo(() => {
    let read = 0
    let prompt = 0
    let lastRead = 0
    let lastPrompt = 0
    for (const message of props.api.state.session.messages(props.session_id)) {
      if (message.role !== "assistant") continue
      // OpenCode stores `input` with cache reads already subtracted (session.ts),
      // so the provider-reported prompt size is input + cache.read + cache.write.
      const size = message.tokens.input + message.tokens.cache.read + message.tokens.cache.write
      if (size === 0) continue
      read += message.tokens.cache.read
      prompt += size
      lastRead = message.tokens.cache.read
      lastPrompt = size
    }
    return {
      last: lastPrompt > 0 ? `${Math.round((lastRead / lastPrompt) * 100)}%` : "-",
      session: prompt > 0 ? `${Math.round((read / prompt) * 100)}%` : "-",
      read,
      prompt,
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
