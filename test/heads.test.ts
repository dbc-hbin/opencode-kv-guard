import { describe, expect, test } from "bun:test"
import { PrefixGuard, SessionHeads, isPrefixGuardSnapshot, isSessionHeadsSnapshot, type AssistantContext, type HeadContext } from "../src/heads"
import type { ChatBody } from "../src/compaction"
import type { WireMessage } from "../src/prefix"

const context: HeadContext = { session: "session", lane: "provider/endpoint/agent" }
const completed: AssistantContext = { ...context, outcome: "success", finishReason: "stop" }
const policy: WireMessage = { role: "system", content: "Authoritative policy" }
const delta: WireMessage = { role: "system", content: "Additional authoritative instruction" }
const user: WireMessage = { role: "user", content: "task" }
const next: WireMessage = { role: "user", content: "continue" }
const answer: WireMessage = { role: "assistant", content: "answer", reasoning_content: " exact\nplaintext reasoning  " }

function tool(name: string, properties: Record<string, unknown> = {}) {
  return { type: "function", function: { name, description: `${name} description`, parameters: { type: "object", properties } } }
}

function body(messages: WireMessage[] = [policy, user], extra: Record<string, unknown> = {}): ChatBody {
  return { model: "deployment", messages, tools: [tool("read")], ...extra }
}

function withoutReasoning(message: WireMessage = answer): WireMessage {
  const { reasoning_content: _reasoning, reasoning: _alias, ...rest } = message
  return rest
}

function recorded(assistant: WireMessage = answer) {
  const guard = new PrefixGuard()
  const request = body()
  const receipt = guard.apply(request, context).report.receipt
  expect(guard.record(request, assistant, { ...completed, receipt })).toBe(true)
  return { guard, request, receipt }
}

