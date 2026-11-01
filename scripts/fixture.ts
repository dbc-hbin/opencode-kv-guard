import { join, resolve } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/client"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/client"

export type Wire = { model: string; stream?: boolean; tools?: unknown[]; tool_choice?: unknown; messages: { role: string; content?: unknown }[] }

// Isolates OpenCode from the developer's own config, plugins, skills and caches.
export const fixtureEnv = (home: string, config: unknown) => ({
  ...process.env, HOME: home, PWD: home, OPENCODE_TEST_HOME: home,
  XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
  OPENCODE_CONFIG_DIR: join(home, "config", "opencode"), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true", OPENCODE_DISABLE_FFF: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true", OPENCODE_PURE: "false",
})

// Spawns `opencode serve`; `client` resolves once the server prints its URL and
// rejects if the server exits first. `output` settles with stdout and stderr.
export function startServer(home: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn([resolve("node_modules/.bin/opencode"), "serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: home, env: { ...env, OPENCODE_SERVER_PASSWORD: "", OPENCODE_SERVER_USERNAME: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const stderr = new Response(child.stderr).text()
  const ready = Promise.withResolvers<string>()
  const stdout = (async () => {
    let text = ""
    const decoder = new TextDecoder()
    const reader = child.stdout.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
        const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text)
        if (match) ready.resolve(match[1]!)
      }
    } finally { reader.releaseLock() }
    return text
  })()
  const exited = child.exited.then(async (code) => { throw new Error(`OpenCode server exited (${code}): ${await stderr}`) })
  const client = Promise.race([ready.promise, exited]).then((baseUrl) => createOpencodeClient({ baseUrl, directory: home, throwOnError: true }))
  return { child, client, output: Promise.all([stdout, stderr]) }
}

const encoder = new TextEncoder()
export const sse = (text: string, finish: string, promptTokens = 100) => {
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  const usage = `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } })}\n\n`
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(chunk({ role: "assistant", content: text }, null) + chunk({}, finish) + usage + "data: [DONE]\n\n")); controller.close() } }), { headers: { "content-type": "text/event-stream" } })
}

// The SDK cancels its SSE reader with `void reader.cancel()` on abort; that
// rejection is not ours to handle and must not fail the run.
export const ignoreAbortRejections = (signal: AbortSignal) => {
  process.on("unhandledRejection", (reason) => { if (!(signal.aborted && reason instanceof DOMException && reason.name === "AbortError")) throw reason })
}

// Subscribe before any prompt so no event is missed. Idle events can arrive
// after prompt() returns, so waits key on observed state instead.
export async function subscribe(client: OpencodeClient, signal: AbortSignal, listener?: (event: Event) => void) {
  const waiters: { ready: (type: string, properties: unknown) => boolean; resolve: () => void }[] = []
  const stream = await client.event.subscribe({ signal, sseMaxRetryAttempts: 0 })
  void (async () => {
    for await (const event of stream.stream) {
      listener?.(event)
      for (const waiter of [...waiters]) if (waiter.ready(event.type, event.properties)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve() }
    }
  })().catch(() => {})
  return (ready: (type: string, properties: unknown) => boolean) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    waiters.push({ ready, resolve })
    return promise
  }
}
