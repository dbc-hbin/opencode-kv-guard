// Real-server check for speculative compaction: once a turn lands just below
// the trigger, the summary is prepared in the background after its response,
// and the turn that crosses the trigger adopts it. That summary must therefore
// be built from the earlier history, without the crossing turn's user text.
import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk/client"

type Wire = { model: string; stream?: boolean; tools?: unknown[]; tool_choice?: unknown; messages: { role: string; content?: unknown }[] }
const home = await realpath(await mkdtemp(join(tmpdir(), "opencode-speculative-")))
const providerID = "opencode-fixture"
const limit = { context: 32768, output: 512 }
const requests: Wire[] = []
const encoder = new TextEncoder()
const sse = (text: string, finish: string, promptTokens = 100) => {
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  const usage = `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } })}\n\n`
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(chunk({ role: "assistant", content: text }, null) + chunk({}, finish) + usage + "data: [DONE]\n\n")); controller.close() } }), { headers: { "content-type": "text/event-stream" } })
}
const proxy = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
    const body = await request.json() as Wire
    requests.push(body)
    if (body.stream === false) return Response.json({ id: "summary", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "SPECULATIVE_SUMMARY_MARKER" }, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 } })
    // Usage follows the plugin's bytes/4 estimate; each turn grows the
    // history by about 650 tokens, well inside the speculation band.
    return sse(`Answer ${requests.length}. ${"observation ".repeat(200)}`, "stop", Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4))
  },
})
const config = {
  model: `${providerID}/fixture`, enabled_providers: [providerID], snapshot: false,
  agent: { title: { disable: true } },
  compaction: { auto: false, prune: false },
  provider: { [providerID]: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${proxy.port}/v1`, apiKey: "local-fixture" }, models: { fixture: { name: "fixture", limit } } } },
  plugin: [[pathToFileURL(resolve("dist/opencode-kv-guard.js")).href, { providers: [providerID], diagnostics: true, speculativeCompaction: true }]],
}
const env = {
  ...process.env, HOME: home, PWD: home, OPENCODE_TEST_HOME: home,
  XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
  OPENCODE_CONFIG_DIR: join(home, "config", "opencode"), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true", OPENCODE_DISABLE_FFF: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true", OPENCODE_PURE: "false",
  OPENCODE_SERVER_PASSWORD: "", OPENCODE_SERVER_USERNAME: "",
}
const child = Bun.spawn([resolve("node_modules/.bin/opencode"), "serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
const stderr = new Response(child.stderr).text()
const deadline = Promise.withResolvers<never>()
const timer = setTimeout(() => deadline.reject(new Error("Speculative compaction smoke exceeded 90 seconds")), 90_000)
const events = new AbortController()
// The SDK cancels its SSE reader with `void reader.cancel()` on abort; that
// rejection is not ours to handle and must not fail the run.
process.on("unhandledRejection", (reason) => { if (!(events.signal.aborted && reason instanceof DOMException && reason.name === "AbortError")) throw reason })
try {
  const result = await Promise.race([(async () => {
    const ready = Promise.withResolvers<string>()
    void (async () => {
      let text = ""
      const decoder = new TextDecoder()
      const reader = child.stdout.getReader()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
        const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text)
        if (match) ready.resolve(match[1]!)
      }
    })()
    const exited = child.exited.then(async (code) => { throw new Error(`OpenCode server exited (${code}): ${await stderr}`) })
    const client = createOpencodeClient({ baseUrl: await Promise.race([ready.promise, exited]), directory: home, throwOnError: true })
    // Subscribe before any prompt so no event is missed. Idle events can
    // arrive after prompt() returns, so waits key on observed state instead.
    const waiters: { ready: (type: string, properties: unknown) => boolean; resolve: () => void }[] = []
    const stream = await client.event.subscribe({ signal: events.signal, sseMaxRetryAttempts: 0 })
    void (async () => {
      for await (const event of stream.stream) {
        for (const waiter of [...waiters]) if (waiter.ready(event.type, event.properties)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve() }
      }
    })().catch(() => {})
    const until = (ready: (type: string, properties: unknown) => boolean) => new Promise<void>((resolve) => { waiters.push({ ready, resolve }) })
    const created = await client.session.create({ body: { title: "Speculative fixture" } })
    const sessionID = created.data!.id
    const toasts: string[] = []
    void until((type, properties) => { if (type === "tui.toast.show") toasts.push(JSON.stringify(properties)); return false })
    const prompt = (text: string) => client.session.prompt({ path: { id: sessionID }, body: { model: { providerID, modelID: "fixture" }, parts: [{ type: "text", text }] } })
    let turn = 0
    let marked = -1
    while (turn < 60) {
      const text = `SPEC_TURN_${turn++}`
      assert.equal((await prompt(text)).data?.info.error, undefined)
      marked = requests.findIndex((request) => request.stream !== false && JSON.stringify(request.messages).includes("SPECULATIVE_SUMMARY_MARKER"))
      if (marked >= 0) break
    }
    assert.ok(marked >= 0, "compaction must happen within the run")
    const crossing = `SPEC_TURN_${turn - 1}`
    const summaries = requests.slice(0, marked).filter((request) => request.stream === false)
    assert.equal(summaries.length, 1, "one summary prepares the first compaction")
    assert.ok(!JSON.stringify(summaries[0]!.messages).includes(crossing), "the adopted summary was built before the crossing turn existed")
    // The summary was sent before the crossing turn's first request reached the provider.
    const crossingFirst = requests.findIndex((request) => request.stream !== false && JSON.stringify(request.messages.at(-1)?.content ?? "").includes(crossing))
    assert.ok(requests.indexOf(summaries[0]!) < crossingFirst, "the summary ran in the background before the crossing turn was sent")
    assert.equal(crossingFirst, marked, "the crossing turn is sent once, already compacted")
    assert.ok(JSON.stringify(requests[marked]!.messages).includes(crossing), "the crossing request keeps its current instruction")
    assert.ok(toasts.some((toast) => toast.includes("Session compacted")), "adoption must notify like a compaction")
    return { version: "1.19.4", compactedAtTurn: turn - 1, summaryRequests: summaries.length, handoff: summaries[0]!.tools !== undefined }
  })(), deadline.promise])
  console.log(JSON.stringify(result, null, 2))
} finally {
  clearTimeout(timer)
  events.abort()
  if (child.exitCode === null) child.kill()
  await child.exited
  await stderr
  proxy.stop(true)
  await rm(home, { recursive: true, force: true })
}
