#!/usr/bin/env node
/**
 * Generates large test files — one per supported connector — for exercising
 * the drag-and-drop import flow.
 *
 *   node scripts/generate-test-data.js                     # default sizes
 *   node scripts/generate-test-data.js --scale 2           # twice as big
 *   node scripts/generate-test-data.js --only csv,xlsx     # subset
 *   node scripts/generate-test-data.js --out /some/dir
 *   node scripts/generate-test-data.js --clean             # wipe the dir first
 *
 * Rows carry deliberate edge cases — quoted commas, embedded newlines, unicode,
 * leading zeros, 19-digit ids, blanks, booleans — so a successful import also
 * says something about correctness, not just throughput.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const req = (name) => require(path.join(ROOT, 'node_modules', name));

const XLSX = req('xlsx');
const parquet = req('parquetjs');
const avro = req('avsc');
const sqlite3 = req('sqlite3');
const Datastore = req('@seald-io/nedb');

// ── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const OUT = String(flag('out', path.join(require('os').homedir(), 'Desktop', 'test_data')));
const SCALE = Number(flag('scale', 1)) || 1;
const ONLY = flag('only') ? String(flag('only')).split(',').map((s) => s.trim()) : null;
const CLEAN = Boolean(flag('clean', false));

// Row counts at scale 1. NeDB and LanceDB stay smaller on purpose: NeDB holds
// its whole collection in memory once loaded, and LanceDB rows carry 128 floats.
const SIZES = {
  csv: 5_000_000,
  'csv-semicolon': 200_000,
  'csv-edge': 12,
  xlsx: 150_000,      // per sheet, 2 sheets
  json: 1_000_000,
  parquet: 800_000,
  avro: 2_000_000,
  sqlite: 2_000_000,
  nedb: 300_000,
  lancedb: 40_000,
};

const rows = (key) => Math.max(1, Math.round(SIZES[key] * (key === 'csv-edge' ? 1 : SCALE)));
const wanted = (key) => !ONLY || ONLY.includes(key) || ONLY.includes(key.split('-')[0]);

// ── row data ────────────────────────────────────────────────────────────────

const CITIES = ['Toronto', 'München', 'São Paulo', 'Kraków', '東京', 'Vancouver', 'Zürich', 'Montréal'];
const STATUSES = ['shipped', 'pending', 'refunded', 'cancelled'];

/** One logical record. Every generator projects this into its own format. */
const record = (i) => ({
  id: i,
  order_no: `0${String(1000000 + (i % 8999999))}`,       // leading zero → must stay TEXT
  customer: i % 997 === 0 ? `Smith, John (#${i})` : `Customer ${i}`, // comma inside a quoted field
  email: `user${i}@example.com`,
  amount: Math.round(((i % 99999) + 0.37) * 100) / 100,
  quantity: (i % 47) + 1,
  city: CITIES[i % CITIES.length],
  status: STATUSES[i % STATUSES.length],
  active: i % 3 !== 0,
  external_id: `${9007199254740993n + BigInt(i)}`,        // 19 digits → must stay TEXT
  notes: i % 1499 === 0 ? `multi\nline note ${i}` : '',   // embedded newline + blanks
  created_at: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
});

const COLUMNS = Object.keys(record(0));

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// ── helpers ─────────────────────────────────────────────────────────────────

const started = Date.now();
const results = [];

const human = (bytes) => {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
};

const dirSize = (dir) => {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
};

/** Run one generator, timing it and recording the artifact it produced. */
async function step(key, label, target, fn) {
  if (!wanted(key)) return;
  const t0 = Date.now();
  process.stdout.write(`  ${label.padEnd(28)} `);
  try {
    const count = await fn();
    const full = path.join(OUT, target);
    const size = fs.statSync(full).isDirectory() ? dirSize(full) : fs.statSync(full).size;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({ target, count, size, secs, ok: true });
    console.log(`${target}  ${human(size).padStart(9)}  ${String(count).padStart(10)} rows  ${secs}s`);
  } catch (error) {
    results.push({ target, ok: false, error: error.message });
    console.log(`SKIPPED — ${error.message}`);
  }
}

