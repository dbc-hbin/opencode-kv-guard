// Real-server check for speculative compaction: once a turn lands just below
// the trigger, the summary is prepared in the background after its response,
// and the turn that crosses the trigger adopts it. That summary must therefore
// be built from the earlier history, without the crossing turn's user text.
import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { fixtureEnv, ignoreAbortRejections, sse, startServer, subscribe, type Wire } from "./fixture"

const home = await realpath(await mkdtemp(join(tmpdir(), "opencode-speculative-")))
const providerID = "opencode-fixture"
const limit = { context: 32768, output: 512 }
const requests: Wire[] = []
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
const { child, client: started, output } = startServer(home, fixtureEnv(home, config))
const deadline = Promise.withResolvers<never>()
const timer = setTimeout(() => deadline.reject(new Error("Speculative compaction smoke exceeded 90 seconds")), 90_000)
const events = new AbortController()
ignoreAbortRejections(events.signal)
try {
  const result = await Promise.race([(async () => {
    const client = await started
    const toasts: string[] = []
    await subscribe(client, events.signal, (event) => { if (event.type === "tui.toast.show") toasts.push(JSON.stringify(event.properties)) })
    const created = await client.session.create({ body: { title: "Speculative fixture" } })
    const sessionID = created.data!.id
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
  await output
  proxy.stop(true)
  await rm(home, { recursive: true, force: true })
}
