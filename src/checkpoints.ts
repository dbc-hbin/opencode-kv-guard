import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { constants, watch, type FSWatcher } from "node:fs"
import { chmod, lstat, mkdir, open } from "node:fs/promises"
import { join, resolve } from "node:path"
import { isCompactionSnapshot, type CompactionSnapshot } from "./compaction"
import { isEnvironmentsSnapshot, isModeRemindersSnapshot, type EnvironmentsSnapshot, type ModeRemindersSnapshot } from "./prefix"

export type CheckpointSnapshot = { modes: ModeRemindersSnapshot; environments: EnvironmentsSnapshot; compaction: CompactionSnapshot }
export type CheckpointLoad = { revision: string | null; snapshot: CheckpointSnapshot | null; reason?: "malformed" | "version" | "deleted" }
type Row = { revision: string; version: number; payload: string | null; deleted: number }
const version = 1
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

export function isCheckpointSnapshot(value: unknown, session: string): value is CheckpointSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const bundle = value as Record<string, unknown>
  return Object.keys(bundle).every((key) => key === "modes" || key === "environments" || key === "compaction") && isModeRemindersSnapshot(bundle.modes, session) && isEnvironmentsSnapshot(bundle.environments) && isCompactionSnapshot(bundle.compaction)
}

export class CheckpointConflictError extends Error {
  constructor() { super("KV guard checkpoint revision conflict; reload the session before preparing another request") }
}

// One complete session bundle is the CAS unit, including all of its lanes. The
// caller serializes load -> restore -> prepare -> snapshot -> save locally and
// awaits save before main dispatch. Cross-process stale saves fail, never merge
// incompatible mode/environment/summary generations or overwrite another lane.
// SQLite transactions release OS locks on process death. Ordinary stale saves
// fail; deletion waits for competing writers so its tombstone is not lost.
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
    if (row && (typeof row.revision !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.revision) || (row.deleted !== 0 && row.deleted !== 1))) throw new Error("KV guard checkpoint database has an invalid revision or deletion marker")
    return row
  }

  async load(session: string): Promise<CheckpointLoad> {
    const db = await this.database(session)
    try {
      const row = this.row(db)
      if (!row) return { revision: null, snapshot: null }
      if (row.deleted) return { revision: row.revision, snapshot: null, reason: "deleted" }
      if (row.version !== version) return { revision: row.revision, snapshot: null, reason: "version" }
      let snapshot: unknown
      try { snapshot = typeof row.payload === "string" ? JSON.parse(row.payload) : null } catch { return { revision: row.revision, snapshot: null, reason: "malformed" } }
      if (!isCheckpointSnapshot(snapshot, session)) return { revision: row.revision, snapshot: null, reason: "malformed" }
      return { revision: row.revision, snapshot }
    } finally { db.close() }
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

  async delete(session: string, onContention?: () => void): Promise<void> {
    let notified = false
    for (;;) {
      const changed = Promise.withResolvers<void>()
      const journal = `${hash(session)}.sqlite-journal`
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
        } catch {
          // A not-yet-created directory or unsupported watcher uses the fallback.
        }
        const db = await this.database(session)
        try {
          db.transaction(() => {
            // Keep only an opaque tombstone: stale work, even from an initially
            // missing checkpoint, cannot resurrect a deleted session's state.
            db.query("INSERT INTO checkpoint (id, revision, version, payload, deleted) VALUES (1, ?, ?, NULL, 1) ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, version = excluded.version, payload = NULL, deleted = 1").run(randomUUID(), version)
          }).immediate()
          return
        } finally { db.close() }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string" || !/^SQLITE_(BUSY|LOCKED)/.test(error.code)) throw error
        if (!notified) { notified = true; onContention?.() }
        await changed.promise
      } finally {
        clearTimeout(timer)
        watcher?.close()
      }
    }
  }
}
