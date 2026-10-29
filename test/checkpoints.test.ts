import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import plugin from "../src/index"
import { CheckpointConflictError, CheckpointStore, isCheckpointSnapshot, type CheckpointSnapshot } from "../src/checkpoints"
import { RollingCompaction, isCompactionSnapshot, type ChatBody, type CompactionContext, type CompactionResult } from "../src/compaction"
import { Environments, ModeReminders, isEnvironmentsSnapshot, isGeneratedEnvironment, isModeRemindersSnapshot, type WireMessage } from "../src/prefix"

type Messages = Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1]["messages"]
const roots: string[] = []
const providers = new Set(["proxy"])
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const empty = (): CheckpointSnapshot => ({ modes: { messages: [] }, environments: { lanes: [] }, compaction: { lanes: [] } })

test.each([
  { label: "unchanged configuration", before: {}, after: {} },
  {
    label: "reordered configuration",
    before: { glm: { models: ["fixture"], reasoningEffort: "max", clearThinking: false } },
    after: { glm: { clearThinking: false, reasoningEffort: "max", models: ["fixture"] } },
  },
  {
    label: "explicit effective defaults",
    before: { compaction: {}, shrinkToolOutputs: {} },
    after: {
      compaction: { marginTokens: 0, keepRecentTurns: 1, targetRatio: 0.8, triggerRatio: 0.85, bytesPerToken: 4 },
      shrinkToolOutputs: { maxLines: 400, maxBytes: 16384 },
    },
  },
])("completed replay survives restart with $label without reviving edited content", async ({ before, after }) => {
  const stateDirectory = await root()
  const captured: ChatBody[] = []
  const start = async (overrides: Record<string, unknown>) => {
    const hooks = await plugin({ directory: "/fixture", worktree: "/fixture" } as PluginInput, {
      providers: ["proxy"], stateDirectory, crossProcess: false, compaction: false, ...overrides,
    })
    const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: {
      baseURL: "http://replay.test/v1",
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured.push(JSON.parse(String(init?.body)) as ChatBody)
        return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "Answer", reasoning_content: "Recorded reasoning" }, finish_reason: "stop" }] })
      },
    } } } }
    await hooks.config!(config)
    return { hooks, fetch: config.provider.proxy.options.fetch }
  }
  const request = async (runtime: Awaited<ReturnType<typeof start>>, extra: WireMessage[] = []) => {
    const response = await runtime.fetch("http://replay.test/v1/chat/completions", {
      method: "POST", headers: { "x-opencode-session-id": "replay", "x-opencode-kv-guard-agent": "build" },
      body: JSON.stringify({ model: "fixture", messages: [{ role: "system", content: "Policy" }, { role: "user", content: "Task" }, ...extra] }),
    })
    await response.text()
  }
  const first = await start(before)
  await request(first)
  await first.hooks.dispose!()
  const restarted = await start(after)
  await request(restarted, [{ role: "assistant", content: "Answer" }, { role: "user", content: "Next" }])
  expect(captured[1]!.messages[2]!.reasoning_content).toBe("Recorded reasoning")
  await request(restarted, [{ role: "assistant", content: "Edited answer" }, { role: "user", content: "Next" }])
  expect(captured[2]!.messages[2]!.reasoning_content).toBeUndefined()
  await restarted.hooks.dispose!()
})

test("actual SDK query identities isolate replay across requests and checkpoint restarts", async () => {
  const stateDirectory = await root()
  const captured: { url: string; body: ChatBody }[] = []
  const start = async (tenant: string) => {
    const hooks = await plugin({ directory: "/query-fixture", worktree: "/query-fixture" } as PluginInput, {
      providers: ["proxy"], stateDirectory, crossProcess: false, compaction: false,
    })
    const queryParams = { tenant }
    const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: {
      name: "fixture", baseURL: "http://query-replay.test/v1", queryParams,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ url: String(input), body: JSON.parse(String(init?.body)) as ChatBody })
        return Response.json({ id: "fixture", model: "fixture", created: 1, choices: [{
          index: 0, message: { role: "assistant", content: "Answer", reasoning_content: `Reasoning ${queryParams.tenant}` }, finish_reason: "stop",
        }] })
      },
    } } } }
    await hooks.config!(config)
    return { hooks, queryParams, model: createOpenAICompatible({
      ...config.provider.proxy.options, fetch: Object.assign(config.provider.proxy.options.fetch, { preconnect: globalThis.fetch.preconnect }),
    }).chatModel("fixture") }
  }
  const prompt = [
    { role: "system" as const, content: "Policy" },
    { role: "user" as const, content: [{ type: "text" as const, text: "Task" }] },
  ]
  const continued = [...prompt,
    { role: "assistant" as const, content: [{ type: "text" as const, text: "Answer" }] },
    { role: "user" as const, content: [{ type: "text" as const, text: "Next" }] },
  ]
  const headers = { "x-opencode-session-id": "query-session", "x-opencode-kv-guard-agent": "build" }
  const first = await start("a")
  await first.model.doGenerate({ prompt, headers })
  first.queryParams.tenant = "b"
  await first.model.doGenerate({ prompt: continued, headers })
  expect(captured[1]!.url).toEndWith("?tenant=b")
  expect(captured[1]!.body.messages[2]!.reasoning_content).toBeUndefined()
  await first.hooks.dispose!()
  const restarted = await start("c")
  await restarted.model.doGenerate({ prompt: continued, headers })
  expect(captured[2]!.body.messages[2]!.reasoning_content).toBeUndefined()
  restarted.queryParams.tenant = "a"
  await restarted.model.doGenerate({ prompt: continued, headers })
  expect(captured[3]!.body.messages[2]!.reasoning_content).toBe("Reasoning a")
  await restarted.hooks.dispose!()
})

