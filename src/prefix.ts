import { randomUUID } from "node:crypto"
import type { Hooks } from "@opencode-ai/plugin"
import { digest, isSha256 as sha256, record } from "./shared"

type Messages = Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1]["messages"]
type Part = Messages[number]["parts"][number]
export type WireMessage = { role: string; content?: unknown; [key: string]: unknown }

const generatedEnvironments = new WeakSet<WireMessage>()
export function isGeneratedEnvironment(message: WireMessage) {
  return generatedEnvironments.has(message)
}


// The compatible wire format drops OpenCode message IDs and may add user-role
// media messages. Carry the real user provenance through conversion in an
// instance-private marker, then remove it before any inference or hashing.
export class UserTurns {
  private readonly prefix = `\u001ekv-guard-user:${randomUUID()}:`
  private readonly pattern = new RegExp(`${this.prefix}[a-f0-9]{64}\u001f`, "g")

  marker(session: string, message: string) {
    return this.prefix + digest(JSON.stringify([session, message])) + "\u001f"
  }

  clean(messages: Messages) {
    for (const message of messages) {
      if (message.info.role !== "user") continue
      message.parts = message.parts.filter((part) => {
        if (part.type !== "text" || !part.text.includes(this.prefix)) return true
        part.text = part.text.replace(this.pattern, "")
        return part.text !== ""
      })
    }
  }

  mark(messages: Messages, providers: Set<string>) {
    const current = messages.findLast((message) => message.info.role === "user")
    if (!current || current.info.role !== "user" || !providers.has(current.info.model.providerID)) return
    const marker = this.marker(current.info.sessionID, current.info.id)
    const part = current.parts.find((part) => part.type === "text" && !part.ignored && part.text !== "")
    if (part?.type === "text") part.text = marker + part.text
    else current.parts.push({
      type: "text", id: `prt_${digest(marker)}`, sessionID: current.info.sessionID,
      messageID: current.info.id, text: marker, synthetic: true,
    })
  }

  consume(messages: WireMessage[], expected?: string | null) {
    let current: WireMessage | undefined
    for (const message of messages) {
      if (typeof message.content === "string") {
        if (message.role === "user" && expected && message.content.startsWith(expected)) current = message
        message.content = message.content.replace(this.pattern, "")
      } else if (Array.isArray(message.content)) {
        let removedPart = false
        message.content = message.content.filter((part: unknown) => {
          if (!part || typeof part !== "object" || !("text" in part) || typeof part.text !== "string") return true
          if (message.role === "user" && expected && part.text.startsWith(expected)) current = message
          const owned = part.text.includes(this.prefix)
          part.text = part.text.replace(this.pattern, "")
          if (owned && part.text === "") { removedPart = true; return false }
          return true
        })
        // Restore the SDK's single-text representation if a marker-only part
        // was added to a user turn containing a core-generated text part.
        if (removedPart && Array.isArray(message.content) && message.content.length === 1) {
          const only = message.content[0]
          if (only?.type === "text" && typeof only.text === "string") {
            const { type: _type, text, ...metadata } = only
            Object.assign(message, metadata, { content: text })
          }
        }
      }
    }
    return current
  }
}

// SHA-256 of the unmodified v1.19.4 plan.txt and build-switch.txt. Only these
// core-generated, synthetic parts qualify; arbitrary plugin/user text does not.
const modeReminders: Record<string, true> = {
  "455db97e0d21e8097c2afb539d167b4b2483e99b585dbc4fff23cafd4a3029b8": true,
  "5e3db616a685a3dfaaf95fb86ae6e2acfbdf520bda60f7b27f727d2a88ba8a25": true,
}
const isModeReminder = (part: Part) => part.type === "text" && part.synthetic === true && !part.ignored && modeReminders[digest(part.text)] === true

export type ModeRemindersSnapshot = { messages: { id: string; base: string; parts: Part[] }[] }

export function isModeRemindersSnapshot(value: unknown, session: string): value is ModeRemindersSnapshot {
  if (!record(value) || Object.keys(value).some((key) => key !== "messages") || !Array.isArray(value.messages)) return false
  const ids = new Set<string>()
  const parts = new Set<string>()
  return value.messages.every((message) => {
    if (!record(message) || Object.keys(message).some((key) => !["id", "base", "parts"].includes(key)) || typeof message.id !== "string" || !message.id || ids.has(message.id) || !sha256(message.base) || !Array.isArray(message.parts) || !message.parts.length) return false
    ids.add(message.id)
    return message.parts.every((part) => {
      if (!record(part) || Object.keys(part).some((key) => !["type", "id", "sessionID", "messageID", "text", "synthetic"].includes(key)) || part.type !== "text" || typeof part.id !== "string" || !part.id || parts.has(part.id) || part.sessionID !== session || part.messageID !== message.id || part.synthetic !== true || typeof part.text !== "string" || modeReminders[digest(part.text)] !== true) return false
      parts.add(part.id)
      return true
    })
  })
}

