import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const TABLE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function project(row, columns) {
  if (!columns || columns === '*') return clone(row);
  const output = {};
  for (const key of columns.split(',').map((part) => part.trim()).filter(Boolean)) {
    if (key in row) output[key] = clone(row[key]);
  }
  return output;
}

function matches(row, filters) {
  return filters.every(([column, value]) => row[column] === value);
}

function sortRows(rows, orderBy) {
  if (!orderBy) return rows;
  const { column, ascending } = orderBy;
  return rows.sort((a, b) => {
    const left = a[column];
    const right = b[column];
    if (left === right) return 0;
    if (left === null || left === undefined) return ascending ? -1 : 1;
    if (right === null || right === undefined) return ascending ? 1 : -1;
    const order = typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left).localeCompare(String(right));
    return ascending ? order : -order;
  });
}

export function createSqliteDb(file = 'dev/wheel.db') {
  const sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA busy_timeout = 3000');
  const known = new Set();

  function ensure(name) {
    if (!TABLE_NAME.test(name)) throw new Error(`invalid table name: ${name}`);
    if (!known.has(name)) {
      sqlite.exec(`CREATE TABLE IF NOT EXISTS "${name}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
      known.add(name);
    }
  }

  function readAll(name) {
    ensure(name);
    return sqlite.prepare(`SELECT data FROM "${name}"`).all().map((item) => JSON.parse(item.data));
  }

  function write(row, name) {
    ensure(name);
    sqlite.prepare(`INSERT INTO "${name}" (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
      .run(row.id, JSON.stringify(row));
  }

  class Chain {
    constructor(table, mode = 'select') {
      this.table = table;
      this.mode = mode;
      this.columns = '*';
      this.filters = [];
      this.orderBy = null;
      this.limitTo = null;
      this.insertRow = null;
      this.conflict = null;
      this.updateRow = null;
    }

    select(columns = '*') {
      this.columns = columns || '*';
      return this;
    }

    eq(column, value) {
      this.filters.push([column, value]);
      return this;
    }

    order(column, { ascending = true } = {}) {
      this.orderBy = { column, ascending: ascending !== false };
      return this;
    }

    limit(count) {
      this.limitTo = Number(count);
      return this;
    }

    insertIfAbsent(row, options = {}) {
      this.mode = 'insert';
      this.insertRow = clone(row);
      const target = String(options.onConflict || '').split(',').map((part) => part.trim()).filter(Boolean);
      this.conflict = target.length ? target : null;
      return this;
    }

    update(row) {
      this.mode = 'update';
      this.updateRow = clone(row);
      return this;
    }

    _run() {
      const rows = readAll(this.table);
      if (this.mode === 'insert') {
        const row = { ...this.insertRow };
        if (!row.id) row.id = randomUUID();
        const exists = this.conflict
          ? rows.some((existing) => this.conflict.every((column) => existing[column] === row[column]))
          : rows.some((existing) => existing.id === row.id);
        if (exists) return { data: [], error: null };
        write(row, this.table);
        return { data: [project(row, this.columns)], error: null };
      }
      if (this.mode === 'update') {
        const updated = [];
        for (const row of rows) {
          if (!matches(row, this.filters)) continue;
          const next = { ...row, ...clone(this.updateRow) };
          write(next, this.table);
          updated.push(project(next, this.columns));
        }
        return { data: updated, error: null };
      }
      let result = rows.filter((row) => matches(row, this.filters));
      result = sortRows(result, this.orderBy);
      if (Number.isFinite(this.limitTo)) result = result.slice(0, this.limitTo);
      return { data: result.map((row) => project(row, this.columns)), error: null };
    }

    then(resolve, reject) {
      try {
        resolve(this._run());
      } catch (error) {
        if (reject) reject(error);
        else throw error;
      }
    }

    catch(reject) {
      return Promise.resolve(this._run()).catch(reject);
    }
  }

  const db = {
    from(name) {
      return new Chain(name);
    },
    table(name) {
      return readAll(name);
    },
    snapshot() {
      const result = {};
      const names = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      for (const { name } of names) result[name] = readAll(name);
      return result;
    },
    seed(name, rows) {
      for (const row of rows) write({ ...row, id: row.id || randomUUID() }, name);
    },
    reset() {
      const names = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      for (const { name } of names) sqlite.exec(`DELETE FROM "${name}"`);
    },
    close() {
      sqlite.close();
    },
  };
  return db;
}
