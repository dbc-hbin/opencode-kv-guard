// Real-server check for the two recovery paths:
// 1. A provider context-overflow 400 on the main request is compacted below the
//    reported size and resent once, so OpenCode records a normal answer.
// 2. A response that stops at the output limit is continued with one synthetic
//    prompt; a real user turn resets the consecutive-continuation count.
import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk/client"

type Wire = { model: string; stream?: boolean; tools?: unknown[]; tool_choice?: unknown; messages: { role: string; content?: unknown }[] }
const home = await realpath(await mkdtemp(join(tmpdir(), "opencode-recovery-")))
const providerID = "opencode-fixture"
const limit = { context: 32768, output: 512 }
const requests: Wire[] = []
const encoder = new TextEncoder()
let overflowArmed = false
let handoffOverflowArmed = false
let truncateNext = 0
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
    if (body.stream === false && body.tools !== undefined && handoffOverflowArmed) {
      handoffOverflowArmed = false
      return Response.json({ object: "error", message: `This model's maximum context length is ${limit.context} tokens. However, you requested ${limit.context + 100} tokens (${limit.context - limit.output + 100} in the messages, ${limit.output} in the completion).`, type: "BadRequestError", code: 400 }, { status: 400 })
    }
    if (body.stream === false) return Response.json({ id: "summary", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "RECOVERY_SUMMARY_MARKER" }, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 } })
    // Usage follows the plugin's own bytes/4 estimate, so only the overflow
    // report below disagrees with it.
    const tokens = Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4)
    if (overflowArmed) {
      overflowArmed = false
      // vLLM's wording; the server's tokenizer counts more than the estimate.
      const reported = limit.context - limit.output + 500
      return Response.json({ object: "error", message: `This model's maximum context length is ${limit.context} tokens. However, you requested ${reported + limit.output} tokens (${reported} in the messages, ${limit.output} in the completion).`, type: "BadRequestError", code: 400 }, { status: 400 })
    }
    if (truncateNext > 0) {
      truncateNext--
      return sse("partial output cut", "length", tokens)
    }
    return sse(`Answer ${requests.length}. ${"observation ".repeat(2000)}`, "stop", tokens)
  },
})
const config = {
  model: `${providerID}/fixture`, enabled_providers: [providerID], snapshot: false,
  agent: { title: { disable: true } },
  compaction: { auto: false, prune: false },
  provider: { [providerID]: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${proxy.port}/v1`, apiKey: "local-fixture" }, models: { fixture: { name: "fixture", limit, variants: { careful: { temperature: 0.1 } } } } } },
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
const timer = setTimeout(() => deadline.reject(new Error("Recovery smoke exceeded 90 seconds")), 90_000)
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
    const mainRequests = () => requests.filter((request) => request.stream !== false).length
    const idleAfter = (count: number) => until((type) => type === "session.idle" && mainRequests() >= count)
    const created = await client.session.create({ body: { title: "Recovery fixture" } })
    const sessionID = created.data!.id
    // The variant must survive a continuation; OpenCode stores an omitted one as default.
    const prompt = (text: string) => client.session.prompt({ path: { id: sessionID }, body: { model: { providerID, modelID: "fixture" }, variant: "careful", system: "SESSION_SYSTEM_MARKER", parts: [{ type: "text", text }] } as Parameters<typeof client.session.prompt>[0]["body"] })

    for (const turn of [0, 1, 2]) assert.equal((await prompt(`USER_TURN_${turn}`)).data?.info.error, undefined)

    // 1. Context overflow on the main request.
    overflowArmed = true
    const before = requests.length
    const answer = await prompt("OVERFLOW_TURN")
    assert.equal(answer.data?.info.error, undefined, JSON.stringify(answer.data?.info.error))
    const recovery = requests.slice(before)
    const summaries = recovery.filter((request) => request.stream === false)
    assert.ok(summaries.length >= 1, "overflow must trigger compaction")
    assert.ok(summaries.every((request) => request.tools === undefined), "an overflowed prefix must not be extended into a handoff")
    const resent = recovery.filter((request) => request.stream !== false)
    assert.equal(resent.length, 2, "the main request is sent once and resent once")
    assert.ok(JSON.stringify(resent[1]!.messages).includes("RECOVERY_SUMMARY_MARKER"))
    assert.ok(JSON.stringify(resent[1]!.messages).includes("OVERFLOW_TURN"))

    // 1b. The rolling summary handoff itself overflows before the main
    // request is sent. Recovery must fold without the prefix and send once.
    // Usage stays at bytes/4, so the next turn crosses the trigger again only
    // once enough history accumulated; keep prompting until a handoff appears.
    handoffOverflowArmed = true
    let handoffTurn = 0
    while (handoffOverflowArmed && handoffTurn < 12) {
      const beforeTurn = requests.length
      const reply = await prompt(`HANDOFF_TURN_${handoffTurn++}`)
      assert.equal(reply.data?.info.error, undefined, JSON.stringify(reply.data?.info.error))
      if (!handoffOverflowArmed) {
        const turn = requests.slice(beforeTurn)
        assert.equal(turn.filter((request) => request.stream === false && request.tools !== undefined).length, 1, "the overflowing handoff is sent once")
        assert.ok(turn.some((request) => request.stream === false && request.tools === undefined), "recovery folds without the overflowed prefix")
        assert.equal(turn.filter((request) => request.stream !== false).length, 1, "the main request is sent once after recovery")
      }
    }
    assert.equal(handoffOverflowArmed, false, "a summary handoff must be attempted")

    // 2. Output-limit truncation: continued once, then the next answer stops.
    truncateNext = 1
    const beforeTruncated = mainRequests()
    const continued = idleAfter(beforeTruncated + 2)
    await prompt("TRUNCATED_TURN")
    await continued
    const afterTruncated = requests.filter((request) => request.stream !== false).slice(beforeTruncated)
    assert.equal(afterTruncated.length, 2, "one truncated response gets exactly one continuation")
    assert.ok(JSON.stringify(afterTruncated[1]!.messages.at(-1)).includes("stopped at the output token limit"))
    const stored = (await client.session.messages({ path: { id: sessionID } })).data!
    const reminder = stored.findLast((message) => message.info.role === "user")!
    assert.ok(reminder.parts.every((part) => part.type === "text" && part.synthetic), "continuation prompt must be synthetic")
    const reminderInfo = reminder.info as typeof reminder.info & { model: { variant?: string }; system?: string }
    assert.equal(reminderInfo.model.variant, "careful", "continuation must keep the turn's variant")
    assert.equal(reminderInfo.system, "SESSION_SYSTEM_MARKER", "continuation must keep the turn's system prompt")
    assert.equal(afterTruncated[1]!.messages[0]!.role, "system")
    assert.ok(String(afterTruncated[1]!.messages[0]!.content).includes("SESSION_SYSTEM_MARKER"))

    // 3. Repeated truncation stops after three consecutive continuations and
    // warns through a TUI toast instead of prompting again.
    truncateNext = 10
    const beforeCap = mainRequests()
    const warned = until((type, properties) => type === "tui.toast.show" && JSON.stringify(properties).includes("output limit"))
    await prompt("ALWAYS_TRUNCATED")
    await warned
    assert.equal(mainRequests() - beforeCap, 4, "the original response plus three continuations")
    truncateNext = 0
    const capRequests = 4
    return { version: "1.19.4", overflowSummaryRequests: summaries.length, overflowMainRequests: resent.length, handoffOverflowTurn: handoffTurn, truncatedContinuations: afterTruncated.length - 1, cappedContinuations: capRequests - 1 }
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
