// Postgres pool + idempotent schema migration.
import { fileURLToPath } from "node:url";
import pg from "pg";
import Postgrator from "postgrator";

export function createPool(): pg.Pool {
  return new pg.Pool({
    connectionString:
      process.env.DEVPROOF_DATABASE_URL ??
      "postgres://devproof:devproof-dev@127.0.0.1:15432/devproof",
    max: 5,
  });
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const dir = fileURLToPath(new URL("../sql", import.meta.url));
  // Tracked migrations (Postgrator, spec 2026-07-19): sql/*.sql run exactly once,
  // recorded in schema_migrations with an MD5 per file — editing an applied file
  // fails the boot (validateChecksums). Forward-only; no undo files.
  // Concurrent migrators (parallel test files; multi-replica boots) still race
  // DDL, and Postgrator does no locking of its own — the database-wide advisory
  // lock below remains what serializes them. Session-level (not xact) because
  // migrations run as their own implicit transactions on this one client.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('devproof_migrate'))");
    const { rows: [{ db }] } = await client.query("SELECT current_database() AS db");
    const postgrator = new Postgrator({
      migrationPattern: dir.replaceAll("\\", "/") + "/*.sql",
      driver: "pg",
      database: db,
      schemaTable: "schema_migrations",
      validateChecksums: true,
      newline: "LF", // normalize CRLF before MD5 so Windows/Linux checkouts agree
      execQuery: (query) => client.query(query),
    });
    await postgrator.migrate();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('devproof_migrate'))");
      client.release();
    } catch (err) {
      client.release(err as Error); // unlock failed ⇒ connection is suspect: destroy, don't pool it
    }
  }
}

/**
 * Push-based session-event fan-out (scale: avoids per-viewer DB polling).
 * One dedicated LISTEN connection; in-process subscribers keyed by session id.
 * Callers NOTIFY 'devproof_session' with the session id on append/status change.
 */
type Listener = () => void;

export class NotifyHub {
  private subs = new Map<string, Set<Listener>>();
  private wakeSubs = new Set<(model: string) => void>();
  private client: pg.PoolClient | null = null;

  constructor(private pool: pg.Pool) {}

  async start() {
    this.client = await this.pool.connect();
    this.client.on("notification", (msg) => {
      const payload = msg.payload ?? "";
      if (msg.channel === "devproof_wake") {
        for (const fn of this.wakeSubs) { try { fn(payload); } catch { /* ignore */ } }
        return;
      }
      for (const fn of this.subs.get(payload) ?? []) { try { fn(); } catch { /* ignore */ } }
    });
    // Reconnect on error so the hub survives transient DB blips. The dead
    // client must be destroyed (release(err) evicts it from the pool) — the
    // old handler only nulled the reference, leaking one of the pool's 5
    // slots per tunnel flake until every DB-backed route hung on an
    // exhausted pool (live wedge 2026-07-14).
    this.client.on("error", () => {
      const dead = this.client;
      this.client = null;
      try { dead?.release(new Error("notify connection lost")); } catch { /* already released */ }
      setTimeout(() => this.start().catch(() => {}), 1000);
    });
    await this.client.query("LISTEN devproof_session");
    // Scale-to-zero wake signal from the gateway pre-call hook (spec 2026-07-15).
    await this.client.query("LISTEN devproof_wake");
  }

  subscribe(sessionId: string, fn: Listener): () => void {
    let set = this.subs.get(sessionId);
    if (!set) { set = new Set(); this.subs.set(sessionId, set); }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.subs.delete(sessionId);
    };
  }

  /** Gateway wake signals (scale-to-zero): payload is the model name. */
  onWake(fn: (model: string) => void) {
    this.wakeSubs.add(fn);
  }
}