/** Write to a stream with back-pressure so generation never balloons memory. */
async function writeStream(filePath, produce) {
  const out = fs.createWriteStream(filePath);
  const write = async (chunk) => {
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
  };
  await produce(write);
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });
}

// ── generators ──────────────────────────────────────────────────────────────

async function makeCsv(file, count, delimiter = ',', withBom = false) {
  await writeStream(path.join(OUT, file), async (write) => {
    if (withBom) await write('﻿');
    await write(COLUMNS.join(delimiter) + '\n');
    let buffer = '';
    for (let i = 1; i <= count; i++) {
      const r = record(i);
      buffer += COLUMNS.map((c) => csvCell(r[c])).join(delimiter) + '\n';
      if (buffer.length > 1 << 20) { await write(buffer); buffer = ''; }
    }
    if (buffer) await write(buffer);
  });
  return count;
}

/**
 * A small CSV where every row is a deliberate trap, for checking the import is
 * *correct* rather than just fast. The large files use a modulo cadence for
 * their edge cases, which a short file would never reach.
 */
async function makeEdgeCsv(file) {
  const rowsOut = [
    ['1', '007', 'Smith, John', 'a@b.com', '10.50', '2', 'Toronto', 'shipped', 'true', '9007199254740993', 'plain', '2026-01-01'],
    ['2', '00042', 'O\'Brien, Ann', 'c@d.com', '0.01', '1', 'München', 'pending', 'false', '12345678901234567890', 'multi\nline\nnote', '2026-02-14'],
    ['3', '000', 'Quote "inside" name', 'e@f.com', '-99.99', '0', '東京', 'refunded', 'true', '1', 'tab\there', '2026-03-31'],
    ['4', '0100', 'Ünïcödé Nâme', 'g@h.com', '1e6', '999', 'São Paulo', 'cancelled', 'true', '0', '', '2026-12-31'],
    ['5', '', '', '', '', '', '', '', '', '', '', ''],                       // all blank → all null
    ['6', '0999', 'Trailing spaces  ', 'i@j.com', '3.00', '7', 'Kraków', 'shipped', 'false', '42', '  padded  ', '2026-06-15'],
    ['7', '1000', 'Not zero padded', 'k@l.com', 'NaN', '8', 'Zürich', 'pending', 'true', '99', 'text in numeric col', '2026-07-04'],
    ['8', '0001', 'Semicolon; inside', 'm@n.com', '12.34', '9', 'Montréal', 'refunded', 'false', '100', 'comma, inside', '2026-08-08'],
  ];
  await writeStream(path.join(OUT, file), async (write) => {
    await write('﻿' + COLUMNS.join(',') + '\r\n');                       // BOM + CRLF
    for (const row of rowsOut) await write(row.map(csvCell).join(',') + '\r\n');
  });
  return rowsOut.length;
}

async function makeXlsx(file, perSheet) {
  const workbook = XLSX.utils.book_new();
  for (const [sheetName, offset] of [['Orders', 0], ['Returns', 5_000_000]]) {
    const aoa = [COLUMNS];
    for (let i = 1; i <= perSheet; i++) {
      const r = record(i + offset);
      aoa.push(COLUMNS.map((c) => r[c]));
    }
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa, { dense: true }), sheetName);
  }
  // A third, empty sheet: the importer should skip it rather than fail.
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), 'Empty');
  XLSX.writeFile(workbook, path.join(OUT, file), { compression: true });
  return perSheet * 2;
}

async function makeJson(file, count) {
  await writeStream(path.join(OUT, file), async (write) => {
    await write('[\n');
    let buffer = '';
    for (let i = 1; i <= count; i++) {
      const r = record(i);
      // Nested + array fields, so the NeDB side gets real document shapes.
      const doc = { ...r, address: { city: r.city, country: 'CA' }, tags: ['bulk', r.status] };
      buffer += `${i > 1 ? ',' : ''}${JSON.stringify(doc)}\n`;
      if (buffer.length > 1 << 20) { await write(buffer); buffer = ''; }
    }
    if (buffer) await write(buffer);
    await write(']\n');
  });
  return count;
}