test.each(["policy", "environment"])("reasoning reconstruction preserves anchored %s notices across restart", async (kind) => {
  const stateDirectory = await root()
  const captured: ChatBody[] = []
  const start = async () => {
    const hooks = await plugin({ directory: "/anchor-fixture", worktree: "/anchor-fixture" } as PluginInput, {
      providers: ["proxy"], stateDirectory, crossProcess: false, compaction: false,
    })
    const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: {
      baseURL: "http://anchor-replay.test/v1",
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured.push(JSON.parse(String(init?.body)) as ChatBody)
        return Response.json({ choices: [{ index: 0, message: {
          role: "assistant", content: captured.length === 1 ? "Answer" : "Second",
          reasoning_content: captured.length === 1 ? "Recorded reasoning" : "Second reasoning",
        }, finish_reason: "stop" }] })
      },
    } } } }
    await hooks.config!(config)
    return {
      hooks,
      async send(messages: WireMessage[]) {
        const response = await config.provider.proxy.options.fetch("http://anchor-replay.test/v1/chat/completions", {
          method: "POST", headers: { "x-opencode-session-id": "anchors", "x-opencode-kv-guard-agent": "build" },
          body: JSON.stringify({ model: "fixture", messages }),
        })
        await response.text()
      },
    }
  }
  const environment = (cwd: string) => ({
    role: "system", content: `Policy\nYou are powered by the model named fixture. The exact model ID is proxy/fixture\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: ${cwd}\n  Workspace root folder: /project\n  Is directory a git repo: yes\n  Platform: linux\n</env>`,
  })
  const policy = { role: "system", content: "Policy" }
  const initial = kind === "policy" ? [policy] : [environment("/project")]
  const updated = kind === "policy" ? [policy, { role: "developer", content: "Additional policy" }] : [environment("/new")]
  const task = { role: "user", content: "Task" }
  const answer = { role: "assistant", content: "Answer", reasoning_content: "Recorded reasoning" }
  const next = { role: "user", content: "Next" }
  const first = await start()
  await first.send([...initial, task])
  await first.send([...updated, task, answer, next])
  await first.hooks.dispose!()
  const restarted = await start()
  const continued = [...updated, task, { role: "assistant", content: "Answer" }, next,
    { role: "assistant", content: "Second", reasoning_content: "Second reasoning" }, { role: "user", content: "Third" }]
  await restarted.send(continued)
  expect(captured[2]!.messages.slice(0, captured[1]!.messages.length)).toEqual(captured[1]!.messages)
  const again = continued.map((message) => message.role === "assistant" ? { role: message.role, content: message.content } : message)
  again.push({ role: "assistant", content: "Second" }, { role: "user", content: "Fourth" })
  await restarted.send(again)
  expect(captured[3]!.messages.slice(0, captured[2]!.messages.length)).toEqual(captured[2]!.messages)
  const edited = structuredClone(again)
  edited[updated.length + 1]!.content = "Edited answer"
  await restarted.send(edited)
  expect(captured[4]!.messages.find((message) => message.content === "Edited answer")?.reasoning_content).toBeUndefined()
  expect(captured[4]!.messages.some((message) => kind === "policy"
    ? message.role === "developer" && message.content === "Additional policy"
    : String(message.content).includes("Working directory: /new"))).toBe(true)
  await restarted.hooks.dispose!()
})