describe("persistent session heads", () => {
  test("canonicalizes exact tools once and retains all original conversation references", () => {
    const heads = new SessionHeads()
    const first = body([policy, user], { tools: [tool("write", { z: { type: "string" }, a: { type: "number" } }), tool("read")] })
    const original = JSON.stringify(first)
    const initialized = heads.apply(first, { ...context, currentUser: user })
    const reordered = body([policy, user, answer, next], { tools: [tool("read"), tool("write", { a: { type: "number" }, z: { type: "string" } })] })
    const stable = heads.apply(reordered, { ...context, currentUser: next })
    expect(initialized.report.status).toBe("initialized")
    expect(stable.report).toMatchObject({ status: "stable", notices: 0 })
    expect(JSON.stringify(stable.body.tools)).toBe(JSON.stringify(initialized.body.tools))
    expect(stable.body.messages.slice(0, 2)).toEqual(initialized.body.messages)
    expect(stable.body.messages[1]).toBe(user)
    expect(stable.body.messages.at(-1)).toBe(next)
    expect(JSON.stringify(first)).toBe(original)
  })

  test("appends authoritative instructions at original chain anchors without changing the leading head", () => {
    const heads = new SessionHeads()
    const first = heads.apply(body(), context)
    const second = heads.apply(body([policy, delta, user, answer, next]), { ...context, currentUser: next })
    expect(second.report).toMatchObject({ status: "appended", notices: 1 })
    expect(second.body.messages[0]).toEqual(first.body.messages[0])
    expect(second.body.messages.at(-2)).toBe(next)
    expect(second.body.messages.at(-1)).toEqual(delta)
    expect(second.body.messages.at(-1)?.role).toBe("system")
    const thirdUser = { role: "user", content: "third" }
    const third = heads.apply(body([policy, delta, user, answer, next, { role: "assistant", content: "second answer" }, thirdUser]), context)
    expect(third.report.status).toBe("stable")
    expect(third.body.messages.slice(0, second.body.messages.length)).toEqual(second.body.messages)
    expect(third.body.messages.at(-1)).toBe(thirdUser)
  })

  test("retains developer authority and ordering instead of demoting policy to a user notice", () => {
    const heads = new SessionHeads()
    const developer = { role: "developer", content: "Developer policy" }
    heads.apply(body([policy, developer, user]), context)
    const addition = { role: "developer", content: "Additional developer policy" }
    const result = heads.apply(body([policy, developer, addition, user, answer, next]), context)
    expect(result.report.status).toBe("appended")
    expect(result.body.messages.filter((message) => message.role === "developer")).toEqual([developer, addition])
    expect(result.body.messages.filter((message) => message.role === "user")).toEqual([user, next])
  })

  test("changed or removed authoritative system text explicitly resets to current instructions", () => {
    for (const system of [[], [{ role: "system", content: "Replacement policy" }], [{ ...policy, content: `${policy.content}\nadditional text` }]]) {
      const heads = new SessionHeads()
      heads.apply(body(), context)
      const result = heads.apply(body([...system, user, answer, next]), context)
      expect(result.report).toMatchObject({ status: "reset", reason: "system-contract-changed", notices: 0 })
      expect(result.body.messages).toEqual([...system, user, answer, next])
    }
  })

  test("unanchored system additions reset rather than inventing a conversation anchor", () => {
    const heads = new SessionHeads()
    heads.apply(body([policy]), context)
    const result = heads.apply(body([policy, delta]), context)
    expect(result.report).toMatchObject({ status: "reset", reason: "unanchored-system-addition" })
    expect(result.body.messages).toEqual([policy, delta])
  })

  test("an original later instruction keeps precedence over new leading instructions", () => {
    const heads = new SessionHeads()
    const later = { role: "system", content: "Later authoritative policy" }
    heads.apply(body([policy, user, later, answer, next]), context)
    const input = body([policy, delta, user, later, answer, next])
    const result = heads.apply(input, context)
    expect(result.report).toMatchObject({ status: "reset", reason: "system-contract-changed" })
    expect(result.body.messages).toEqual(input.messages)
  })

  test("tool additions, removals, replacements and schema edits never retain unavailable contracts", () => {
    const cases = [
      { tools: [tool("read"), tool("write")], reason: "tools-added" },
      { tools: [], reason: "tools-removed" },
      { tools: [tool("write")], reason: "tools-replaced" },
      { tools: [tool("read", { path: { type: "string" } })], reason: "tools-schema-changed" },
      { tools: [{ ...tool("read"), function: { ...tool("read").function, description: "new description" } }], reason: "tools-schema-changed" },
    ]
    for (const entry of cases) {
      const heads = new SessionHeads()
      heads.apply(body(), context)
      const result = heads.apply(body([policy, user, answer, next], { tools: entry.tools }), context)
      expect(result.report).toMatchObject({ status: "reset", reason: entry.reason })
      expect(result.body.tools).toEqual(entry.tools)
    }
    const heads = new SessionHeads()
    heads.apply(body(), context)
    const absent = body()
    delete absent.tools
    expect(heads.apply(absent, context).report.reason).toBe("tools-availability-changed")
  })

  test("unsupported and duplicate tool identities pass through and discard frozen state", () => {
    for (const tools of [{ opaque: true }, [tool("read"), tool("read")], [{ type: "custom", name: "opaque" }]]) {
      const heads = new SessionHeads()
      heads.apply(body(), context)
      const input = body([policy, user], { tools })
      const result = heads.apply(input, context)
      expect(result.body).toBe(input)
      expect(result.report).toMatchObject({ status: "unsupported", reason: "unsupported-tools" })
      expect(heads.snapshot(context.session).lanes).toEqual([])
    }
  })

  test("edited and reverted history drops old notice anchors permanently", () => {
    const heads = new SessionHeads()
    heads.apply(body(), context)
    heads.apply(body([policy, delta, user, answer, next]), context)
    const reverted = heads.apply(body([policy, user]), context)
    expect(reverted.report).toMatchObject({ status: "reset", reason: "history-reverted", notices: 0 })
    const restored = heads.apply(body([policy, user, answer, next]), context)
    expect(restored.report.status).toBe("stable")
    expect(restored.body.messages).toEqual([policy, user, answer, next])
    const edited = heads.apply(body([policy, { ...user, content: "edited" }, answer, next]), context)
    expect(edited.report).toMatchObject({ status: "reset", reason: "history-edited", notices: 0 })
    expect(edited.body.messages.some((message) => message.content === delta.content)).toBe(false)
  })

  test("an edit to an earlier chain node invalidates a later otherwise-identical user anchor", () => {
    const heads = new SessionHeads()
    heads.apply(body(), context)
    heads.apply(body([policy, delta, user, answer, next]), context)
    const result = heads.apply(body([policy, { ...user, content: "edited first turn" }, answer, next]), context)
    expect(result.report.reason).toBe("history-edited")
    expect(result.body.messages).toEqual([policy, { ...user, content: "edited first turn" }, answer, next])
  })

  test("snapshot restore preserves notices and rejects foreign, malformed and noncanonical snapshots atomically", () => {
    const heads = new SessionHeads()
    heads.apply(body(), context)
    heads.apply(body([policy, delta, user, answer, next]), context)
    const snapshot = JSON.parse(JSON.stringify(heads.snapshot(context.session)))
    const restored = new SessionHeads()
    expect(isSessionHeadsSnapshot(snapshot, context.session)).toBe(true)
    expect(restored.restore(context.session, snapshot)).toBe(true)
    expect(restored.apply(body([policy, delta, user, answer, next]), context).body).toEqual(heads.apply(body([policy, delta, user, answer, next]), context).body)
    const before = restored.snapshot(context.session)
    const invalid = [
      { ...snapshot, version: 2 }, { ...snapshot, session: "other" }, { ...snapshot, extra: true },
      { ...snapshot, lanes: [...snapshot.lanes, ...snapshot.lanes] },
      { ...snapshot, lanes: [{ ...snapshot.lanes[0], chain: ["invalid"] }] },
      { ...snapshot, lanes: [{ ...snapshot.lanes[0], notices: [{ anchor: "0".repeat(64), system: [delta] }] }] },
      { ...snapshot, lanes: [{ ...snapshot.lanes[0], notices: [{ ...snapshot.lanes[0].notices[0], system: [{ role: "user", content: "demoted" }] }] }] },
      { ...snapshot, lanes: [{ ...snapshot.lanes[0], tools: [tool("write"), tool("read")] }] },
    ]
    for (const value of invalid) {
      expect(restored.restore(context.session, value)).toBe(false)
      expect(restored.snapshot(context.session)).toEqual(before)
    }
    snapshot.lanes[0].system[0].content = "mutated snapshot"
    expect(restored.snapshot(context.session)).toEqual(before)
  })

  test("session deletion, clear, lane separation and foreign restore do not leak heads", () => {
    const heads = new SessionHeads()
    heads.apply(body(), context)
    heads.apply(body([delta, user]), { session: "other", lane: context.lane })
    heads.apply(body([delta, user]), { ...context, lane: "other-lane" })
    expect(heads.restore("other", heads.snapshot(context.session))).toBe(false)
    heads.delete(context.session)
    expect(heads.snapshot(context.session).lanes).toEqual([])
    expect(heads.snapshot("other").lanes).toHaveLength(1)
    heads.clear()
    expect(heads.snapshot("other").lanes).toEqual([])
  })

  test("compatible children share only equal current tool and system contracts", () => {
    const heads = new SessionHeads()
    const parent = heads.apply(body(), context)
    const child = { session: "child", lane: "child-lane", parentSession: context.session, parentLane: context.lane }
    const shared = heads.apply(body([policy, { role: "user", content: "child task" }]), child)
    expect(shared.report.parent).toBe("shared")
    expect(shared.body.messages[0]).toEqual(parent.body.messages[0])
    for (const [session, input] of [
      ["different-tools", body([policy, user], { tools: [] })],
      ["different-policy", body([{ role: "system", content: "child policy" }, user])],
      ["missing-policy", body([user])],
    ] as const) {
      const result = heads.apply(input, { ...child, session })
      expect(result.report.parent).toBe("incompatible")
      expect(result.body.messages).toEqual(input.messages)
    }
    heads.apply(body([policy, delta, user, answer, next]), context)
    const additive = heads.apply(body([policy, delta, { role: "user", content: "new child task" }]), { ...child, session: "additive-child" })
    expect(additive.report.parent).toBe("shared")
    expect(additive.body.messages[0]).toEqual(parent.body.messages[0])
    expect(additive.body.messages.at(-1)).toEqual(delta)
    expect(additive.body.messages.some((message) => message === next || message === answer)).toBe(false)
  })
})

