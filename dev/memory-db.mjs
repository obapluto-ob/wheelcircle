import { randomUUID } from 'node:crypto';

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

class Chain {
  constructor(db, table, mode = 'select') {
    this.db = db;
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
    const rows = this.db.table(this.table);
    if (this.mode === 'insert') {
      const row = { ...this.insertRow };
      if (!row.id) row.id = randomUUID();
      if (this.conflict && rows.some((existing) => this.conflict.every((column) => existing[column] === row[column]))) {
        return { data: [], error: null };
      }
      rows.push(row);
      return { data: [project(row, this.columns)], error: null };
    }
    if (this.mode === 'update') {
      const updated = [];
      for (const row of rows) {
        if (!matches(row, this.filters)) continue;
        Object.assign(row, clone(this.updateRow));
        updated.push(project(row, this.columns));
      }
      return { data: updated, error: null };
    }
    let result = rows.filter((row) => matches(row, this.filters)).map((row) => clone(row));
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      result.sort((a, b) => {
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

export function createMemoryDb() {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  const db = {
    from(name) {
      return new Chain(db, name);
    },
    table,
    snapshot() {
      const result = {};
      for (const [name, rows] of tables) result[name] = clone(rows);
      return result;
    },
    seed(name, rows) {
      const target = table(name);
      for (const row of rows) target.push(clone(row));
    },
    reset() {
      tables.clear();
    },
  };
  return db;
}