test.each(["summary", "reasoning", "replay-pressure", "restored-pressure"])("reasoning replay survives reconstruction of a frozen %s checkpoint", async (stage) => {
  const captured: ChatBody[] = []
  let summaries = 0
  const hooks = await plugin({} as PluginInput, {
    providers: ["proxy"], persistence: false, crossProcess: false, compaction: { bytesPerToken: 1 }, prefixHandoff: false,
  })
  const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: {
    baseURL: "http://compacted-replay.test/v1",
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ChatBody
      if (body.stream === false) { summaries++; return success() }
      captured.push(body)
      return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "Answer", reasoning_content: stage === "restored-pressure" && captured.length === 1 ? "r".repeat(4000) : "Recent reasoning" }, finish_reason: "stop" }] })
    },
  } } } }
  await hooks.config!(config)
  const send = async (messages: WireMessage[], id: string) => {
    const current = user(id, String(messages.at(-1)!.content))
    const transformed = { messages: [current] }
    await hooks["experimental.chat.messages.transform"]!({}, transformed)
    const text = transformed.messages[0]!.parts[0]!
    if (text.type !== "text") throw new Error("Expected user text")
    const outgoing = [...messages.slice(0, -1), { role: "user", content: text.text }]
    const response = await config.provider.proxy.options.fetch("http://compacted-replay.test/v1/chat/completions", {
      method: "POST", headers: {
        "x-opencode-session-id": "session", "x-opencode-kv-guard-agent": "build",
        "x-opencode-kv-guard-user": id, "x-opencode-kv-guard-limits": JSON.stringify({ context: 5000, output: 500 }),
      },
      body: JSON.stringify({ model: "fixture", messages: outgoing, max_tokens: 500, stream: true }),
    })
    await response.text()
  }
  const original = stage === "summary" ? history().messages : stage === "replay-pressure" ? [...history().messages.slice(0, 5), { role: "user", content: "Current" }] : [
    { role: "system", content: "Policy" }, { role: "user", content: "Earlier" },
    { role: "assistant", content: "Earlier answer", reasoning_content: "r".repeat(6000) },
    { role: "user", content: "Current" },
  ]
  await send(original, "one")
  if (stage === "reasoning" || stage === "restored-pressure") expect(captured[0]!.messages[2]!.reasoning_content).toBeUndefined()
  if (stage === "summary") expect(summaries).toBeGreaterThan(0)
  const count = summaries
  const second = [...original, { role: "assistant", content: "Answer" }, { role: "user", content: stage === "replay-pressure" ? "n".repeat(1800) : "Next" }]
  await send(second, "two")
  if (stage === "replay-pressure") expect(summaries).toBeGreaterThan(count)
  else expect(summaries).toBe(count)
  if (stage === "summary" || stage === "reasoning") expect(captured[1]!.messages.findLast((message) => message.role === "assistant")?.reasoning_content).toBe("Recent reasoning")
  if (stage === "reasoning") expect(captured[1]!.messages[2]!.reasoning_content).toBeUndefined()
  if (stage.endsWith("pressure")) {
    const before = summaries
    await send([...second, { role: "assistant", content: "Answer" }, { role: "user", content: "Third" }], "three")
    expect(summaries).toBe(before)
    expect(captured[2]!.messages.findLast((message) => message.role === "assistant")?.reasoning_content).toBe("Recent reasoning")
  }
  await hooks.dispose!()
})

test.each(["policy", "environment"])("anchored %s survives compaction retiring the reasoning proof", async (kind) => {
  const stateDirectory = await root()
  const captured: ChatBody[] = []
  const start = async () => {
    const hooks = await plugin({ directory: "/retired-proof", worktree: "/retired-proof" } as PluginInput, {
      providers: ["proxy"], stateDirectory, crossProcess: false, compaction: { bytesPerToken: 1 },
    })
    const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: {
      baseURL: "http://retired-proof.test/v1",
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as ChatBody
        if (body.stream === false) throw new Error("Tiny source history needs no semantic summary")
        captured.push(body)
        return Response.json({ choices: [{ index: 0, message: {
          role: "assistant", content: captured.length === 1 ? "Answer" : "Second",
          reasoning_content: captured.length === 1 ? "r".repeat(6000) : "Second reasoning",
        }, finish_reason: "stop" }] })
      },
    } } } }
    await hooks.config!(config)
    return {
      hooks,
      async send(messages: WireMessage[], id: string) {
        const transformed = { messages: [user(id, String(messages.at(-1)!.content))] }
        await hooks["experimental.chat.messages.transform"]!({}, transformed)
        const part = transformed.messages[0]!.parts[0]!
        if (part.type !== "text") throw new Error("Expected user text")
        const response = await config.provider.proxy.options.fetch("http://retired-proof.test/v1/chat/completions", {
          method: "POST", headers: {
            "x-opencode-session-id": "session", "x-opencode-kv-guard-agent": "build",
            "x-opencode-kv-guard-user": id, "x-opencode-kv-guard-limits": JSON.stringify({ context: 5000, output: 500 }),
          },
          body: JSON.stringify({ model: "fixture", messages: [...messages.slice(0, -1), { role: "user", content: part.text }], max_tokens: 500, stream: true }),
        })
        await response.text()
      },
    }
  }
  const policy = { role: "system", content: "Policy" }
  const initial = kind === "policy" ? [policy] : environment().slice(0, 1)
  const updated = kind === "policy" ? [policy, { role: "developer", content: "Additional policy" }] : environment("/new").slice(0, 1)
  const task = { role: "user", content: "Task" }
  const next = { role: "user", content: "Next" }
  const first = await start()
  await first.send([...initial, task], "one")
  const second = [...updated, task, { role: "assistant", content: "Answer" }, next]
  await first.send(second, "two")
  expect(captured[1]!.messages.find((message) => message.content === "Answer")?.reasoning_content).toBeUndefined()
  await first.hooks.dispose!()
  const restarted = await start()
  await restarted.send([...second, { role: "assistant", content: "Second" }, { role: "user", content: "Third" }], "three")
  expect(captured[2]!.messages.slice(0, captured[1]!.messages.length)).toEqual(captured[1]!.messages)
  expect(captured[2]!.messages.findLast((message) => message.role === "assistant")?.reasoning_content).toBe("Second reasoning")
  await restarted.hooks.dispose!()
})

