import { randomUUID } from "node:crypto"

type Delta = {
  readonly role?: "assistant"
  readonly content?: string
  readonly tool_calls?: readonly unknown[]
}

const encode = (packet: unknown) => `data: ${JSON.stringify(packet)}\n\n`
export function completion() {
  const header = { id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "fixture" }
  return {
    delta: (delta: Delta) => encode({ ...header, choices: [{ index: 0, delta, finish_reason: null }] }),
    end(finish: "stop" | "tool_calls") {
      return encode({ ...header, choices: [{ index: 0, delta: {}, finish_reason: finish }] }) +
        encode({ ...header, choices: [], usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 } }) +
        "data: [DONE]\n\n"
    },
  }
}

export function textStream(text: string) {
  const reply = completion()
  return new Response(reply.delta({ role: "assistant", content: text }) + reply.end("stop"), { headers: streamHeaders })
}

export function toolStream(name: string, args: unknown) {
  const reply = completion()
  return new Response(reply.delta({
    role: "assistant",
    tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }],
  }) + reply.end("tool_calls"), { headers: streamHeaders })
}

export const streamHeaders = { "content-type": "text/event-stream" }
