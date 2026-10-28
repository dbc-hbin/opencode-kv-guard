import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk/client"
import { z } from "zod"

const wire = z.object({
  model: z.string(), stream: z.boolean().optional(), max_tokens: z.number().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()),
}).passthrough()
const home = await realpath(await mkdtemp(join(tmpdir(), "opencode-rolling-compaction-")))
const requests: z.infer<typeof wire>[] = []
const requestIDs: (string | null)[] = []
const answers: string[] = []
const providerID = "opencode-fixture"
const limit = { context: 32768, output: 512 }
const triggerRatio = 0.85
let summaries = 0
let normal = 0
const summaryCountAtMain: number[] = []
const marker = "COMPACTED_HISTORY_MARKER"
const encoder = new TextEncoder()
const proxy = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
    const body = wire.parse(await request.json())
    requests.push(body)
    if (body.stream === false) {
      summaries++
      return Response.json({
        id: `summary-${summaries}`, object: "chat.completion", created: 1, model: "fixture",
        choices: [{ index: 0, message: { role: "assistant", content: `${marker}: Preserve task goals, prior observations and the current request.` }, finish_reason: "stop" }],
        usage: { prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4), completion_tokens: 32, total_tokens: Math.ceil(JSON.stringify(body.messages).length / 4) + 32 },
      })
    }
    summaryCountAtMain.push(summaries)
    normal++
    const text = `Answer ${normal}. ` + "observation ".repeat(160)
    answers.push(text)
    requestIDs.push(request.headers.get("x-opencode-request"))
    const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: `main-${normal}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    // The first controlled response reports substantially more tokens than the
    // local byte estimator. The next turn must react to that observed usage.
    const promptTokens = normal === 1
      ? Math.floor((limit.context - (body.max_tokens ?? limit.output)) * triggerRatio) - 1
      : Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4)
    const usage = `data: ${JSON.stringify({ id: `main-${normal}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 480, total_tokens: promptTokens + 480, prompt_tokens_details: { cached_tokens: normal > 1 ? Math.min(promptTokens, 1024) : 0 } } })}\n\n`
    const bytes = chunk({ role: "assistant", content: text }) + chunk({}, "stop") + usage + "data: [DONE]\n\n"
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(bytes)); controller.close() } }), { headers: { "content-type": "text/event-stream" } })
  },
})
const config = {
  model: `${providerID}/fixture`, enabled_providers: [providerID], snapshot: false,
  agent: { title: { disable: true } },
  compaction: { auto: false, prune: false },
  provider: { [providerID]: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${proxy.port}/v1`, apiKey: "local-fixture" }, models: { fixture: { name: "fixture", limit } } } },
  plugin: [[pathToFileURL(resolve("dist/opencode-kv-guard.js")).href, { providers: [providerID], diagnostics: true, compaction: { triggerRatio } }]],
}
const env = {
  ...process.env, HOME: home, PWD: home, OPENCODE_TEST_HOME: home,
  XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
  OPENCODE_CONFIG_DIR: join(home, "config", "opencode"), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true", OPENCODE_DISABLE_FFF: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true", OPENCODE_PURE: "false",
  OPENCODE_SERVER_PASSWORD: "", OPENCODE_SERVER_USERNAME: "",
}
const deadline = Promise.withResolvers<never>()
const timer = setTimeout(() => deadline.reject(new Error("Rolling compaction smoke exceeded 120 seconds")), 120_000)
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = []
const outputs: Promise<string>[] = []
async function startServer() {
  const ready = Promise.withResolvers<string>()
  const child = Bun.spawn([resolve("node_modules/.bin/opencode"), "serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  children.push(child)
  const stderr = new Response(child.stderr).text()
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
  outputs.push(stdout, stderr)
  const exited = child.exited.then(async (code) => { throw new Error(`OpenCode server exited (${code}): ${await stderr}`) })
  const baseUrl = await Promise.race([ready.promise, exited])
  return { child, client: createOpencodeClient({ baseUrl, directory: home, throwOnError: true }) }
}
try {
  const result = await Promise.race([(async () => {
    let runtime = await startServer()
    let client = runtime.client
    const created = await client.session.create({ body: { title: "Rolling compaction fixture" } })
    assert.ok(created.data)
    const sessionID = created.data.id
    const turns = 15
    let restartAfter: number | undefined
    let summariesAtRestart = 0
    for (let turn = 0; turn < turns; turn++) {
      const text = `USER_TURN_${turn}: retain the current instruction.\n` + `detail_${turn} `.repeat(1500)
      const response = await client.session.prompt({ path: { id: sessionID }, body: { model: { providerID, modelID: "fixture" }, parts: [{ type: "text", text }] } })
      assert.ok(response.data, JSON.stringify(response.error))
      assert.equal(response.data.info.error, undefined, JSON.stringify(response.data.info.error))
      assert.ok(response.data.parts.some((part) => part.type === "text" && part.text.startsWith("Answer ")))
      if (turn === 1) {
        const first = requests[0]!
        const withoutCompaction = { ...first, messages: [...first.messages, { role: "assistant", content: answers[0] }, { role: "user", content: text }] }
        assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(withoutCompaction)) / 4) < Math.floor((limit.context - limit.output) * triggerRatio), "the byte estimate alone must not trigger this compaction")
        assert.ok(summaries > 0, "reported usage must trigger compaction by the second user turn")
      }
      if (restartAfter !== undefined && turn === restartAfter + 1) {
        assert.equal(summaries, summariesAtRestart, "a fresh OpenCode process must reuse the completed checkpoint without resummarizing")
        const before = requests.filter((request) => request.stream !== false)[turn - 1]!
        const after = requests.filter((request) => request.stream !== false)[turn]!
        assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages, "restart must reproduce the prior wire prefix")
      }
      if (restartAfter === undefined && summaries > 0 && turn < turns - 1) {
        restartAfter = turn
        summariesAtRestart = summaries
        runtime.child.kill()
        await runtime.child.exited
        runtime = await startServer()
        client = runtime.client
      }
    }
    const stored = await client.session.messages({ path: { id: sessionID } })
    assert.equal(stored.data?.filter((message) => message.info.role === "user").length, turns, "original OpenCode user history must remain intact")
    assert.ok(!JSON.stringify(stored.data).includes("kv-guard-user:"), "private provenance must not enter stored history")
    assert.ok(!JSON.stringify(requests).includes("kv-guard-user:"), "private provenance must not reach main or summary inference")
    const main = requests.filter((request) => request.stream !== false)
    assert.equal(main.length, turns)
    assert.equal(new Set(requestIDs).size, turns, "native opencode-prefixed providers must send a changing per-turn request ID")
    assert.ok(requestIDs.every(Boolean))
    assert.ok(summaries > 0, "preflight compaction must perform real summary requests")
    assert.notEqual(restartAfter, undefined, "checkpoint restore must be exercised in a fresh process")
    const compacted = main.filter((request) => JSON.stringify(request.messages).includes(marker))
    const reuses = main.filter((request, index) => index > 0 && JSON.stringify(request.messages).includes(marker) && summaryCountAtMain[index] === summaryCountAtMain[index - 1]).length
    assert.ok(reuses > 0, "a frozen summary must be reused for subsequent ordinary requests")
    const lengths = main.map((request) => JSON.stringify(request.messages).length)
    assert.ok(lengths.some((length, index) => index > 0 && length < lengths[index - 1]!), "wire history must shrink at a compaction boundary")
    for (let index = 0; index < main.length; index++) {
      assert.ok(JSON.stringify(main[index]!.messages).includes(`USER_TURN_${index}: retain the current instruction.`), "current instruction must not be summarized away")
    }
    return { version: "1.19.4", mainRequests: normal, summaryRequests: summaries, usageTriggeredEarlyCompaction: true, perTurnRequestIDsPreserved: new Set(requestIDs).size, restartAfterTurn: restartAfter, checkpointReusedAcrossProcess: true, requestsWithSummary: compacted.length, requestsReusingSummaryWithoutNewInference: reuses, wireMessageChars: lengths, originalUserTurnsPreserved: turns }
  })(), deadline.promise])
  console.log(JSON.stringify(result, null, 2))
} finally {
  clearTimeout(timer)
  for (const child of children) if (child.exitCode === null) child.kill()
  await Promise.all(children.map((child) => child.exited))
  await Promise.all(outputs)
  proxy.stop(true)
  await rm(home, { recursive: true, force: true })
}