test("auxiliary providers cannot change the eligibility of an executing tool output", async () => {
  const data = await root()
  const previous = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = data
  let hooks: Hooks
  try { hooks = await plugin({} as PluginInput, { providers: ["proxy"], persistence: false, crossProcess: false, compaction: false }) }
  finally { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous }
  await hooks.config!({ provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://output-scope.test/v1" } } } })
  const header = async (agent: string, providerID: string) => {
    await hooks["chat.headers"]!({ sessionID: "session", agent, model: { providerID, limit: {} }, message: { id: "user" } } as Parameters<NonNullable<Hooks["chat.headers"]>>[0], { headers: {} })
  }
  for (const selected of [true, false]) {
    await header("build", selected ? "proxy" : "other")
    await header("title", selected ? "other" : "proxy")
    await hooks["tool.execute.before"]?.({ tool: "bash", sessionID: "session", callID: "call" }, { args: {} })
    const output = { title: "fixture", output: "\u001b[31mred\u001b[0m", metadata: {} }
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "session", callID: "call", args: {} }, output)
    expect(output.output).toBe(selected ? "red" : "\u001b[31mred\u001b[0m")
  }
  await hooks.dispose!()
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root() {
  const value = await mkdtemp(join(tmpdir(), "kv-guard-checkpoint-"))
  roots.push(value)
  return value
}

function path(directory: string, project = "project", scope = "scope", session = "session") {
  return join(directory, hash(project), hash(scope), `${hash(session)}.sqlite`)
}

function user(id: string, text: string, extra: Messages[number]["parts"] = [], session = "session"): Messages[number] {
  return {
    info: { id, sessionID: session, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "proxy", modelID: "fixture" } },
    parts: [{ type: "text", id: `text-${id}`, sessionID: session, messageID: id, text }, ...extra],
  }
}

function history(): ChatBody {
  const messages: WireMessage[] = [{ role: "system", content: "Fixture system constraints" }]
  for (let index = 0; index < 8; index++) {
    messages.push({ role: "user", content: `user-${index}:` + "u".repeat(450) }, { role: "assistant", content: `assistant-${index}:` + "a".repeat(450) })
  }
  messages.push({ role: "user", content: "Current instruction" })
  return { model: "fixture", messages, max_tokens: 500, stream: true }
}

function context(completeSummary: CompactionContext["completeSummary"], overrides: Partial<CompactionContext> = {}): CompactionContext {
  return { session: "session", lane: "fixture-lane", contextWindow: 5000, outputLimit: 500, completeSummary, ...overrides }
}

function forwarded(result: CompactionResult) {
  if ("response" in result) throw new Error(`Unexpected summary failure ${result.response.status}`)
  return result.body
}

function success() {
  return Response.json({ choices: [{ message: { role: "assistant", content: "fixture-semantic-summary" }, finish_reason: "stop" }] })
}

function environment(cwd = "/project", extra: WireMessage[] = []): WireMessage[] {
  return [
    { role: "system", content: `Stable policy.\nYou are powered by the model named fixture. The exact model ID is proxy/fixture\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: ${cwd}\n  Workspace root folder: /project\n  Is directory a git repo: yes\n  Platform: linux\n  Today's date: DAY\n</env>\nProject policy.` },
    { role: "user", content: "Task" }, ...extra,
  ]
}

describe("completed session snapshots", () => {
  test("a fresh instance restores the coherent bundle and reuses summary without a model call", async () => {
    const directory = await root()
    const modes = new ModeReminders()
    const environments = new Environments()
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const text = await Bun.file(new URL("./fixtures/build-switch.txt", import.meta.url)).text()
    const reminder = { type: "text" as const, synthetic: true, id: "reminder", sessionID: "session", messageID: "one", text }
    const initial = [user("one", "Task", [reminder])]
    modes.apply(initial, providers)
    const firstEnvironment = environment()
    environments.apply(firstEnvironment, "session", "lane")
    const original = history()
    let calls = 0
    const first = forwarded(await compaction.prepare(original, context(async () => { calls++; return success() })))
    expect(calls).toBeGreaterThan(0)
    const snapshot = { modes: modes.snapshot("session"), environments: environments.snapshot("session"), compaction: compaction.snapshot("session") }
    const store = new CheckpointStore(directory, "project", "scope")
    const revision = await store.save("session", snapshot, (await store.load("session")).revision)

    const loaded = await new CheckpointStore(directory, "project", "scope").load("session")
    expect(loaded.revision).toBe(revision)
    expect(loaded.snapshot).toEqual(snapshot)
    const nextModes = new ModeReminders()
    const nextEnvironments = new Environments()
    const nextCompaction = new RollingCompaction({ bytesPerToken: 1 })
    expect(nextModes.restore("session", loaded.snapshot!.modes)).toBe(true)
    expect(nextEnvironments.restore("session", loaded.snapshot!.environments)).toBe(true)
    expect(await nextCompaction.restore("session", loaded.snapshot!.compaction)).toBe(true)
    const nextMessages = [user("one", "Task"), user("two", "Next")]
    nextModes.apply(nextMessages, providers)
    expect(nextMessages[0]!.parts).toEqual(initial[0]!.parts)
    const nextEnvironment = environment("/new", [{ role: "assistant", content: "Answer" }, { role: "user", content: "Next" }])
    nextEnvironments.apply(nextEnvironment, "session", "lane")
    expect(nextEnvironment.slice(0, firstEnvironment.length)).toEqual(firstEnvironment)
    expect(isGeneratedEnvironment(nextEnvironment[2]!)).toBe(true)
    expect(isGeneratedEnvironment(nextEnvironment.at(-1)!)).toBe(true)
    let additionalCalls = 0
    const repeated = forwarded(await nextCompaction.prepare(structuredClone(original), context(async () => { additionalCalls++; return success() })))
    expect(repeated).toEqual(first)
    expect(additionalCalls).toBe(0)
  })

  test("edited history invalidates restored reminders, environments and summary", async () => {
    const modes = new ModeReminders()
    const text = await Bun.file(new URL("./fixtures/build-switch.txt", import.meta.url)).text()
    modes.apply([user("one", "Task", [{ type: "text", synthetic: true, id: "reminder", sessionID: "session", messageID: "one", text }])], providers)
    const restoredModes = new ModeReminders()
    restoredModes.restore("session", modes.snapshot("session"))
    const editedMessages = [user("one", "Edited task"), user("two", "Next")]
    restoredModes.apply(editedMessages, providers)
    expect(editedMessages[0]!.parts).toEqual(user("one", "Edited task").parts)
    const environments = new Environments()
    environments.apply(environment(), "session", "lane")
    const restoredEnvironments = new Environments()
    restoredEnvironments.restore("session", environments.snapshot("session"))
    const editedEnvironment = environment("/new", [{ role: "user", content: "Next" }])
    editedEnvironment[1]!.content = "Edited task"
    restoredEnvironments.apply(editedEnvironment, "session", "lane")
    expect(restoredEnvironments.snapshot("session").lanes[0]!.checkpoints).toHaveLength(1)
    expect(restoredEnvironments.snapshot("session").lanes[0]!.checkpoints[0]!.environment).toContain("Working directory: /new")
    const original = history()
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    await compaction.prepare(original, context(async () => success()))
    const restored = new RollingCompaction({ bytesPerToken: 1 })
    await restored.restore("session", compaction.snapshot("session"))
    const edited = structuredClone(original)
    edited.messages[1]!.content = "Edited archived instruction " + "e".repeat(450)
    let calls = 0
    await restored.prepare(edited, context(async () => { calls++; return success() }))
    expect(calls).toBeGreaterThan(0)
    const changedPolicy = { ...edited, messages: [{ role: "system", content: "Changed system policy" }, ...edited.messages.slice(1)] }
    calls = 0
    await restored.prepare(changedPolicy, context(async () => { calls++; return success() }))
    expect(calls).toBeGreaterThan(0)
  })

  test("restore replaces completed target state without clearing another session or a pending queue", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    let first = true
    const pending = compaction.prepare(history(), context(async () => {
      if (!first) return success()
      first = false
      entered.resolve()
      return response.promise
    }, { session: "other" }))
    await entered.promise
    expect(compaction.snapshot("other")).toEqual({ lanes: [] })
    expect(await compaction.restore("session", { lanes: [] })).toBe(true)
    response.resolve(success())
    await pending
    expect(compaction.snapshot("other").lanes).toHaveLength(1)
    await compaction.prepare(history(), context(async () => success()))
    expect(await compaction.restore("session", { lanes: [] })).toBe(true)
    expect(compaction.snapshot("session")).toEqual({ lanes: [] })
    expect(compaction.snapshot("other").lanes).toHaveLength(1)
    const environments = new Environments()
    environments.apply(environment("/other"), "other", "same-lane")
    environments.apply(environment(), "session", "same-lane")
    const other = environments.snapshot("other")
    environments.restore("session", { lanes: [] })
    expect(environments.snapshot("other")).toEqual(other)
    const fresh = environment()
    environments.apply(fresh, "session", "same-lane")
    expect(fresh.some((message) => typeof message.content === "string" && message.content.includes("Working directory: /other"))).toBe(false)
    const modes = new ModeReminders()
    const text = await Bun.file(new URL("./fixtures/build-switch.txt", import.meta.url)).text()
    modes.apply([user("other", "Other task", [{ type: "text", synthetic: true, id: "other-reminder", sessionID: "other", messageID: "other", text }], "other")], providers)
    const otherModes = modes.snapshot("other")
    modes.restore("session", { messages: [] })
    expect(modes.snapshot("other")).toEqual(otherModes)
  })

  test("restoring the active session waits for its lane without invalidating the request", async () => {
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    const entered = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    let first = true
    const pending = compaction.prepare(history(), context(async () => {
      if (!first) return success()
      first = false
      entered.resolve()
      return response.promise
    }))
    await entered.promise
    const restoring = compaction.restore("session", { lanes: [] })
    response.resolve(success())
    expect(forwarded(await pending).messages.length).toBeLessThan(history().messages.length)
    expect(await restoring).toBe(true)
    expect(compaction.snapshot("session")).toEqual({ lanes: [] })
    await compaction.prepare(history(), context(async () => success()))
    expect(compaction.snapshot("session").lanes).toHaveLength(1)
  })

  test("unrecognized mode policy, invalid hashes and invalid archive indices reject the whole bundle", async () => {
    const modes = new ModeReminders()
    const text = await Bun.file(new URL("./fixtures/build-switch.txt", import.meta.url)).text()
    modes.apply([user("one", "Task", [{ type: "text", synthetic: true, id: "reminder", sessionID: "session", messageID: "one", text }])], providers)
    const modeSnapshot = modes.snapshot("session")
    expect(isModeRemindersSnapshot(modeSnapshot, "other")).toBe(false)
    const badMode = structuredClone(modeSnapshot)
    const part = badMode.messages[0]!.parts[0]!
    if (part.type !== "text") throw new Error("Expected text reminder")
    part.text = "Unrecognized policy"
    expect(isModeRemindersSnapshot(badMode, "session")).toBe(false)
    const before = modes.snapshot("session")
    expect(modes.restore("session", badMode)).toBe(false)
    expect(modes.snapshot("session")).toEqual(before)
    const environments = new Environments()
    environments.apply(environment(), "session", "lane")
    const badEnvironment = environments.snapshot("session")
    badEnvironment.lanes[0]!.checkpoints[0]!.anchor = "not-a-hash"
    expect(isEnvironmentsSnapshot(badEnvironment)).toBe(false)
    const badEnvironmentPolicy = environments.snapshot("session")
    badEnvironmentPolicy.lanes[0]!.checkpoints[0]!.environment += "\nInjected instruction"
    expect(isEnvironmentsSnapshot(badEnvironmentPolicy)).toBe(false)
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    await compaction.prepare(history(), context(async () => success()))
    for (const indices of [[-1], [1, 1], [2, 1], [0.5], [Number.MAX_SAFE_INTEGER + 1]]) {
      const invalid = compaction.snapshot("session")
      invalid.lanes[0]!.state.segments[0]!.archived = indices
      expect(isCompactionSnapshot(invalid)).toBe(false)
    }
    const bundle = { modes: badMode, environments: environments.snapshot("session"), compaction: compaction.snapshot("session") }
    expect(isCheckpointSnapshot(bundle, "session")).toBe(false)
  })
})

