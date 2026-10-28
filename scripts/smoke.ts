import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Server, Subprocess } from "bun"
import { z } from "zod"

const requestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()),
  tools: z.array(z.unknown()).optional(),
  max_tokens: z.number().optional(),
}).passthrough()
type Capture = { body: z.infer<typeof requestSchema>; headers: Headers; finish: () => void }
const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-kv-guard-smoke-")))
const binary = resolve("node_modules/.bin/opencode")
const plugin = pathToFileURL(resolve("dist/opencode-kv-guard.js")).href
const encoder = new TextEncoder()
const children: Subprocess<"ignore", "pipe", "pipe">[] = []
const servers: Server<undefined>[] = []

async function scenario(guarded: boolean, disableTitle = false, codeMode = false) {
  const home = join(root, codeMode ? "code-mode" : disableTitle ? "no-title" : guarded ? "guarded" : "baseline")
  await mkdir(home, { recursive: true })
  const fixture = join(home, "fixture.txt")
  await Bun.write(fixture, "Fixture content for a real read-tool round trip.\n")
  const skillDirectory = join(home, ".opencode", "skills", "fixture-skill")
  await mkdir(skillDirectory, { recursive: true })
  const skillDescription = "Use when checking the local fixture tool round trip; retain the original instructions."
  await Bun.write(join(skillDirectory, "SKILL.md"), `---\nname: fixture-skill\ndescription: ${skillDescription}\n---\nRead the local fixture before answering.\n`)
  const waiting: Array<(capture: Capture) => void> = []
  const buffered: Capture[] = []
  const captures: Capture[] = []
  let active = 0
  let maxActive = 0
  let mainCalls = 0
  let mcpCalls = 0
  const next = () => {
    const ready = buffered.shift()
    if (ready) return Promise.resolve(ready)
    const { promise, resolve } = Promise.withResolvers<Capture>()
    waiting.push(resolve)
    return promise
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/mcp") {
        if (request.method !== "POST") return new Response(null, { status: 405 })
        const rpc = z.object({
          id: z.union([z.string(), z.number()]).optional(), method: z.string(),
          params: z.object({ name: z.string().optional(), arguments: z.object({ value: z.string() }).optional() }).passthrough().optional(),
        }).parse(await request.json())
        if (rpc.id === undefined) return new Response(null, { status: 202 })
        let result: unknown
        if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "kv-fixture", version: "1" } }
        else if (rpc.method === "tools/list") result = { tools: [{ name: "echo", description: "Return the supplied fixture value.", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] }
        else if (rpc.method === "tools/call") {
          assert.equal(rpc.params?.name, "echo")
          assert.equal(rpc.params.arguments?.value, "CODE_MODE_OK")
          mcpCalls++
          result = { content: [{ type: "text", text: "CODE_MODE_OK" }] }
        } else return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } })
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result })
      }
      if (new URL(request.url).pathname !== "/tenant/v1/chat/completions") return new Response("not found", { status: 404 })
      const body = requestSchema.parse(await request.json())
      const main = Array.isArray(body.tools) && body.tools.length > 0
      const call = main ? ++mainCalls : 0
      active++
      maxActive = Math.max(maxActive, active)
      let control: ReadableStreamDefaultController<Uint8Array>
      const chunk = (delta: unknown, finish_reason: string | null = null) => encoder.encode(`data: ${JSON.stringify({ id: `fixture-${captures.length}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      const stream = new ReadableStream<Uint8Array>({ start(controller) { control = controller; controller.enqueue(chunk({ role: "assistant" })) } })
      const capture: Capture = {
        body, headers: request.headers,
        finish() {
          if (main) control.enqueue(chunk({ reasoning_text: `Fixture reasoning for step ${call}.` }))
          if (main && call === 1) {
            control.enqueue(chunk({ tool_calls: [{ index: 0, id: "fixture-read-call", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: fixture }) } }] }))
            control.enqueue(chunk({}, "tool_calls"))
          } else if (main && codeMode && call === 2) {
            control.enqueue(chunk({ tool_calls: [{ index: 0, id: "fixture-mcp-call", type: "function", function: { name: "execute", arguments: JSON.stringify({ code: 'return await tools.fixture.echo({value: "CODE_MODE_OK"})' }) } }] }))
            control.enqueue(chunk({}, "tool_calls"))
          } else {
            control.enqueue(chunk({ content: main ? "KV_GUARD_OK" : "Fixture session" }))
            control.enqueue(chunk({}, "stop"))
          }
          control.enqueue(encoder.encode(`data: ${JSON.stringify({ id: `fixture-${captures.length}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: 2048, completion_tokens: 32, total_tokens: 2080, prompt_tokens_details: { cached_tokens: call > 1 ? 1024 : 0 } } })}\n\n`))
          control.enqueue(encoder.encode("data: [DONE]\n\n"))
          active--
          control.close()
        },
      }
      captures.push(capture)
      const subscriber = waiting.shift()
      if (subscriber) subscriber(capture)
      else buffered.push(capture)
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  servers.push(server)
  const config = {
    model: "fixture/fixture", small_model: "fixture/fixture", enabled_providers: ["fixture"],
    snapshot: false,
    ...(codeMode ? { mcp: { fixture: { type: "remote", url: `http://127.0.0.1:${server.port}/mcp`, oauth: false } } } : {}),
    ...(disableTitle ? { agent: { title: { disable: true } } } : {}),
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Local smoke fixture", options: { baseURL: `http://127.0.0.1:${server.port}/\${KV_GUARD_SMOKE_TENANT}/v1`, apiKey: "local-fixture-not-a-secret" }, models: { fixture: { name: "fixture", limit: { context: 32768, output: 1024 } } } } },
    ...(guarded ? { plugin: [[plugin, { providers: ["fixture"], maxOutputTokens: 128, diagnostics: true, glm: { models: ["fixture"] } }]] } : {}),
  }
  const env = {
    ...process.env,
    HOME: home, PWD: home, KV_GUARD_SMOKE_TENANT: "tenant", OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    OPENCODE_CONFIG_DIR: join(home, "config", "opencode"), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_EXPERIMENTAL_CODE_MODE: String(codeMode),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true", OPENCODE_DISABLE_FFF: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true", OPENCODE_PURE: "false",
  }
  const firstArrival = next()
  const child = Bun.spawn([binary, "run", "--dir", home, "--format", "json", "--model", "fixture/fixture", `Read ${fixture} then answer.`], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  children.push(child)
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const ended = child.exited.then(async (exit) => { throw new Error(`CLI exited before expected request (${exit})\n${await stderr}\n${await stdout}`) })
  // Every wait is for an exact request/exit event; the overall deadline below
  // is a failure bound, not a sleep used to make assertions pass.
  const first = await Promise.race([firstArrival, ended])
  if (guarded) {
    first.finish()
    if (!disableTitle) {
      const second = await Promise.race([next(), ended])
      second.finish()
    }
  } else {
    const second = await Promise.race([next(), ended])
    assert.equal(maxActive, 2, "baseline title and main requests must overlap")
    first.finish()
    second.finish()
  }
  const third = await Promise.race([next(), ended])
  third.finish()
  if (codeMode) (await Promise.race([next(), ended])).finish()
  const exit = await child.exited
  const output = await stdout
  const errors = await stderr
  // The rejection branch above is a sentinel for premature exits; consume it
  // now that this process has finished normally.
  void ended.catch(() => {})
  assert.equal(exit, 0, errors)
  assert.ok(output.includes("KV_GUARD_OK"), `${errors}\n${output}`)
  assert.equal(captures.length, (disableTitle ? 2 : 3) + Number(codeMode))
  const main = captures.filter((capture) => capture.body.tools?.length)
  assert.equal(main.length, codeMode ? 3 : 2)
  assert.ok(main[1]!.body.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("Fixture content")), "actual read result must return to the model")
  if (guarded) {
    assert.equal(maxActive, 1)
    assert.ok(captures.every((capture) => capture.body.max_tokens === 128))
    assert.ok(captures.every((capture) => !capture.headers.has("x-opencode-kv-guard-agent")))
    assert.ok(captures.every((capture) => !capture.headers.has("x-opencode-kv-guard-limits")))
    assert.ok(captures.every((capture) => !capture.headers.has("x-opencode-kv-guard-user")))
    assert.ok(captures.every((capture) => !capture.headers.has("x-opencode-kv-guard-system-suffix")))
    assert.ok(!JSON.stringify(captures.map((capture) => capture.body.messages)).includes("kv-guard-user:"))
    assert.ok(captures.every((capture) => capture.headers.has("x-litellm-session-id")))
    assert.ok(!JSON.stringify(main.map((capture) => capture.body.messages)).includes("Today's date:"))
    const previous = main[0]!.body.messages
    assert.deepEqual(main[1]!.body.messages.slice(0, previous.length), previous, "tool round trip must preserve the entire previous request prefix")
    assert.equal(main[1]!.body.messages.find((message) => message.role === "assistant")?.reasoning_content, "Fixture reasoning for step 1.")
    const system = main[0]!.body.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n")
    assert.ok(system.includes(skillDescription), "skill routing description must be preserved")
    assert.ok(!system.includes(join(skillDirectory, "SKILL.md")), "eager skill path must be removed")
    assert.ok(captures.every((capture) => capture.body.reasoning_effort === "max"))
    if (codeMode) {
      const tools = main[0]!.body.tools as { function: { name: string } }[]
      assert.ok(tools.some((tool) => tool.function.name === "execute"))
      assert.ok(!tools.some((tool) => tool.function.name === "fixture_echo"))
      assert.equal(mcpCalls, 1)
      assert.ok(main[2]!.body.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("CODE_MODE_OK")))
    }
  } else assert.ok(JSON.stringify(main[0]!.body.messages).includes("Today's date:"))
  server.stop(true)
  return { requests: captures.length, maxActive, titleEnabled: !disableTitle, codeMode, mcpCalls, glmReasoningReplay: guarded, skillCatalogCompacted: guarded, systemChars: main[0]!.body.messages.filter((message) => message.role === "system").reduce((sum, message) => {
    assert.equal(typeof message.content, "string")
    return sum + (message.content as string).length
  }, 0), toolRoundTrip: true, generatedDate: !guarded, stdout: output.trim() }
}

const deadline = Promise.withResolvers<never>()
const timer = setTimeout(() => deadline.reject(new Error("Pinned CLI smoke exceeded 120 seconds")), 120_000)
try {
  const results = await Promise.race([(async () => ({ baseline: await scenario(false), guarded: await scenario(true), noTitle: await scenario(true, true), codeMode: await scenario(true, true, true) }))(), deadline.promise])
  assert.ok(results.guarded.systemChars < results.baseline.systemChars)
  console.log(JSON.stringify({ version: "1.19.4", ...results }, null, 2))
} finally {
  clearTimeout(timer)
  for (const child of children) if (child.exitCode === null) child.kill()
  for (const server of servers) server.stop(true)
  await Promise.all(children.map((child) => child.exited))
  await rm(root, { recursive: true, force: true })
}