describe("recorded-response prefix guard", () => {
  test("restores omitted plaintext only for the exact successful response and complete producing prefix", () => {
    const { guard } = recorded()
    const historical = withoutReasoning()
    const input = body([policy, user, historical, next])
    const original = JSON.stringify(input)
    const result = guard.apply(input, { ...context, currentUser: next })
    expect(result.report.replayed).toEqual([{ index: 2, fields: ["reasoning_content"] }])
    expect(result.body.messages[2]).toEqual(answer)
    expect(result.body.messages[1]).toBe(user)
    expect(result.body.messages[3]).toBe(next)
    expect(input.messages[2]).toBe(historical)
    expect(JSON.stringify(input)).toBe(original)
  })

  test("tool identities, arguments, content, existing reasoning and unrelated fields must match exactly", () => {
    const assistant = { ...answer, content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] }
    const { guard } = recorded(assistant)
    const result = guard.apply(body([policy, user, withoutReasoning(assistant), { role: "tool", tool_call_id: "call-1", content: "data" }, next]), context)
    expect(result.body.messages[2]).toEqual(assistant)
    for (const changed of [
      { ...withoutReasoning(assistant), content: "edited" },
      { ...withoutReasoning(assistant), tool_calls: [{ ...assistant.tool_calls[0], id: "different" }] },
      { ...withoutReasoning(assistant), tool_calls: [{ ...assistant.tool_calls[0], function: { name: "read", arguments: "{\"path\":\"b\"}" } }] },
      { ...withoutReasoning(assistant), reasoning_content: "" },
      { ...withoutReasoning(assistant), reasoning_content: null },
      { ...withoutReasoning(assistant), reasoning_content: "changed" },
      { ...withoutReasoning(assistant), name: "changed" },
    ]) {
      const local = recorded(assistant).guard
      const input = body([policy, user, changed, next])
      expect(local.apply(input, context).body).toBe(input)
    }
  })

  test("never binds reasoning using only the most recent user or assistant content", () => {
    for (const input of [
      body([{ ...policy, content: "changed system" }, user, withoutReasoning(), next]),
      body([policy, { ...user, content: "edited first user" }, withoutReasoning(), next]),
      body([policy, user, withoutReasoning(), next], { model: "other-model" }),
      body([policy, user, withoutReasoning(), next], { tools: [tool("read", { extra: { type: "string" } })] }),
      body([policy, user, withoutReasoning(), next], { temperature: 0.5 }),
      body([policy, { role: "assistant", content: "inserted" }, user, withoutReasoning(), next]),
    ]) {
      const { guard } = recorded()
      expect(guard.apply(input, context).report.replayed).toEqual([])
    }
  })

  test("failed, aborted, partial, opaque, signed and unidentifiable outputs are never admitted", () => {
    const request = body()
    for (const fields of [
      { outcome: "failed", finishReason: "stop" }, { outcome: "aborted", finishReason: "stop" },
      { outcome: "success", finishReason: "length" }, { outcome: "success", finishReason: "content_filter" },
      { outcome: "success", finishReason: "tool_calls" },
    ] as const) {
      const guard = new PrefixGuard()
      const receipt = guard.apply(request, context).report.receipt
      expect(guard.record(request, answer, { ...completed, ...fields, receipt })).toBe(false)
      expect(guard.apply(body([policy, user, withoutReasoning(), next]), context).report.replayed).toEqual([])
    }
    for (const assistant of [
      { ...answer, thinking_blocks: [{ signature: "opaque", text: "signed" }] },
      { ...answer, content: [{ type: "text", text: "answer" }] },
      { ...answer, reasoning: { signature: "opaque" } },
      { role: "assistant", content: null, reasoning_content: "no output identity" },
      { role: "assistant", content: "answer" },
    ]) {
      const guard = new PrefixGuard()
      const receipt = guard.apply(request, context).report.receipt
      expect(guard.record(request, assistant, { ...completed, receipt })).toBe(false)
    }
  })

  test("both plaintext aliases can be recovered but a changed alias prevents all replay", () => {
    const assistant = { ...answer, reasoning: "alias text" }
    const { guard } = recorded(assistant)
    const result = guard.apply(body([policy, user, withoutReasoning(assistant), next]), context)
    expect(result.report.replayed).toEqual([{ index: 2, fields: ["reasoning_content", "reasoning"] }])
    expect(result.body.messages[2]).toEqual(assistant)
    const changed = recorded(assistant).guard.apply(body([policy, user, { ...withoutReasoning(assistant), reasoning: "changed" }, next]), context)
    expect(changed.report.replayed).toEqual([])
  })

  test("multiple missing turns recover sequentially using the complete repaired prefix", () => {
    const { guard } = recorded()
    const secondRequest = body([policy, user, answer, next])
    const receipt = guard.apply(secondRequest, context).report.receipt
    const secondAnswer = { role: "assistant", content: "second answer", reasoning: "second reasoning" }
    expect(guard.record(secondRequest, secondAnswer, { ...completed, receipt })).toBe(true)
    const result = guard.apply(body([policy, user, withoutReasoning(), next, withoutReasoning(secondAnswer), { role: "user", content: "third" }]), context)
    expect(result.body.messages[2]).toEqual(answer)
    expect(result.body.messages[4]).toEqual(secondAnswer)
    expect(result.report.replayed).toEqual([{ index: 2, fields: ["reasoning_content"] }, { index: 4, fields: ["reasoning"] }])
  })

  test("ambiguous successful responses with the same content and prefix do not select reasoning", () => {
    const { guard, request, receipt } = recorded()
    expect(guard.record(request, { ...answer, reasoning_content: "different successful reasoning" }, { ...completed, receipt })).toBe(true)
    expect(guard.apply(body([policy, user, withoutReasoning(), next]), context).report.replayed).toEqual([])
  })

  test("genuine reverts and edits revoke records and late completions cannot resurrect them", () => {
    for (const changed of [body([policy, user]), body([policy, user, { ...answer, content: "edited answer" }, next])]) {
      const { guard, request, receipt } = recorded()
      guard.apply(body([policy, user, answer, next]), context)
      guard.apply(changed, context)
      expect(guard.record(request, answer, { ...completed, receipt })).toBe(false)
      expect(guard.apply(body([policy, user, withoutReasoning(), next]), context).report.replayed).toEqual([])
    }
  })

  test("retains full structural hashes and reports each divergent field without recording request plaintext", () => {
    const guard = new PrefixGuard()
    const initial = body([policy, user, answer], { temperature: 0, stream: true })
    guard.apply(initial, context)
    const changed = body([{ ...policy, content: "changed" }, user, { ...answer, tool_calls: [], reasoning_content: "different" }], { model: "changed", tools: [], temperature: 1, max_tokens: 20 })
    const result = guard.apply(changed, context)
    expect(result.report.divergences).toEqual(expect.arrayContaining([
      { kind: "request-field-changed", field: "model", classification: "model" },
      { kind: "request-field-changed", field: "tools", classification: "tools" },
      { kind: "request-field-changed", field: "temperature", classification: "other" },
      { kind: "request-field-added", field: "max_tokens", classification: "other" },
      { kind: "request-field-removed", field: "stream", classification: "other" },
      { kind: "message-field-changed", index: 0, field: "content", classification: "system" },
      { kind: "message-field-changed", index: 2, field: "reasoning_content", classification: "reasoning" },
      { kind: "message-field-added", index: 2, field: "tool_calls", classification: "tool-calls" },
    ]))
    const snapshot = guard.snapshot(context.session)
    expect(Object.keys(snapshot.lanes[0]!.previous.fields).sort()).toEqual(Object.keys(changed).filter((field) => field !== "messages").sort())
    expect(snapshot.lanes[0]!.previous.messages).toHaveLength(changed.messages.length)
    expect(JSON.stringify(snapshot)).not.toContain("Authoritative policy")
    expect(JSON.stringify(result.report)).not.toContain("plaintext reasoning")
  })

  test("each recorded response stores constant-size request proof instead of copying the structural ledger", () => {
    const { guard, request } = recorded()
    const first = guard.snapshot(context.session).lanes[0]!.records[0]!.request
    const longer = body([...request.messages, answer, next, ...Array.from({ length: 100 }, (_, index) => ({ role: "user", content: `more ${index}` }))])
    const receipt = guard.apply(longer, context).report.receipt
    expect(guard.record(longer, { ...answer, content: "longer answer" }, { ...completed, receipt })).toBe(true)
    const records = guard.snapshot(context.session).lanes[0]!.records
    expect(records).toHaveLength(2)
    const last = records.at(-1)!.request
    expect(Object.keys(first).sort()).toEqual(["chain", "fields", "length"])
    expect(Object.keys(last).sort()).toEqual(["chain", "fields", "length"])
    expect(first.chain).toHaveLength(64)
    expect(last.chain).toHaveLength(64)
    expect(last.length).toBe(longer.messages.length)
    expect(last.fields).toBe(first.fields)
  })

  test("snapshot restoration is strict, atomic, deeply isolated and session-bound", () => {
    const { guard } = recorded()
    const snapshot = JSON.parse(JSON.stringify(guard.snapshot(context.session)))
    const restored = new PrefixGuard()
    expect(isPrefixGuardSnapshot(snapshot, context.session)).toBe(true)
    expect(restored.restore(context.session, snapshot)).toBe(true)
    const repeated = { ...answer, content: "another successful completion" }
    expect(restored.record(body(), repeated, { ...completed, receipt: snapshot.lanes[0].receipt })).toBe(true)
    const withCompletion = restored.snapshot(context.session)
    expect(restored.restore(context.session, snapshot)).toBe(true)
    const before = restored.snapshot(context.session)
    for (const invalid of [
      { ...snapshot, version: 2 }, { ...snapshot, session: "other" }, { ...snapshot, extra: true },
      { ...snapshot, lanes: [...snapshot.lanes, ...snapshot.lanes] },
      { ...snapshot, lanes: [{ ...snapshot.lanes[0], receipt: "invalid" }] },
      { ...snapshot, lanes: [{ ...snapshot.lanes[0], previous: { fields: { model: "invalid" }, messages: [] } }] },
      { ...snapshot, lanes: [{ ...snapshot.lanes[0], records: [{ ...snapshot.lanes[0].records[0], assistant: { ...answer, thinking_blocks: [] } }] }] },
      { ...snapshot, lanes: [{ ...snapshot.lanes[0], records: [...snapshot.lanes[0].records, ...snapshot.lanes[0].records] }] },
      { ...snapshot, lanes: [{ ...snapshot.lanes[0], records: [{ ...snapshot.lanes[0].records[0], request: { ...snapshot.lanes[0].records[0].request, chain: "0".repeat(64) } }] }] },
    ]) {
      expect(restored.restore(context.session, invalid)).toBe(false)
      expect(restored.snapshot(context.session)).toEqual(before)
    }
    expect(withCompletion.lanes[0]!.records).toHaveLength(2)
    snapshot.lanes[0].records[0].assistant.reasoning_content = "mutated"
    expect(restored.snapshot(context.session)).toEqual(before)
    expect(restored.apply(body([policy, user, withoutReasoning(), next]), context).body.messages[2]).toEqual(answer)
    expect(isPrefixGuardSnapshot(restored.snapshot(context.session), context.session)).toBe(true)
  })

  test("sessions and lanes isolate replay and deletion never affects another session", () => {
    const { guard } = recorded()
    for (const local of [{ ...context, session: "other" }, { ...context, lane: "other-agent" }]) {
      expect(guard.apply(body([policy, user, withoutReasoning(), next]), local).report.replayed).toEqual([])
    }
    expect(guard.restore("other", guard.snapshot(context.session))).toBe(false)
    guard.delete(context.session)
    expect(guard.snapshot(context.session).lanes).toEqual([])
    expect(guard.snapshot("other").lanes).toHaveLength(1)
    guard.clear()
    expect(guard.snapshot("other").lanes).toEqual([])
  })

  test("an intentional compaction boundary can be observed before recording the final dispatched body", () => {
    const { guard } = recorded()
    const repaired = guard.apply(body([policy, user, withoutReasoning(), next]), context)
    expect(repaired.report.replayed).toHaveLength(1)
    const compacted = body([policy, { role: "user", content: "summary" }, next])
    const receipt = guard.apply(compacted, context).report.receipt
    expect(guard.snapshot(context.session).lanes[0]!.records).toEqual([])
    const newAssistant = { role: "assistant", content: "new answer", reasoning_content: "new reasoning" }
    expect(guard.record(compacted, newAssistant, { ...completed, receipt })).toBe(true)
    const result = guard.apply(body([...compacted.messages, withoutReasoning(newAssistant), { role: "user", content: "again" }]), context)
    expect(result.body.messages[3]).toEqual(newAssistant)
    expect(result.report.replayed).toEqual([{ index: 3, fields: ["reasoning_content"] }])
  })

  test("observation-only apply preserves deliberate reasoning reduction and invalidates replay evidence", () => {
    const { guard, receipt: oldReceipt } = recorded()
    guard.apply(body([policy, user, answer, next]), context)
    const reduced = body([policy, user, withoutReasoning(), next])
    const result = guard.apply(reduced, { ...context, replay: false })
    expect(result.body).toBe(reduced)
    expect(result.report.replayed).toEqual([])
    expect(result.report.divergences).toContainEqual({ kind: "message-field-removed", index: 2, field: "reasoning_content", classification: "reasoning" })
    expect(guard.snapshot(context.session).lanes[0]!.records).toEqual([])
    expect(guard.record(body(), answer, { ...completed, receipt: oldReceipt })).toBe(false)
    expect(guard.apply(reduced, context).report.replayed).toEqual([])
  })
})