export class ModeReminders {
  private sessions = new Map<string, Map<string, { base: string; parts: Part[] }>>()

  apply(messages: Messages, providers: Set<string>) {
    const last = messages.findLast((message) => message.info.role === "user")
    if (!last || last.info.role !== "user" || !providers.has(last.info.model.providerID)) return
    const session = last.info.sessionID
    const records = this.sessions.get(session) ?? new Map<string, { base: string; parts: Part[] }>()
    this.sessions.set(session, records)
    const present = new Set(messages.map((message) => message.info.id))
    for (const id of records.keys()) if (!present.has(id)) records.delete(id)

    for (const message of messages) {
      if (message.info.role !== "user") continue
      const parts = message.parts.filter(isModeReminder)
      const base = digest(JSON.stringify(message.parts.filter((part) => !isModeReminder(part))))
      if (message === last) {
        // The current mode is always authoritative. A plan/build switch on the
        // same user message replaces the record instead of reviving old policy.
        if (parts.length) records.set(message.info.id, { base, parts: structuredClone(parts) })
        else records.delete(message.info.id)
        continue
      }
      const prior = records.get(message.info.id)
      if (!prior) continue
      if (prior.base !== base) {
        records.delete(message.info.id) // Edited history must not inherit stale instructions.
        continue
      }
      if (!parts.length) message.parts.push(...structuredClone(prior.parts))
    }
  }

  snapshot(session: string): ModeRemindersSnapshot {
    return { messages: [...(this.sessions.get(session) ?? [])].map(([id, value]) => ({
      id, base: value.base,
      parts: value.parts.map((part) => {
        if (part.type !== "text") throw new Error("Mode reminder state contains a non-text part")
        return { type: "text" as const, id: part.id, sessionID: part.sessionID, messageID: part.messageID, text: part.text, synthetic: true }
      }),
    })) }
  }

  restore(session: string, value: unknown) {
    if (!isModeRemindersSnapshot(value, session)) return false
    this.sessions.set(session, new Map(value.messages.map(({ id, base, parts }) => [id, { base, parts: structuredClone(parts) }])))
    return true
  }

  delete(sessionID: string) { this.sessions.delete(sessionID) }
  clear() { this.sessions.clear() }
}

