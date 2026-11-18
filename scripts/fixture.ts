import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"

const pluginDirectory = resolve(import.meta.dir, "..")
const version = "2.3.0"
const adapterName = "@ai-sdk/openai-compatible"
const adapterVersion = "2.0.41"
const adapterSpec = `${adapterName}@${adapterVersion}`
const adapterPackage = `aisdk:${adapterSpec}`
export const providerID = "fixture"
const model = { providerID, id: "fixture" }
export const apiKey = "loopback-provider-key"
export const maxOutputTokens = 137
const providerPath = "/tenant/v1/chat/completions"

const data = <T extends z.ZodType>(schema: T) => z.object({ data: schema })
const id = data(z.object({ id: z.string() }))
const wire = z.looseObject({
  model: z.string(),
  stream: z.boolean(),
  max_tokens: z.number().optional(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).optional(),
  messages: z.array(z.looseObject({ role: z.string(), content: z.unknown().optional() })),
  tools: z.array(z.looseObject({
    type: z.string(),
    function: z.looseObject({ name: z.string(), parameters: z.unknown().optional() }).optional(),
  })).optional(),
})

export type Capture = {
  readonly url: string
  readonly headers: Headers
  readonly body: z.infer<typeof wire>
  readonly signal: AbortSignal
}

const message = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  summary: z.string().optional(),
  outcome: z.string().optional(),
  error: z.unknown().optional(),
  content: z.array(z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    name: z.string().optional(),
    state: z.looseObject({ status: z.string(), metadata: z.unknown().optional() }).optional(),
  })).optional(),
})

type Rule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }
type Outcome = "succeeded" | "failed" | "interrupted"
type ServerConfig = { readonly directory: string; readonly providerURL: string }

async function startServer(config: ServerConfig, signal: AbortSignal, fail: (cause: unknown) => void) {
  const { directory, providerURL } = config
  const password = randomUUID()
  const xdgCache = join(directory, "cache")
  const sdk = await realpath(join(pluginDirectory, "node_modules", adapterName))
  z.object({ name: z.literal(adapterName), version: z.literal(adapterVersion) }).parse(await Bun.file(join(sdk, "package.json")).json())
  // v2.3.0 uses the exact npm spec as its cache key and resolves the latest numeric generation.
  const generation = join(xdgCache, "opencode", "npm", adapterSpec, "1", "node_modules", "@ai-sdk")
  await mkdir(generation, { recursive: true })
  await symlink(sdk, join(generation, "openai-compatible"), "junction")

  const inline = {
    model: `${providerID}/${model.id}`,
    update: "disable",
    share: "disabled",
    snapshots: false,
    warming: false,
    agents: { title: { disabled: true } },
    compaction: { auto: false, keep: { tokens: 64 } },
    experimental: { background_compaction: false },
    providers: {
      [providerID]: {
        package: adapterPackage,
        settings: { baseURL: providerURL, apiKey },
        models: { [model.id]: { capabilities: { tools: true }, limit: { context: 32768, output: 1024 } } },
      },
    },
    plugins: [{ package: pluginDirectory, options: {
      providers: [providerID], maxOutputTokens, stateDirectory: join(directory, "kv-guard-state"),
    } }],
  }
  signal.throwIfAborted()
  const child = Bun.spawn([
    join(pluginDirectory, "node_modules", ".bin", "opencode"),
    "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0",
  ], {
    cwd: directory, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: directory, USERPROFILE: directory, TMPDIR: join(directory, "tmp"),
      XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
      XDG_CACHE_HOME: xdgCache, XDG_STATE_HOME: join(directory, "state"),
      OPENCODE_TEST_HOME: directory, OPENCODE_CONFIG_DIR: join(directory, "config", "opencode"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(inline), OPENCODE_DB: join(directory, "session.sqlite"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_FILEWATCHER: "true", OPENCODE_DISABLE_FFF: "true",
      OPENCODE_PRINT_LOGS: "1", OPENCODE_PASSWORD: password, npm_config_offline: "true",
    },
  })
  const ready = Promise.withResolvers<string>()
  const stderr = new Response(child.stderr).text()
  const stdout = (async () => {
    let text = ""
    let pending = ""
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      text += chunk
      pending += chunk
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines)
        if (line.startsWith('{"url":')) ready.resolve(z.object({ url: z.url() }).parse(JSON.parse(line)).url)
    }
    return text
  })()
  void child.exited.then((code) => {
    if (!signal.aborted) fail(new FixtureError(`OpenCode exited unexpectedly (${code})`, directory))
  }, fail)
  void stdout.catch(fail)
  void stderr.catch(fail)
  async function http(path: string, method = "GET", body?: unknown) {
    const result = await fetch(new URL(path, await ready.promise), {
      method, signal,
      headers: {
        authorization: "Basic " + btoa(`opencode:${password}`),
        "x-opencode-directory": encodeURIComponent(directory),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!result.ok) throw new FixtureError(`${method} ${path} (${result.status})`, await result.text())
    return result
  }
  const json = <T extends z.ZodType>(path: string, schema: T, body?: unknown): Promise<z.output<T>> =>
    within(path, http(path, body === undefined ? "GET" : "POST", body).then((response) => response.json()).then((value) => schema.parse(value)))
  return {
    directory,
    async verify() {
      const endpoint = await within(`OpenCode startup in ${directory}`, ready.promise)
      const rejected = await within("Checking unauthenticated /api/info", fetch(new URL("/api/info", endpoint), { signal }))
      assert.equal(rejected.status, 401, "OpenCode must require this server's fixture credential")
      await rejected.body?.cancel()
      const info = await json("/api/info", z.object({ version: z.string(), pid: z.number() }))
      assert.equal(info.version, version, "the smoke must run the pinned CLI")
      // The model handler awaits location plugin activation; the plugin inventory handler does not.
      const models = await json("/api/model", data(z.array(z.object({
        providerID: z.string(), id: z.string(), package: z.string().optional(),
      }))))
      const resolved = models.data.find((item) => item.providerID === providerID && item.id === model.id)
      assert.equal(resolved?.package, adapterPackage, `Resolved fixture model: ${JSON.stringify(resolved)}`)
      const plugins = await json("/api/plugin", data(z.array(z.object({
        id: z.string().optional(),
        source: z.looseObject({ type: z.string(), path: z.string().optional() }),
        features: z.looseObject({ server: z.boolean().optional() }),
        state: z.looseObject({ status: z.string() }),
      }))))
      const plugin = plugins.data.find(({ id }) => id === "opencode-kv-guard")
      assert.deepEqual(plugin?.source, { type: "local", path: pluginDirectory }, JSON.stringify(plugin ?? plugins))
      assert.equal(plugin?.features.server, true, JSON.stringify(plugin))
      assert.equal(plugin?.state.status, "active", JSON.stringify(plugin))
      return info
    },
    async create(title: string, permissions?: readonly Rule[]) {
      return (await json("/api/session", id, { title, location: { directory }, model, permissions })).data.id
    },
    prompt: (session: string, text: string) =>
      json(`/api/session/${session}/prompt`, data(z.object({ type: z.literal("user") })), { text }),
    compact: (session: string) =>
      json(`/api/session/${session}/compact`, data(z.object({ type: z.literal("compaction") })), {}),
    async wait(session: string, outcome: Outcome) {
      const response = await within(`Waiting for session ${session} to become idle`, http(`/api/experimental/session/${session}/wait`, "POST"))
      assert.equal(response.status, 204)
      const stored = (await json(`/api/session/${session}/message?order=asc`, data(z.array(message)))).data
      const idle = stored.at(-1)
      assert.equal(idle?.type === "idle" && idle.outcome, outcome, `Session ${session}: ${JSON.stringify(idle)}`)
      return stored
    },
    async interrupt(session: string) {
      const { interrupted } = await json(`/api/session/${session}/interrupt?resume=false`, z.object({ interrupted: z.boolean() }), {})
      assert.equal(interrupted, true, "OpenCode must interrupt a running session")
    },
    async decline(session: string, request: string, message?: string) {
      const response = await http(`/api/session/${session}/permission/${request}/reply`, "POST", { decision: "reject", message })
      assert.equal(response.status, 204)
    },
    events: (types: readonly string[]) => within("Opening live event feed", http(`/api/event?${new URLSearchParams(types.map((type) => ["types", type]))}`)),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end()
      const force = setTimeout(() => child.kill("SIGKILL"), 3000)
      await child.exited.finally(() => clearTimeout(force))
      return (await Promise.allSettled([stdout, stderr])).map((log) => log.status === "fulfilled" ? log.value : String(log.reason)).join("\n")
    },
  }
}

