'use strict';
// Database access. With DATABASE_URL set it talks to real PostgreSQL; otherwise it uses an
// in-memory PostgreSQL emulator (pg-mem) so the app runs with zero setup for development/tests.
const fs = require('fs');
const path = require('path');

const toCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const NUMERIC = new Set(['amount', 'sumInsured']);

function mapRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const camel = toCamel(key);
    const v = row[key];
    out[camel] = NUMERIC.has(camel) && v !== null ? Number(v) : v;
  }
  return out;
}

async function createDb({ reset = false } = {}) {
  let pool;
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, allowExitOnIdle: true });
    // reset is only used by the automated tests: it wipes the schema so every test starts clean
    if (reset) {
      await pool.query('DROP SCHEMA public CASCADE');
      await pool.query('CREATE SCHEMA public');
    }
  } else {
    const { newDb } = require('pg-mem');
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    pool = new Pool();
  }

  const db = {
    async query(text, params = []) {
      const res = await pool.query(text, params);
      return res.rows.map(mapRow);
    },
    async one(text, params = []) {
      const rows = await db.query(text, params);
      return rows[0] || null;
    },
    async close() {
      await pool.end();
    },
  };

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  for (const statement of schema.split(';').map((s) => s.trim()).filter(Boolean)) {
    await pool.query(statement);
  }
  return db;
}

module.exports = { createDb };
