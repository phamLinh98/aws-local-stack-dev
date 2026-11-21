const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const { DatabaseSync } = require('node:sqlite');

// SQLite transactions retain Map/Buffer types and commit before a successful response.
function openStore(directory) {
  if (!directory) return { load: () => null, save() {}, close() {}, path: null };
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'workspace.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, payload BLOB NOT NULL, updated_at TEXT NOT NULL)');
  return {
    path: filename,
    load() {
      const row = db.prepare('SELECT * FROM workspace WHERE id=1').get();
      if (!row) return null;
      if (row.schema_version !== 1) throw new Error('Unsupported workspace schema. Back up the database before upgrading.');
      return v8.deserialize(Buffer.from(row.payload));
    },
    save(value) { db.prepare('INSERT INTO workspace VALUES(1,1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at').run(v8.serialize(value), new Date().toISOString()); },
    close() { db.close(); },
  };
}
module.exports = { openStore };