export class FixtureError extends Error {
  override readonly name = "FixtureError"
  constructor(readonly operation: string, readonly output: string) {
    super(`${operation}\n${output}`)
  }
}

export function within<T>(operation: string, work: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => timeout.reject(new FixtureError(`${operation} timed out`, "")), 15_000)
  return Promise.race([work, timeout.promise]).finally(() => clearTimeout(timer))
}

export type Runtime = Awaited<ReturnType<typeof startServer>>

export async function runSmoke(
  name: string,
  reply: (call: Capture) => Response | Promise<Response>,
  scenario: (fixture: { readonly launch: (label: string) => Promise<Runtime> }) => Promise<Record<string, unknown>>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `kv-guard-${name}-`)))
  const servers: Runtime[] = []
  const failure = Promise.withResolvers<never>()
  const closing = new AbortController()
  const deadline = AbortSignal.timeout(120_000)
  const signal = AbortSignal.any([deadline, closing.signal])
  deadline.addEventListener("abort", () => failure.reject(new FixtureError(`${name} smoke timed out`, "")), { once: true })
  const proxy = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      try {
        const path = new URL(request.url).pathname
        if (request.method !== "POST" || path !== providerPath) throw new FixtureError("Unexpected provider route", `${request.method} ${path}`)
        return await reply({ url: request.url, headers: request.headers, body: wire.parse(await request.json()), signal: request.signal })
      } catch (cause) {
        failure.reject(cause)
        return new Response(null, { status: 400 })
      }
    },
  })
  let passed = false
  try {
    const result = await Promise.race([failure.promise, scenario({
      async launch(label) {
        const directory = join(root, label)
        await mkdir(join(directory, "tmp"), { recursive: true })
        const server = await startServer({
          directory,
          providerURL: `${proxy.url.origin}/tenant/v1`,
        }, signal, failure.reject)
        servers.push(server)
        return server
      },
    })])
    console.log(JSON.stringify({ version, ...result }, null, 2))
    passed = true
  } finally {
    closing.abort()
    proxy.stop(true)
    const logs = await Promise.all(servers.map((server) => server.stop()))
    if (!passed) for (const log of logs) console.error(log)
    await rm(root, { recursive: true, force: true })
  }
}