// Match only OpenCode 1.19.4's generated environment, immediately following
// its model identity line. Other env blocks and user-authored dates stay intact.
const environment = /(You are powered by the model named [^\n]+\. The exact model ID is [^\n]+\n)(Here is some useful information about the environment you are running in:\n<env>\n  Working directory: [^\n]+\n  Workspace root folder: [^\n]+\n  Is directory a git repo: (?:yes|no)\n  Platform: [^\n]+(?:\n  Today's date: [^\n]+)?\n<\/env>)/
type Checkpoint = { anchor: string; position: number; environment: string }
export type EnvironmentsSnapshot = { lanes: { key: string; chain: string[]; checkpoints: Checkpoint[] }[] }
const environmentBlock = /^Here is some useful information about the environment you are running in:\n<env>\n  Working directory: [^\n]+\n  Workspace root folder: [^\n]+\n  Is directory a git repo: (?:yes|no)\n  Platform: [^\n]+\n<\/env>$/

export function isEnvironmentsSnapshot(value: unknown): value is EnvironmentsSnapshot {
  if (!record(value) || Object.keys(value).some((key) => key !== "lanes") || !Array.isArray(value.lanes)) return false
  const lanes = new Set<string>()
  return value.lanes.every((lane) => {
    if (!record(lane) || Object.keys(lane).some((key) => !["key", "chain", "checkpoints"].includes(key)) || !sha256(lane.key) || lanes.has(lane.key) || !Array.isArray(lane.chain) || !lane.chain.every(sha256) || !Array.isArray(lane.checkpoints) || !lane.checkpoints.length) return false
    lanes.add(lane.key)
    const anchors = new Set<string>()
    let position = 0
    return lane.checkpoints.every((checkpoint) => {
      if (!record(checkpoint) || Object.keys(checkpoint).some((key) => !["anchor", "position", "environment"].includes(key)) || !sha256(checkpoint.anchor) || anchors.has(checkpoint.anchor) || !Number.isSafeInteger(checkpoint.position) || (checkpoint.position as number) < position || (checkpoint.position as number) < 1 || typeof checkpoint.environment !== "string" || !environmentBlock.test(checkpoint.environment)) return false
      if ((lane.chain as string[])[(checkpoint.position as number) - 1] !== checkpoint.anchor) return false
      anchors.add(checkpoint.anchor)
      position = checkpoint.position as number
      return true
    })
  })
}

export function stripEnvironmentDate(system: string[]) {
  for (let index = 0; index < system.length; index++) {
    system[index] = system[index]!.replace(environment, (_match, identity: string, env: string) =>
      identity + env.replace(/\n  Today's date: [^\n]+/, ""),
    )
  }
}

export class Environments {
  private lanes = new Map<string, { session: string; chain: string[]; checkpoints: Checkpoint[] }>()

  apply(messages: WireMessage[], session: string, lane: string, options: { reconstruct?: boolean; replacements?: ReadonlyMap<WireMessage, WireMessage> } = {}) {
    const system = messages[0]
    if (system?.role !== "system" || typeof system.content !== "string") return
    const match = environment.exec(system.content)
    if (!match || !messages.some((message) => message.role === "user")) return
    // Do not move data across later system/developer instructions, which may
    // intentionally delimit different policy contexts.
    if (messages.slice(1).some((message) => message.role === "system" || message.role === "developer")) return

    const key = digest(JSON.stringify([session, lane]))
    const prior = this.lanes.get(key)
    let sourcePrefix = ""
    const sourceAnchors = messages.slice(1).map((message) => sourcePrefix = digest(sourcePrefix + "\n" + JSON.stringify(message)))
    let prefix = ""
    const anchors = messages.slice(1).map((message, index) => {
      const source = digest(prefix + "\n" + JSON.stringify(message))
      const replacement = options.replacements?.get(message)
      const repaired = replacement && digest(prefix + "\n" + JSON.stringify(replacement))
      prefix = repaired && source !== prior?.chain[index] && repaired === prior?.chain[index] ? repaired : source
      return prefix
    })
    if (!anchors.length) return
    const present = new Set(anchors)
    // Positions propose the old wire layout only. PrefixGuard must authenticate
    // it before any restored fields can participate in normal anchor validation.
    const checkpoints = (prior?.checkpoints ?? []).filter((checkpoint) => options.reconstruct
      ? checkpoint.position < messages.length
      : present.has(checkpoint.anchor)).map((checkpoint) => ({
        ...checkpoint, anchor: sourceAnchors[checkpoint.position - 1]!,
      }))
    const current = match[2]!.replace(/\n  Today's date: [^\n]+/, "")
    if (checkpoints.at(-1)?.environment !== current) {
      checkpoints.push({ anchor: sourceAnchors.at(-1)!, position: messages.length - 1, environment: current })
    }
    if (!options.reconstruct) this.lanes.set(key, { session, chain: sourceAnchors, checkpoints })
    const leading = { ...system, content: system.content.replace(environment, "$1") }

    const result: WireMessage[] = [leading]
    for (let index = 1; index < messages.length; index++) {
      result.push(messages[index]!)
      for (const checkpoint of checkpoints) {
        if (checkpoint.position !== index) continue
        const reminder: WireMessage = {
          role: "user",
          content: `<system-reminder>\n${checkpoint.environment}\n</system-reminder>`,
        }
        generatedEnvironments.add(reminder)
        result.push(reminder)
      }
    }
    messages.splice(0, messages.length, ...result)
  }

  snapshot(session: string): EnvironmentsSnapshot {
    return { lanes: [...this.lanes].flatMap(([key, lane]) => lane.session === session ? [{ key, chain: [...lane.chain], checkpoints: structuredClone(lane.checkpoints) }] : []) }
  }

  restore(session: string, value: unknown) {
    if (!isEnvironmentsSnapshot(value)) return false
    this.delete(session)
    for (const lane of value.lanes) {
      if (!this.lanes.has(lane.key)) this.lanes.set(lane.key, { session, chain: [...lane.chain], checkpoints: structuredClone(lane.checkpoints) })
    }
    return true
  }

  delete(sessionID: string) {
    for (const [key, value] of this.lanes) if (value.session === sessionID) this.lanes.delete(key)
  }
  clear() { this.lanes.clear() }
}

// JSON object member order is not schema semantics. Array order and strings
// (including enum values, examples and tool-call argument strings) are retained.
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
}

export class PrefixAudit {
  private lanes = new Map<string, { session: string; system: string; tools: string; messages: string[] }>()

  observe(body: { messages: WireMessage[]; tools?: unknown }, session: string, lane: string) {
    const next = {
      session,
      system: digest(JSON.stringify(body.messages.filter((message) => message.role === "system"))),
      tools: digest(JSON.stringify(body.tools ?? [])),
      messages: body.messages.filter((message) => message.role !== "system").map((message) => digest(JSON.stringify(message))),
    }
    const previous = this.lanes.get(lane)
    this.lanes.set(lane, next)
    if (!previous) return { firstRequest: true }
    let sharedMessages = 0
    while (sharedMessages < previous.messages.length && previous.messages[sharedMessages] === next.messages[sharedMessages]) sharedMessages++
    return {
      systemChanged: previous.system !== next.system,
      toolsChanged: previous.tools !== next.tools,
      historyRewritten: sharedMessages < previous.messages.length,
      sharedMessages,
      previousMessages: previous.messages.length,
      currentMessages: next.messages.length,
    }
  }

  delete(sessionID: string) {
    for (const [key, value] of this.lanes) if (value.session === sessionID) this.lanes.delete(key)
  }
  clear() { this.lanes.clear() }
}
