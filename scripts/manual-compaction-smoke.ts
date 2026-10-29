// Real-server check: OpenCode's manual /compact (session.summarize) is answered
// by the plugin's prefix handoff, and OpenCode stores the result as a native
// compaction. A second /compact with nothing new falls back to the native
// request because no cached exchange matches.
import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk/client"

type Wire = { model: string; stream?: boolean; tools?: unknown[]; tool_choice?: unknown; messages: { role: string; content?: unknown }[] }
const home = await realpath(await mkdtemp(join(tmpdir(), "opencode-manual-compaction-")))
const providerID = "opencode-fixture"
const limit = { context: 32768, output: 512 }
const requests: Wire[] = []
const handoffSummary = "## Objective\n- HANDOFF_SUMMARY_MARKER"
const nativeSummary = "## Objective\n- NATIVE_SUMMARY_MARKER"
const encoder = new TextEncoder()
const sse = (text: string) => {
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  const usage = `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + usage + "data: [DONE]\n\n")); controller.close() } }), { headers: { "content-type": "text/event-stream" } })
}
const proxy = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
    const body = await request.json() as Wire
    requests.push(body)
    // The plugin's handoff is the only non-streaming request in this scenario.
    if (body.stream === false) return Response.json({ id: "handoff", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: handoffSummary }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920, prompt_tokens_details: { cached_tokens: 800 } } })
    const last = JSON.stringify(body.messages.at(-1)?.content ?? "")
    if (last.includes("Here is the conversation so far")) return sse(nativeSummary)
    return sse(`Answer ${requests.length}.`)
  },
})
const config = {
  model: `${providerID}/fixture`, enabled_providers: [providerID], snapshot: false,
  agent: { title: { disable: true } },
  compaction: { auto: false, prune: false },
  provider: { [providerID]: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${proxy.port}/v1`, apiKey: "local-fixture" }, models: { fixture: { name: "fixture", limit } } } },
  plugin: [[pathToFileURL(resolve("dist/opencode-kv-guard.js")).href, { providers: [providerID], diagnostics: true }]],
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
const timer = setTimeout(() => deadline.reject(new Error("Manual compaction smoke exceeded 90 seconds")), 90_000)
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
    const created = await client.session.create({ body: { title: "Manual compaction fixture" } })
    const sessionID = created.data!.id
    for (const turn of [0, 1]) {
      const response = await client.session.prompt({ path: { id: sessionID }, body: { model: { providerID, modelID: "fixture" }, parts: [{ type: "text", text: `USER_TURN_${turn}` }] } })
      assert.equal(response.data?.info.error, undefined, JSON.stringify(response.data?.info.error))
    }
    const lastMain = requests.at(-1)!
    const mainCount = requests.length

    await client.session.summarize({ path: { id: sessionID }, body: { providerID, modelID: "fixture" } })
    const handoffs = requests.slice(mainCount).filter((request) => request.stream === false)
    assert.equal(handoffs.length, 1, "manual /compact must be answered by exactly one prefix handoff")
    const handoff = handoffs[0]!
    assert.deepEqual(handoff.messages.slice(0, lastMain.messages.length), lastMain.messages, "handoff must extend the last dispatched main request")
    assert.deepEqual(handoff.tools, lastMain.tools, "handoff must keep the cached tool catalog")
    const instruction = String(handoff.messages.at(-1)?.content)
    assert.ok(!instruction.includes("Here is the conversation so far") && !instruction.includes("[User]: USER_TURN_0"), "the serialized transcript must be replaced by the cached prefix")
    assert.ok(instruction.includes("Create a new anchored summary"), "native summary instructions must be preserved")
    const nativePrompt = "Here is the conversation so far"
    assert.ok(!requests.slice(mainCount).some((request) => request.stream !== false && JSON.stringify(request.messages.at(-1)?.content).includes(nativePrompt)), "the native compaction request must not reach the provider")

    const stored = (await client.session.messages({ path: { id: sessionID } })).data!
    const summaryMessage = stored.findLast((message) => message.info.role === "assistant" && message.info.summary)
    assert.ok(summaryMessage, "OpenCode must store the handoff result as a native compaction summary")
    assert.ok(summaryMessage.parts.some((part) => part.type === "text" && part.text.includes("HANDOFF_SUMMARY_MARKER")))
    assert.equal(summaryMessage.info.role === "assistant" && summaryMessage.info.error, undefined)
    assert.ok(summaryMessage.info.role === "assistant" && summaryMessage.info.tokens.cache.read === 800, "handoff usage must reach OpenCode")

    // Nothing new since the last compaction: no cached exchange matches.
    const beforeSecond = requests.length
    await client.session.summarize({ path: { id: sessionID }, body: { providerID, modelID: "fixture" } })
    const second = requests.slice(beforeSecond)
    assert.ok(second.every((request) => request.stream !== false), "a stale exchange must not produce a handoff")
    assert.ok(second.some((request) => JSON.stringify(request.messages.at(-1)?.content).includes(nativePrompt)), "fallback must send the unchanged native compaction request")
    const after = (await client.session.messages({ path: { id: sessionID } })).data!
    assert.ok(after.some((message) => message.parts.some((part) => part.type === "text" && part.text.includes("NATIVE_SUMMARY_MARKER"))), "native fallback summary must be stored")

    // The next ordinary turn sends OpenCode's post-compaction history.
    await client.session.prompt({ path: { id: sessionID }, body: { model: { providerID, modelID: "fixture" }, parts: [{ type: "text", text: "USER_TURN_2" }] } })
    const next = JSON.stringify(requests.at(-1)!.messages)
    assert.ok(next.includes("NATIVE_SUMMARY_MARKER") && next.includes("USER_TURN_2"))
    return { version: "1.19.4", handoffMessages: handoff.messages.length, cachedPrefixMessages: lastMain.messages.length, nativeFallbackOnStaleExchange: true, summaryCacheRead: 800 }
  })(), deadline.promise])
  console.log(JSON.stringify(result, null, 2))
} finally {
  clearTimeout(timer)
  if (child.exitCode === null) child.kill()
  await child.exited
  await stderr
  proxy.stop(true)
  await rm(home, { recursive: true, force: true })
}