async function makeParquet(file, count) {
  const schema = new parquet.ParquetSchema({
    id: { type: 'INT64' },
    order_no: { type: 'UTF8' },
    'customer name': { type: 'UTF8' },            // space in the name on purpose
    amount: { type: 'DOUBLE' },
    quantity: { type: 'INT32' },
    city: { type: 'UTF8' },
    active: { type: 'BOOLEAN' },
    score: { type: 'DOUBLE', optional: true },    // nullable
  });
  const writer = await parquet.ParquetWriter.openFile(schema, path.join(OUT, file));
  for (let i = 1; i <= count; i++) {
    const r = record(i);
    await writer.appendRow({
      id: i,
      order_no: r.order_no,
      'customer name': r.customer,
      amount: r.amount,
      quantity: r.quantity,
      city: r.city,
      active: r.active,
      score: i % 11 === 0 ? null : i / 7,
    });
  }
  await writer.close();
  return count;
}

async function makeAvro(file, count) {
  const type = avro.Type.forSchema({
    type: 'record',
    name: 'Order',
    fields: [
      { name: 'id', type: 'long' },
      { name: 'order_no', type: 'string' },
      { name: 'customer', type: 'string' },
      { name: 'amount', type: 'double' },
      { name: 'city', type: 'string' },
      { name: 'active', type: 'boolean' },
      { name: 'meta', type: { type: 'record', name: 'Meta', fields: [{ name: 'status', type: 'string' }] } },
    ],
  });
  // Piping by hand rather than using createFileEncoder: we need the *file*
  // stream's close event, otherwise the process can exit mid-flush and leave a
  // truncated container behind.
  const fileStream = fs.createWriteStream(path.join(OUT, file));
  const encoder = new avro.streams.BlockEncoder(type, { codec: 'deflate' });
  encoder.pipe(fileStream);

  for (let i = 1; i <= count; i++) {
    const r = record(i);
    const row = { id: i, order_no: r.order_no, customer: r.customer, amount: r.amount, city: r.city, active: r.active, meta: { status: r.status } };
    if (!encoder.write(row)) await new Promise((resolve) => encoder.once('drain', resolve));
  }
  encoder.end();
  await new Promise((resolve, reject) => {
    fileStream.on('close', resolve);
    fileStream.on('error', reject);
  });
  return count;
}

async function makeSqlite(file, count) {
  const dbPath = path.join(OUT, file);
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  const db = new sqlite3.Database(dbPath);
  const run = (sql) => new Promise((resolve, reject) => db.run(sql, (e) => (e ? reject(e) : resolve())));

  await run('PRAGMA journal_mode=WAL');
  await run('PRAGMA synchronous=OFF');
  await run(`CREATE TABLE orders (
    id INTEGER PRIMARY KEY, order_no TEXT, customer TEXT, email TEXT,
    amount REAL, quantity INTEGER, city TEXT, status TEXT, active INTEGER,
    external_id TEXT, created_at TEXT)`);
  await run('CREATE TABLE cities (name TEXT, country TEXT)');

  const BATCH = 5000;
  for (let start = 1; start <= count; start += BATCH) {
    await run('BEGIN');
    await new Promise((resolve, reject) => {
      const stmt = db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?)');
      for (let i = start; i < Math.min(start + BATCH, count + 1); i++) {
        const r = record(i);
        stmt.run([i, r.order_no, r.customer, r.email, r.amount, r.quantity, r.city, r.status, r.active ? 1 : 0, r.external_id, r.created_at]);
      }
      stmt.finalize((e) => (e ? reject(e) : resolve()));
    });
    await run('COMMIT');
  }
  await new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT INTO cities VALUES (?,?)');
    CITIES.forEach((c) => stmt.run([c, 'XX']));
    stmt.finalize((e) => (e ? reject(e) : resolve()));
  });
  await run('PRAGMA wal_checkpoint(TRUNCATE)');
  await new Promise((resolve) => db.close(resolve));
  return count;
}