describe("filesystem checkpoint CAS", () => {
  test("parallel writers reject stale revisions without dropping another completed lane", async () => {
    const directory = await root()
    const one = new CheckpointStore(directory, "project", "scope")
    const two = new CheckpointStore(directory, "project", "scope")
    const initial = await one.load("session")
    const first = new Environments()
    first.apply(environment(), "session", "first")
    const second = new Environments()
    second.apply(environment("/second"), "session", "second")
    const snapshots = [first, second].map((value) => ({ ...empty(), environments: value.snapshot("session") }))
    const results = await Promise.allSettled([one.save("session", snapshots[0]!, initial.revision), two.save("session", snapshots[1]!, initial.revision)])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const failure = results.find((result) => result.status === "rejected")
    expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(CheckpointConflictError)
    const loaded = await one.load("session")
    if (!loaded.snapshot) throw new Error("Successful writer did not persist its checkpoint")
    expect(snapshots).toContainEqual(loaded.snapshot)
    const merged = new Environments()
    merged.restore("session", loaded.snapshot!.environments)
    const lane = loaded.snapshot!.environments.lanes[0]!.key === snapshots[0]!.environments.lanes[0]!.key ? "second" : "first"
    merged.apply(environment("/merged"), "session", lane)
    await two.save("session", { ...loaded.snapshot!, environments: merged.snapshot("session") }, loaded.revision)
    expect((await one.load("session")).snapshot!.environments.lanes).toHaveLength(2)
    await expect(one.save("session", snapshots[0]!, loaded.revision)).rejects.toBeInstanceOf(CheckpointConflictError)
  })

  test("independent processes cannot publish competing bundles at the same revision", async () => {
    const directory = await root()
    const store = new CheckpointStore(directory, "project", "scope")
    const revision = await store.save("session", empty(), null)
    const module = new URL("../src/checkpoints.ts", import.meta.url).href
    const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, "--eval", `
      import { CheckpointStore } from ${JSON.stringify(module)};
      const store = new CheckpointStore(${JSON.stringify(directory)}, "project", "scope");
      try {
        await store.save("session", ${JSON.stringify(empty())}, ${JSON.stringify(revision)});
        console.log(JSON.stringify({ saved: true }));
      } catch (error) {
        console.log(JSON.stringify({ saved: false, message: String(error) }));
      }
    `], { stdout: "pipe", stderr: "pipe" }))
    const results = await Promise.all(children.map(async (child) => {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(exit).toBe(0)
      expect(stderr).toBe("")
      return JSON.parse(stdout) as { saved: boolean; message?: string }
    }))
    expect(results.filter((result) => result.saved)).toHaveLength(1)
    for (const result of results.filter((result) => !result.saved)) expect(result.message).toMatch(/conflict|locked|busy/i)
    expect((await store.load("session")).snapshot).toEqual(empty())
  })

  test("malformed or unsupported bundles are cache misses retaining a replacement CAS token", async () => {
    const directory = await root()
    const store = new CheckpointStore(directory, "project", "scope")
    await store.save("session", empty(), null)
    const db = new Database(path(directory))
    try { db.query("UPDATE checkpoint SET payload = ? WHERE id = 1").run('{"modes": {"messages": []}}') } finally { db.close() }
    const malformed = await store.load("session")
    expect(malformed).toMatchObject({ snapshot: null, reason: "malformed" })
    const broken = new Database(path(directory))
    try { broken.query("UPDATE checkpoint SET payload = ? WHERE id = 1").run("{") } finally { broken.close() }
    expect(await store.load("session")).toMatchObject({ revision: malformed.revision, snapshot: null, reason: "malformed" })
    await store.save("session", empty(), malformed.revision)
    const newer = new Database(path(directory))
    try { newer.exec("UPDATE checkpoint SET version = 999 WHERE id = 1") } finally { newer.close() }
    const unsupported = await store.load("session")
    expect(unsupported).toMatchObject({ snapshot: null, reason: "version" })
    await store.save("session", empty(), unsupported.revision)
    expect((await store.load("session")).snapshot).toEqual(empty())
    await expect(store.save("session", { ...empty(), environments: { lanes: [{ key: "invalid", chain: [], checkpoints: [] }] } }, (await store.load("session")).revision)).rejects.toThrow("invalid checkpoint")
  })

  test("project, policy, session and credentials stay isolated behind private hashed paths", async () => {
    const directory = await root()
    const project = "project-with-secret-credential"
    const scope = "policy-with-secret-credential"
    const session = "session-with-secret-credential"
    const store = new CheckpointStore(directory, project, scope)
    const environments = new Environments()
    environments.apply(environment(), session, "Authorization: Bearer transport-secret")
    const compaction = new RollingCompaction({ bytesPerToken: 1 })
    await compaction.prepare(history(), context(async () => success(), { session, lane: "Authorization: Bearer transport-secret" }))
    const snapshot = { ...empty(), environments: environments.snapshot(session), compaction: compaction.snapshot(session) }
    expect(JSON.stringify(snapshot)).not.toContain("transport-secret")
    await store.save(session, snapshot, null)
    const file = path(directory, project, scope, session)
    for (const target of [directory, join(directory, hash(project)), join(directory, hash(project), hash(scope))]) expect((await stat(target)).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const names = await readdir(directory, { recursive: true })
    expect(names.every((name) => !name.includes("secret-credential"))).toBe(true)
    expect(Buffer.from(await Bun.file(file).arrayBuffer()).includes(Buffer.from("secret-credential"))).toBe(false)
    expect(Buffer.from(await Bun.file(file).arrayBuffer()).includes(Buffer.from("transport-secret"))).toBe(false)
    expect((await new CheckpointStore(directory, "other-project", scope).load(session)).snapshot).toBeNull()
    expect((await new CheckpointStore(directory, project, "other-policy").load(session)).snapshot).toBeNull()
    expect((await store.load("other-session")).snapshot).toBeNull()
    const rootLink = join(directory, "symlink-root")
    await symlink(join(directory, hash(project)), rootLink)
    await expect(new CheckpointStore(rootLink, project, scope).load(session)).rejects.toThrow("must not be a symlink")
  })

  test("deletion tombstones prevent loaded and initially missing work from resurrecting state", async () => {
    const directory = await root()
    const store = new CheckpointStore(directory, "project", "scope")
    const missing = await store.load("never-saved")
    await store.delete("never-saved")
    await expect(store.save("never-saved", empty(), missing.revision)).rejects.toThrow("deleted session")
    await store.save("session", empty(), null)
    const loaded = await store.load("session")
    await store.delete("session")
    expect(await store.load("session")).toMatchObject({ snapshot: null, reason: "deleted" })
    await expect(store.save("session", empty(), loaded.revision)).rejects.toThrow("deleted session")
    await store.delete("session")
  })

  test("a killed writer rolls back its uncommitted bundle without leaving an ownerless lock", async () => {
    const directory = await root()
    const store = new CheckpointStore(directory, "project", "scope")
    const revision = await store.save("session", empty(), null)
    const child = Bun.spawn([process.execPath, "--eval", `
      import { Database } from "bun:sqlite";
      const db = new Database(${JSON.stringify(path(directory))});
      db.exec("BEGIN IMMEDIATE; UPDATE checkpoint SET payload = 'uncommitted' WHERE id = 1");
      process.stdout.write("READY\\n");
      await Bun.stdin.text();
    `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const reader = child.stdout.getReader()
    try {
      const decoder = new TextDecoder()
      let ready = ""
      while (!ready.includes("\n")) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("Writer exited before opening its transaction")
        ready += decoder.decode(chunk.value, { stream: true })
      }
      expect(ready).toBe("READY\n")
    } finally {
      reader.releaseLock()
      child.kill("SIGKILL")
      await child.exited
    }
    expect(await store.load("session")).toEqual({ revision, snapshot: empty() })
    await store.save("session", empty(), revision)
  })

  test("deletion waits for a competing writer and durably rejects stale state", async () => {
    const directory = await root()
    const store = new CheckpointStore(directory, "project", "scope")
    const revision = await store.save("session", empty(), null)
    const child = Bun.spawn([process.execPath, "--eval", `
      import { Database } from "bun:sqlite";
      const db = new Database(${JSON.stringify(path(directory))});
      db.exec("BEGIN IMMEDIATE; UPDATE checkpoint SET payload = payload WHERE id = 1");
      process.stdout.write("READY\\n");
      await Bun.stdin.text();
      db.exec("COMMIT");
      db.close();
    `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const stderr = new Response(child.stderr).text()
    const reader = child.stdout.getReader()
    try {
      let ready = ""
      const decoder = new TextDecoder()
      while (!ready.includes("\n")) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error("Writer exited before opening its transaction")
        ready += decoder.decode(chunk.value, { stream: true })
      }
      expect(ready).toBe("READY\n")
      const contended = Promise.withResolvers<void>()
      const deletion = store.delete("session", contended.resolve)
      await Promise.race([
        contended.promise,
        deletion.then(() => { throw new Error("Deletion completed while the competing writer still held its lock") }),
      ])
      child.stdin.end()
      await deletion
      expect(await store.load("session")).toMatchObject({ reason: "deleted", snapshot: null })
      await expect(store.save("session", empty(), revision)).rejects.toThrow("deleted session")
    } finally {
      reader.releaseLock()
      child.stdin.end()
      expect(await child.exited).toBe(0)
      expect(await stderr).toBe("")
    }
  })

  test("plugin disposal drains deletions accepted while an earlier tombstone is blocked", async () => {
    const directory = await root()
    const contentions = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let contentionCount = 0
    const hooks = await plugin({
      directory, worktree: directory, project: { id: "fixture" },
      client: { app: { log: async ({ body }: { body: { extra?: Record<string, unknown> } }) => {
        if (body.extra?.operation === "delete" && body.extra.state === "waiting") contentions[contentionCount++]?.resolve()
      } } },
    } as unknown as PluginInput, { providers: ["proxy"], crossProcess: false, compaction: false, diagnostics: true, stateDirectory: directory })
    const config = { provider: { proxy: { npm: "@ai-sdk/openai-compatible", options: {
      baseURL: "http://delete-ownership.test/v1",
      fetch: async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"),
    } } } }
    await hooks.config!(config)
    for (const session of ["session", "session-two"]) {
      const response = await config.provider.proxy.options.fetch("http://delete-ownership.test/v1/chat/completions", {
        method: "POST", headers: { "x-opencode-session-id": session, "x-opencode-kv-guard-agent": "build" },
        body: JSON.stringify({ model: "fixture", messages: environment() }),
      })
      await response.text()
    }
    const files = (await readdir(directory, { recursive: true })).filter((name) => name.endsWith(".sqlite"))
    expect(files).toHaveLength(2)
    const owners = []
    try {
      for (const session of ["session", "session-two"]) {
        const file = join(directory, files.find((name) => name.endsWith(`${hash(session)}.sqlite`))!)
        const child = Bun.spawn([process.execPath, "--eval", `
          import { Database } from "bun:sqlite";
          const db = new Database(${JSON.stringify(file)});
          db.exec("BEGIN IMMEDIATE; UPDATE checkpoint SET payload = payload WHERE id = 1");
          process.stdout.write("READY\\n");
          await Bun.stdin.text();
          db.exec("COMMIT");
          db.close();
        `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
        const stderr = new Response(child.stderr).text()
        const reader = child.stdout.getReader()
        owners.push({ child, stderr, reader, file })
        let ready = ""
        const decoder = new TextDecoder()
        while (!ready.includes("\n")) {
          const chunk = await reader.read()
          if (chunk.done) throw new Error("Writer exited before opening its transaction")
          ready += decoder.decode(chunk.value, { stream: true })
        }
        expect(ready).toBe("READY\n")
      }
      const remove = (id: string) => hooks.event!({ event: { type: "session.deleted", properties: { info: { id } } } } as Parameters<NonNullable<Hooks["event"]>>[0])
      const firstDeletion = remove("session")
      let disposed = false
      const disposing = hooks.dispose!()
      void disposing.then(() => { disposed = true })
      await Promise.race([
        contentions[0]!.promise,
        disposing.then(() => { throw new Error("Plugin disposal did not await its pending deletion") }),
      ])
      const secondDeletion = remove("session-two")
      await contentions[1]!.promise
      owners[0]!.child.stdin.end()
      await firstDeletion
      await owners[0]!.child.exited
      // Authoritative async readback of the first completed operation gives
      // disposal its completion turn while the second owner still holds a lock.
      const firstState = Database.deserialize(Buffer.from(await Bun.file(owners[0]!.file).arrayBuffer()))
      try { expect(firstState.query("SELECT payload, deleted FROM checkpoint WHERE id = 1").get()).toEqual({ payload: null, deleted: 1 }) }
      finally { firstState.close() }
      expect(disposed).toBe(false)
      owners[1]!.child.stdin.end()
      await Promise.all([secondDeletion, disposing])
      for (const { file } of owners) {
        const db = new Database(file, { readonly: true })
        try { expect(db.query("SELECT payload, deleted FROM checkpoint WHERE id = 1").get()).toEqual({ payload: null, deleted: 1 }) }
        finally { db.close() }
      }
    } finally {
      for (const { child, reader } of owners) { reader.releaseLock(); child.stdin.end() }
      for (const { child, stderr } of owners) {
        expect(await child.exited).toBe(0)
        expect(await stderr).toBe("")
      }
      await hooks.dispose!()
    }
  })
})
