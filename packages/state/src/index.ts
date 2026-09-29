import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface StateRow {
  id: string;
  payload: string;
  updatedAt: string;
}

export interface StateStore {
  readonly path: string;
  list(): StateRow[];
  put(id: string, payload: string): void;
  delete(id: string): void;
  close(): void;
}

export interface SqliteStateStoreOptions {
  path?: string;
}

export class SqliteStateStore implements StateStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(options: SqliteStateStoreOptions = {}) {
    this.path =
      options.path ??
      process.env.ORCHESTRATION_STATE_DB ??
      path.join(homedir(), ".orchestration", "state.sqlite");

    mkdirSync(path.dirname(this.path), { recursive: true });

    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS task_state (" +
        "id TEXT PRIMARY KEY," +
        "payload TEXT NOT NULL," +
        "updated_at TEXT NOT NULL" +
      ") STRICT;",
    );
  }

  list(): StateRow[] {
    return this.db
      .prepare(
        "SELECT id, payload, updated_at AS updatedAt " +
          "FROM task_state ORDER BY updated_at ASC",
      )
      .all() as unknown as StateRow[];
  }

  put(id: string, payload: string): void {
    const updatedAt = new Date().toISOString();

    this.db
      .prepare(
        "INSERT INTO task_state (id, payload, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET " +
          "payload = excluded.payload, updated_at = excluded.updated_at",
      )
      .run(id, payload, updatedAt);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM task_state WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}