async function makeNedb(file, count) {
  const dbPath = path.join(OUT, file);
  fs.rmSync(dbPath, { force: true });
  const db = new Datastore({ filename: dbPath });
  await db.loadDatabaseAsync();
  const BATCH = 10000;
  for (let start = 1; start <= count; start += BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(start + BATCH, count + 1); i++) {
      const r = record(i);
      batch.push({ ...r, address: { city: r.city, country: 'CA' } });
    }
    await db.insertAsync(batch);
  }
  await db.compactDatafileAsync();
  return count;
}

async function makeLanceDb(dirName, count) {
  let lancedb;
  try {
    lancedb = req('@lancedb/lancedb');
  } catch {
    throw new Error('@lancedb/lancedb not installed');
  }
  const dir = path.join(OUT, dirName);
  fs.rmSync(dir, { recursive: true, force: true });
  const db = await lancedb.connect(dir);

  const DIM = 128;
  const makeRows = (from, to) => {
    const out = [];
    for (let i = from; i < to; i++) {
      const vector = new Array(DIM);
      for (let d = 0; d < DIM; d++) vector[d] = Math.sin(i * 0.001 + d) ;
      const r = record(i + 1);
      out.push({ vector, id: i + 1, text: r.customer, city: r.city, amount: r.amount });
    }
    return out;
  };

  const BATCH = 5000;
  const table = await db.createTable('documents', makeRows(0, Math.min(BATCH, count)));
  for (let start = BATCH; start < count; start += BATCH) {
    await table.add(makeRows(start, Math.min(start + BATCH, count)));
  }
  return count;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  if (CLEAN && fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  console.log(`\nGenerating test data → ${OUT}   (scale ${SCALE}${ONLY ? `, only: ${ONLY.join(', ')}` : ''})\n`);

  await step('csv-edge', 'CSV (tiny, edge cases)', 'edge_cases.csv', () => makeEdgeCsv('edge_cases.csv'));
  await step('csv', 'CSV (large)', 'orders_large.csv', () => makeCsv('orders_large.csv', rows('csv')));
  await step('csv-semicolon', 'CSV (semicolon delimited)', 'orders_semicolon.csv', () => makeCsv('orders_semicolon.csv', rows('csv-semicolon'), ';'));
  await step('xlsx', 'Excel (3 sheets)', 'orders.xlsx', () => makeXlsx('orders.xlsx', rows('xlsx')));
  await step('json', 'JSON (array of docs)', 'orders.json', () => makeJson('orders.json', rows('json')));
  await step('parquet', 'Parquet', 'orders.parquet', () => makeParquet('orders.parquet', rows('parquet')));
  await step('avro', 'Avro', 'orders.avro', () => makeAvro('orders.avro', rows('avro')));
  await step('sqlite', 'SQLite (2 tables)', 'warehouse.sqlite', () => makeSqlite('warehouse.sqlite', rows('sqlite')));
  await step('nedb', 'NeDB', 'documents.nedb', () => makeNedb('documents.nedb', rows('nedb')));
  await step('lancedb', 'LanceDB (128-dim vectors)', 'vectors.lance', () => makeLanceDb('vectors.lance', rows('lancedb')));

  const ok = results.filter((r) => r.ok);
  const total = ok.reduce((sum, r) => sum + r.size, 0);
  console.log(`\n${ok.length} artifact(s), ${human(total)} total, in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  const skipped = results.filter((r) => !r.ok);
  if (skipped.length) console.log(`skipped: ${skipped.map((s) => `${s.target} (${s.error})`).join(', ')}`);
  console.log('');
}

main().catch((error) => { console.error(error); process.exit(1); });
