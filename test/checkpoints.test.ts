import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CheckpointConflictError, CheckpointStore, type CheckpointSnapshot } from "../src/checkpoints"
import { PrefixGuard } from "../src/heads"

const roots: string[] = []
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const empty = (session = "session"): CheckpointSnapshot => ({ prefix: { version: 2, session: hash(session), lanes: [] }, usage: { lanes: [] } })
const deleted = { sequence: 1, deleted: true } as const

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


describe("filesystem checkpoint CAS", () => {
  test("parallel writers reject stale revisions without dropping another completed lane", async () => {
    const directory = await root()
    const one = new CheckpointStore(directory, "project", "scope")
    const two = new CheckpointStore(directory, "project", "scope")
    const initial = await one.load("session")
    const prompt = { model: "fixture", messages: [{ role: "user", content: "prompt" }] }
    const snapshots = ["first", "second"].map((lane) => {
      const guard = new PrefixGuard()
      guard.apply(prompt, { session: "session", lane })
      return { ...empty(), prefix: guard.snapshot("session") }
    })
    const results = await Promise.allSettled([one.save("session", snapshots[0]!, initial.revision), two.save("session", snapshots[1]!, initial.revision)])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const failure = results.find((result) => result.status === "rejected")
    expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(CheckpointConflictError)
    const loaded = await one.load("session")
    if (!loaded.snapshot) throw new Error("Successful writer did not persist its checkpoint")
    expect(snapshots).toContainEqual(loaded.snapshot)
    const merged = new PrefixGuard()
    merged.restore("session", loaded.snapshot.prefix)
    const lane = loaded.snapshot.prefix.lanes[0]?.lane === "first" ? "second" : "first"
    merged.apply(prompt, { session: "session", lane })
    await two.save("session", { ...loaded.snapshot, prefix: merged.snapshot("session") }, loaded.revision)
    expect((await one.load("session")).snapshot?.prefix.lanes.map((item) => item.lane).sort()).toEqual(["first", "second"])
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
    const entry = { lane: hash("lane"), anchor: { policy: hash("policy"), messages: [hash("message")], promptTokens: 16500 } }
    for (const usage of [
      { lanes: [{ ...entry, anchor: { ...entry.anchor, promptTokens: -1 } }] },
      { lanes: [{ ...entry, anchor: { ...entry.anchor, messages: ["not-a-hash"] } }] },
      { lanes: [{ ...entry, receipt: "invalid-generation" }] },
      { lanes: [{ lane: entry.lane }] },
      { lanes: [entry, entry] },
    ]) {
      const invalid = new Database(path(directory))
      try { invalid.query("UPDATE checkpoint SET payload = ? WHERE id = 1").run(JSON.stringify({ ...empty(), usage })) } finally { invalid.close() }
      expect(await store.load("session")).toMatchObject({ revision: malformed.revision, snapshot: null, reason: "malformed" })
    }
    await store.save("session", empty(), malformed.revision)
    const newer = new Database(path(directory))
    try { newer.exec("UPDATE checkpoint SET version = 999 WHERE id = 1") } finally { newer.close() }
    const unsupported = await store.load("session")
    expect(unsupported).toMatchObject({ snapshot: null, reason: "version" })
    await store.save("session", empty(), unsupported.revision)
    expect((await store.load("session")).snapshot).toEqual(empty())
    await expect(store.save("session", empty("other-session"), (await store.load("session")).revision)).rejects.toThrow("invalid checkpoint")
  })

  test("project, policy, session and credentials stay isolated behind private hashed paths", async () => {
    const directory = await root()
    const project = "project-with-secret-credential"
    const scope = "policy-with-secret-credential"
    const session = "session-with-secret-credential"
    const store = new CheckpointStore(directory, project, scope)
    const guard = new PrefixGuard()
    guard.apply({ model: "fixture", messages: [{ role: "user", content: "private prompt" }] }, {
      session, lane: hash("Authorization: Bearer transport-secret"),
    })
    const snapshot = { ...empty(session), prefix: guard.snapshot(session) }
    await store.save(session, snapshot, null)
    const file = path(directory, project, scope, session)
    for (const target of [directory, join(directory, hash(project)), join(directory, hash(project), hash(scope))]) expect((await stat(target)).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const names = await readdir(directory, { recursive: true })
    expect(names.every((name) => !name.includes("secret-credential"))).toBe(true)
    expect(Buffer.from(await Bun.file(file).arrayBuffer()).includes(Buffer.from("secret-credential"))).toBe(false)
    expect(Buffer.from(await Bun.file(file).arrayBuffer()).includes(Buffer.from("transport-secret"))).toBe(false)
    expect(Buffer.from(await Bun.file(file).arrayBuffer()).includes(Buffer.from("private prompt"))).toBe(false)
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
    await store.reset("never-saved", deleted)
    await expect(store.save("never-saved", empty("never-saved"), missing.revision)).rejects.toThrow("deleted session")
    await store.save("session", empty(), null)
    const loaded = await store.load("session")
    await store.reset("session", deleted)
    expect(await store.load("session")).toMatchObject({ snapshot: null, reason: "deleted" })
    await expect(store.save("session", empty(), loaded.revision)).rejects.toThrow("deleted session")
    await store.reset("session", { sequence: 2, deleted: false })
    expect(await store.load("session")).toMatchObject({ snapshot: null, reason: "deleted" })
  })

  test("history fences revoke stale revisions but duplicate events do not clear new requests", async () => {
    const directory = await root()
    const state = new CheckpointStore(directory, "project", "scope")
    const observer = new CheckpointStore(directory, "project", "scope")
    const stale = await state.save("session", empty(), null)
    const boundary = { sequence: 10, deleted: false }
    await observer.reset("session", boundary)
    await expect(state.save("session", empty(), stale)).rejects.toBeInstanceOf(CheckpointConflictError)
    const loaded = await state.load("session")
    const prepared = { ...empty(), boundary: 10, usage: { lanes: [{ lane: hash("lane"), anchor: { policy: hash("policy"), messages: [], promptTokens: 400 } }] } }
    const revision = await state.save("session", prepared, loaded.revision)

    await observer.reset("session", boundary)
    await observer.reset("session", { sequence: 9, deleted: false })

    expect(await state.load("session")).toEqual({ revision, snapshot: prepared })
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
      const deletion = store.reset("session", deleted, contended.resolve)
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
})
