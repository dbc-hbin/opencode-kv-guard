import type { Plugin } from "@opencode/plugin"
import { ToolOutputShrinker, type ToolOutputOptions } from "./output"

export interface ServerToolOptions {
  readonly providers: readonly string[]
  readonly shrinkToolOutputs?: ToolOutputOptions | false
}

type OutputContext = {
  readonly session: Pick<Plugin.Context["session"], "hook" | "context">
  readonly tool: Pick<Plugin.Context["tool"], "hook">
  readonly event: Plugin.Context["event"]
}

type Request = {
  readonly agent: string
  readonly provider: string
  readonly verified: Map<string, Promise<boolean>>
}

export async function registerTools(ctx: OutputContext, options: ServerToolOptions) {
  if (options.shrinkToolOutputs === false) return
  const shrinker = new ToolOutputShrinker(options.shrinkToolOutputs)
  const providers = new Set(options.providers)
  const requests = new Map<string, Request>()
  await ctx.session.hook("model.request", ({ kind, sessionID, agent, model }) => {
    if (kind !== "primary") return
    requests.delete(sessionID)
    if (providers.has(model.providerID)) {
      requests.set(sessionID, { agent, provider: model.providerID, verified: new Map() })
    }
  })
  await ctx.session.hook("experimental.idle", ({ sessionID }) => { requests.delete(sessionID) })
  await ctx.tool.hook("execute.after", async (event) => {
    const request = requests.get(event.sessionID)
    if (!request || request.agent !== event.agent) return
    if (event.status === "error" || !shrinker.supports(event.tool)) return

    // A scheduled Code Mode check may use the same session and agent. Bind to the
    // durable assistant message for this model request, not to the shared call ID.
    let verified = request.verified.get(event.messageID)
    if (verified === undefined) {
      verified = ctx.session.context({ sessionID: event.sessionID }).then(
        (messages) => messages.some((message) => message.type === "assistant" && message.id === event.messageID &&
          message.agent === event.agent && message.model.providerID === request.provider),
        () => false,
      )
      request.verified.set(event.messageID, verified)
    }
    if (!await verified || requests.get(event.sessionID) !== request) return

    event.result = await shrinker.apply(event.tool, event.result)
  })

  const stop = new AbortController()
  const events = ctx.event.subscribe({ types: ["session.step.started", "session.deleted"], signal: stop.signal })
  const listener = (async () => {
    for await (const event of events) {
      switch (event.type) {
        case "session.deleted":
          requests.delete(event.data.sessionID)
          break
        case "session.step.started": {
          const { sessionID, assistantMessageID, agent, model } = event.data
          const request = requests.get(sessionID)
          if (request?.agent === agent && request.provider === model.providerID) {
            request.verified.set(assistantMessageID, Promise.resolve(true))
          }
          break
        }
        default: {
          const unhandled: never = event
          return unhandled
        }
      }
    }
  })().catch(() => requests.clear())
  return async () => {
    stop.abort()
    await listener
    requests.clear()
  }
}
