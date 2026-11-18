import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { constants, watch, type FSWatcher } from "node:fs"
import { chmod, lstat, mkdir, open } from "node:fs/promises"
import { join, resolve } from "node:path"
import { isCompactionSnapshot, type CompactionSnapshot } from "./compaction"
import { isPrefixGuardSnapshot, type PrefixGuardSnapshot } from "./heads"
import { busy, digest as hash, record, uuidV4 } from "./shared"
import { isUsageSnapshot, type UsageSnapshot } from "./usage"

export type CheckpointSnapshot = {
  readonly boundary?: number
  readonly prefix: PrefixGuardSnapshot
  readonly usage: UsageSnapshot
  readonly compaction?: CompactionSnapshot
}
export type HistoryBoundary = { readonly sequence: number; readonly deleted: boolean }
type CheckpointLoad = { revision: string | null; snapshot: CheckpointSnapshot | null; reason?: "malformed" | "version" | "deleted" }
type Row = { revision: string; version: number; payload: string | null; deleted: number }
const version = 3

export function isCheckpointSnapshot(value: unknown, session: string): value is CheckpointSnapshot {
  if (!record(value)) return false
  return Object.keys(value).every((key) => ["boundary", "prefix", "usage", "compaction"].includes(key))
    && (value.boundary === undefined || typeof value.boundary === "number" && Number.isSafeInteger(value.boundary) && value.boundary >= 0)
    && isPrefixGuardSnapshot(value.prefix, session) && isUsageSnapshot(value.usage)
    && (value.compaction === undefined || isCompactionSnapshot(value.compaction))
}

export class CheckpointConflictError extends Error {
  readonly name = "CheckpointConflictError"

  constructor() { super("KV guard checkpoint revision conflict; reload the session before preparing another request") }
}

// One complete session bundle is the CAS unit, including all of its lanes. The
// caller serializes load -> restore -> prepare -> snapshot -> save locally and
// awaits save before dispatch. Cross-process stale saves fail rather than replacing
// another request's measured prefix. SQLite transactions release locks on process
// death. History invalidation waits for competing writers so its fence is not lost.
// An unreadable database fails closed. A readable but
// malformed/version-mismatched payload is a cache miss retaining its CAS token.
export class CheckpointStore {
  private readonly directory: string

  constructor(root: string, project: string, scope: string) {
    if (!root || !project || !scope) throw new Error("Checkpoint root, project and policy scope must be nonempty")
    this.directory = join(resolve(root), hash(project), hash(scope))
  }

  private async database(session: string) {
    if (!session) throw new Error("Checkpoint session must be nonempty")
    const root = resolve(this.directory, "../..")
    for (const directory of [root, resolve(this.directory, ".."), this.directory]) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Checkpoint directory must be owned by the current user and must not be a symlink")
      await chmod(directory, 0o700)
    }
    const path = join(this.directory, `${hash(session)}.sqlite`)
    const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Checkpoint file must be a regular file owned by the current user")
      await file.chmod(0o600)
    } finally { await file.close() }
    const db = new Database(path, { strict: true })
    try {
      db.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON")
      db.exec("CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), revision TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT, deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)))")
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  private row(db: Database) {
    const row = db.query<Row, []>("SELECT revision, version, payload, deleted FROM checkpoint WHERE id = 1").get()
    if (row && (typeof row.revision !== "string" || !uuidV4.test(row.revision) || (row.deleted !== 0 && row.deleted !== 1))) throw new Error("KV guard checkpoint database has an invalid revision or deletion marker")
    return row
  }

  private decode(row: Row | null, session: string): CheckpointLoad {
    if (!row) return { revision: null, snapshot: null }
    if (row.deleted) return { revision: row.revision, snapshot: null, reason: "deleted" }
    if (row.version !== version) return { revision: row.revision, snapshot: null, reason: "version" }
    let snapshot: unknown
    try {
      snapshot = typeof row.payload === "string" ? JSON.parse(row.payload) : null
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return { revision: row.revision, snapshot: null, reason: "malformed" }
    }
    if (!isCheckpointSnapshot(snapshot, session)) return { revision: row.revision, snapshot: null, reason: "malformed" }
    return { revision: row.revision, snapshot }
  }

  async load(session: string): Promise<CheckpointLoad> {
    const db = await this.database(session)
    try { return this.decode(this.row(db), session) } finally { db.close() }
  }

  async save(session: string, snapshot: CheckpointSnapshot, expectedRevision: string | null): Promise<string> {
    if (!isCheckpointSnapshot(snapshot, session)) throw new Error("KV guard refuses an invalid checkpoint snapshot")
    // Capture all completed state before awaiting any filesystem operation.
    const payload = JSON.stringify(snapshot)
    const db = await this.database(session)
    try {
      return db.transaction(() => {
        const row = this.row(db)
        if (row?.deleted) throw new Error("KV guard refuses to save a deleted session checkpoint")
        if ((row?.revision ?? null) !== expectedRevision) throw new CheckpointConflictError()
        const revision = randomUUID()
        db.query("INSERT INTO checkpoint (id, revision, version, payload, deleted) VALUES (1, ?, ?, ?, 0) ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, version = excluded.version, payload = excluded.payload, deleted = 0").run(revision, version, payload)
        return revision
      }).immediate()
    } finally { db.close() }
  }

  async reset(session: string, boundary: HistoryBoundary, onContention?: () => void): Promise<boolean> {
    const file = `${hash(session)}.sqlite`
    try {
      // load() creates this file before any writer can read its CAS token.
      // No file means no earlier checkpoint operation can publish old state.
      await lstat(join(this.directory, file))
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
      throw error
    }
    const payload = boundary.deleted ? null : JSON.stringify({
      boundary: boundary.sequence,
      prefix: { version: 2, session: hash(session), lanes: [] },
      usage: { lanes: [] },
    } satisfies CheckpointSnapshot)
    let notified = false
    for (;;) {
      const changed = Promise.withResolvers<void>()
      const journal = `${file}-journal`
      let watcher: FSWatcher | undefined
      // Subscribe before attempting the transaction. The fallback covers a
      // reservation released without journal activity or a missing FS event.
      const timer = setTimeout(changed.resolve, 250)
      try {
        try {
          watcher = watch(this.directory, (_event, filename) => {
            if (filename === journal) changed.resolve()
          })
          watcher.on("error", changed.resolve)
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOSYS", "ENOTSUP"].some((code) => code === error.code)) throw error
        }
        const db = await this.database(session)
        try {
          db.transaction(() => {
            const row = this.row(db)
            if (row?.deleted) return
            // Multiple instances can observe the same durable event. A duplicate
            // cannot revoke a request already prepared after the first reset.
            if (!boundary.deleted && (this.decode(row, session).snapshot?.boundary ?? -1) >= boundary.sequence) return
            db.query("INSERT INTO checkpoint (id, revision, version, payload, deleted) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, version = excluded.version, payload = excluded.payload, deleted = excluded.deleted").run(randomUUID(), version, payload, Number(boundary.deleted))
          }).immediate()
          return true
        } finally { db.close() }
      } catch (error) {
        if (!busy(error)) throw error
        if (!notified) { notified = true; onContention?.() }
        await changed.promise
      } finally {
        clearTimeout(timer)
        watcher?.close()
      }
    }
  }
}
