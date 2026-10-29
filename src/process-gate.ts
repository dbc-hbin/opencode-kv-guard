import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs"
import { hostname } from "node:os"
import { join, resolve } from "node:path"
import { endpointKey, type AdmissionGate, type GateRelease } from "./transport"
import { digest } from "./shared"

type Lease = { id: string; pid: number; identity: string }
type Owner = { identity: string; dead: boolean }

function absent(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH"
  }
}

function identity(pid: number): Owner | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      const start = fields[19]
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
      return start && boot ? { identity: `${boot}:${start}`, dead: fields[0] === "Z" || fields[0] === "X" } : undefined
    }
    if (process.platform === "darwin") {
      const fields = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "stat="], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      }).trim().split(/\s+/)
      const state = fields.pop()
      const start = fields.join(" ")
      return start && state ? { identity: start, dead: state.includes("Z") } : undefined
    }
  } catch {
    // An unreadable identity is not evidence that an owner is dead.
  }
}

function dead(lease: Lease) {
  if (absent(lease.pid)) return true
  const current = identity(lease.pid)
  return current !== undefined && (current.dead || current.identity !== lease.identity)
}

function busy(error: unknown) {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return false
  return error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED")
}

// Subscribe before inspecting SQLite, so a release between inspection and waiting
// cannot be lost. The bounded fallback also notices process death (no FS event).
function change(directory: string, signal?: AbortSignal) {
  let watcher: FSWatcher | undefined
  const { promise, resolve } = Promise.withResolvers<void>()
  const wake = () => resolve()
  const timer = setTimeout(wake, 250)
  const close = () => {
    watcher?.close()
    clearTimeout(timer)
    signal?.removeEventListener("abort", wake)
  }
  try {
    watcher = watch(directory, wake)
    watcher.on("error", wake)
  } catch {
    // A local FS without watch support still has the bounded fallback.
  }
  signal?.addEventListener("abort", wake, { once: true })
  if (signal?.aborted) wake()
  return { promise, close }
}

class ProcessGate implements AdmissionGate {
  private readonly file: string
  private readonly host = hostname()

  constructor(readonly capacity: number, private readonly directory: string, key: string) {
    this.file = join(directory, `${digest(key)}.sqlite`)
  }

  private transaction<T>(action: (db: Database) => T): T {
    const db = new Database(this.file, { create: true })
    let transaction = false
    try {
      db.exec("PRAGMA busy_timeout = 0")
      db.exec("BEGIN IMMEDIATE")
      transaction = true
      db.exec("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), capacity INTEGER NOT NULL, host TEXT NOT NULL)")
      db.exec("CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, identity TEXT NOT NULL)")
      db.query("INSERT OR IGNORE INTO settings (id, capacity, host) VALUES (1, ?, ?)").run(this.capacity, this.host)
      const settings = db.query("SELECT capacity, host FROM settings WHERE id = 1").get() as { capacity: number; host: string }
      if (settings.host !== this.host) throw new Error("KV guard: process admission directory belongs to another host")
      if (settings.capacity !== this.capacity) throw new Error("KV guard: conflicting maxConcurrent for process endpoint")
      const value = action(db)
      db.exec("COMMIT")
      transaction = false
      return value
    } finally {
      try {
        if (transaction) db.exec("ROLLBACK")
      } finally {
        db.close()
      }
    }
  }

  async acquire(signal?: AbortSignal): Promise<GateRelease> {
    signal?.throwIfAborted()
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    signal?.throwIfAborted()
    const processOwner = identity(process.pid)
    if (!processOwner) throw new Error("KV guard: process admission requires a readable Linux or macOS process identity")
    const owner = processOwner.identity
    const id = randomUUID()
    for (;;) {
      signal?.throwIfAborted()
      const changed = change(this.directory, signal)
      try {
        let acquired = false
        try {
          acquired = this.transaction((db) => {
            const leases = db.query("SELECT id, pid, identity FROM leases").all() as Lease[]
            let active = leases.length
            for (const lease of leases) {
              if (lease.pid === process.pid && lease.identity === owner) continue
              if (!dead(lease)) continue
              db.query("DELETE FROM leases WHERE id = ? AND pid = ? AND identity = ?").run(lease.id, lease.pid, lease.identity)
              active--
            }
            if (active >= this.capacity) return false
            db.query("INSERT INTO leases (id, pid, identity) VALUES (?, ?, ?)").run(id, process.pid, owner)
            return true
          })
        } catch (error) {
          if (!busy(error)) throw error
        }
        if (acquired) {
          let released: Promise<void> | undefined
          const release = () => released ??= this.release(id, owner)
          if (signal?.aborted) {
            await release()
            signal.throwIfAborted()
          }
          return release
        }
        await changed.promise
      } finally {
        changed.close()
      }
    }
  }

  private async release(id: string, owner: string) {
    for (;;) {
      const changed = change(this.directory)
      try {
        try {
          this.transaction((db) => {
            db.query("DELETE FROM leases WHERE id = ? AND pid = ? AND identity = ?").run(id, process.pid, owner)
          })
          return
        } catch (error) {
          if (!busy(error)) throw error
        }
        await changed.promise
      } finally {
        changed.close()
      }
    }
  }
}

// This is a same-host, local-filesystem protocol, not a distributed semaphore.
// SQLite serializes capacity checks, dead-owner cleanup and insertion in one
// transaction. A crash before COMMIT rolls back, including initial schema/config;
// a crash after COMMIT leaves an identifiable lease, never an ownerless lock.
export function processEndpointGate(baseURL: string, capacity: number, directory: string): AdmissionGate {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("KV guard: maxConcurrent must be a positive safe integer")
  if (!directory) throw new Error("KV guard: process admission requires a shared directory")
  return new ProcessGate(capacity, resolve(directory), endpointKey(baseURL))
}
