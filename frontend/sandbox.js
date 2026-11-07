/* SQL sandbox — DuckDB-WASM, running entirely in the student's browser.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CONSOLE
 *
 * The console (api.js -> /query -> guard.py -> PostgreSQL) serves a curated
 * teaching dataset that sits next to answer-key tables. Its whole design is
 * that the server never hands a student a write path. This module is the
 * opposite job — arbitrary data the student owns, with CREATE/INSERT and a
 * download — so it deliberately runs somewhere the server cannot be harmed:
 * the student's own browser.
 *
 * The invariant that makes that safe, and which must survive every future
 * edit: NOTHING IN THIS FILE TALKS TO THE SERVER. There is no import from
 * api.js, no fetch to an API path, no session, no audit. The only network
 * requests are the same-origin GETs that fetch the vendored engine itself.
 * A file a student drops here never leaves their machine.
 *
 * Consequences the UI must respect:
 *   - No roles. There is no student/instructor distinction in here, because
 *     there is nothing to protect: it is their own data.
 *   - The "never reinterpret E_UNKNOWN_TABLE" rule (frontend/README.md §4.2)
 *     does NOT apply to errors from this engine. Those errors are about the
 *     student's own file, so they are shown verbatim and are meant to be
 *     helpful. The rule still binds every message coming from api.js.
 *   - Table and column names here come from the uploaded file, not from
 *     GET /schema, so rule §4.1 ("never hardcode schema names") is likewise
 *     not in play. Keep the two worlds apart in the code so nobody confuses
 *     which rules bind where.
 */

const VENDOR = './vendor/duckdb-wasm/';
const WASM_URL = VENDOR + 'duckdb-eh.wasm';
const WORKER_URL = VENDOR + 'duckdb-browser-eh.worker.js';
// .js, not the upstream .mjs: Python's mimetypes has no entry for .mjs, so
// both StaticFiles and serve.py hand it back as text/plain -- and a browser
// refuses to import() a module with a non-JS MIME type. Renaming the file is
// more robust than teaching two servers a new extension.
const LOADER_URL = VENDOR + 'duckdb-browser.js';

/** Rows painted into the grid. results.js builds the full DOM with no
 *  virtualisation (frontend/README.md §5), so this is a rendering limit, not a
 *  query limit — the download below is not capped by it. */
export const RENDER_LIMIT = 2000;

/** Rows a CSV download will materialise. A ceiling exists so that a careless
 *  `SELECT *` over a 100M-row parquet cannot wedge the tab; it is announced
 *  rather than applied silently. */
export const DOWNLOAD_LIMIT = 1_000_000;

/* Recognised inputs. Excel is deliberately absent: reading .xlsx needs
 * DuckDB's `excel` extension, which is fetched from the extension repository
 * at runtime — impossible here both because the lab may be offline and because
 * connect-src 'self' blocks it. Saying so beats a broken drop target. */
const READERS = [
  { ext: ['.csv'], fn: (p) => `read_csv_auto('${p}', header = true, sample_size = -1)` },
  { ext: ['.tsv', '.tab'], fn: (p) => `read_csv_auto('${p}', header = true, delim = '\t', sample_size = -1)` },
  { ext: ['.txt'], fn: (p) => `read_csv_auto('${p}', header = true, sample_size = -1)` },
  { ext: ['.parquet', '.pq'], fn: (p) => `read_parquet('${p}')` },
  { ext: ['.json', '.ndjson', '.jsonl'], fn: (p) => `read_json_auto('${p}')` },
];

export const ACCEPTED_EXTENSIONS = READERS.flatMap((r) => r.ext);

function readerFor(filename) {
  const lower = filename.toLowerCase();
  return READERS.find((r) => r.ext.some((e) => lower.endsWith(e))) || null;
}

/** file name -> a SQL identifier a student can actually type. */
export function tableNameFor(filename, taken) {
  const stem = filename.replace(/\.[^.]+$/, '');
  let name = stem
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // after NFD this turns Vietnamese marks into plain letters
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) name = 'bang';
  if (/^\d/.test(name)) name = 't_' + name;
  if (!taken || !taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name}_${n}`)) n += 1;
  return `${name}_${n}`;
}

/* --- relationships between the student's own files ------------------------- */

/* File CSV/Parquet/JSON khong luu khoa ngoai, nen so do ERD o Thuc hanh SQL phai
 * SUY RA quan he. Hai buoc, ca hai chay trong trinh duyet:
 *
 *   1. matchByName (ham thuan, test duoc bang Node): cot nao TRONG GIONG khoa
 *      cua mot bang khac. `orders.customer_id` -> `customers.id`,
 *      `order_items.product_id` -> `products.product_id`.
 *   2. inferRelationships (trong createSandbox): kiem tra tren du lieu that -
 *      khoa chinh phai duy nhat va khong NULL, va >= 95% gia tri cua cot ben
 *      kia phai co trong khoa do. Ten giong nhau ma du lieu khong khop thi bo. */

/** Cot co ten trong nhu mot khoa: id, ..._id, ..._key, ..._code, ma_...
 *  (khong lay moi duoi "id": `paid`, `valid` khong phai khoa). */
export function isKeyish(column) {
  const c = String(column).toLowerCase();
  return c === 'id' || /(_id|_key|_code)$/.test(c) || c.startsWith('ma_');
}

/** Dang so it don gian cua mot ten bang tieng Anh; ten tieng Viet khong co so
 *  nhieu nen giu nguyen. */
function singular(word) {
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/(sses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Nhung goc ten ma mot cot `<goc>_id` co the tro toi bang nay: chinh ten,
 *  so it, va phan sau dau `_` cuoi (dim_customer -> customer). */
function stems(table) {
  const t = String(table).toLowerCase();
  const last = t.includes('_') ? t.slice(t.lastIndexOf('_') + 1) : t;
  return [...new Set([t, singular(t), last, singular(last)])].filter(Boolean);
}

/**
 * Ung vien quan he chi theo TEN. `tables`: [{ name, columns: [{name}], pk }],
 * `pk` la ten cot khoa chinh da kiem chung (hoac null). Tra ve
 * [{ from, col, to, toCol }], khong co canh tu tro, khong trung.
 */
export function matchByName(tables) {
  const out = [];
  const seen = new Set();
  for (const t of tables) {
    for (const { name: col } of t.columns) {
      const c = col.toLowerCase();
      // Khoa chinh cua chinh no khong phai khoa ngoai; `id` tran thi khong noi
      // duoc toi bang nao mot cach chac chan.
      if (c === 'id' || (t.pk && c === t.pk.toLowerCase())) continue;
      for (const u of tables) {
        if (u === t || !u.pk) continue;
        const k = u.pk.toLowerCase();
        const byPk = c === k;
        const byStem = k === 'id' && stems(u.name).some((s) => c === `${s}_id`);
        if (!byPk && !byStem) continue;
        const key = `${t.name}.${col}->${u.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ from: t.name, col, to: u.name, toCol: u.pk });
      }
    }
  }
  return out;
}

/** Dinh danh SQL an toan cho ten lay tu file cua hoc vien. */
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

/* --- engine ---------------------------------------------------------------- */

let bootPromise = null;

/** Load the engine on first use, never at page load.
 *
 * The wasm is ~33 MB. Paying that on every page load — for every student who
 * only ever uses the console — is the reason this is lazy. It is served from
 * our own origin, and `backend/main.py` lets /vendor/** be cached, so it is one
 * fetch per browser and then nothing.
 *
 * Cai "va roi khong gi nua" do la MOI CO. Truoc day middleware dong `no-store`
 * len moi phan hoi, ke ca file nay, nen 34 MB duoc tai lai MOI LAN vao khu vuc:
 * 11,2 giay do qua duong ham, va trong 11 giay do `addFile` dung cho o day nen
 * cu tha file trong nhu khong co gi xay ra.
 */
function boot(onStatus) {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    onStatus?.({ text: 'Đang tải công cụ SQL…' });

    // Hoi truoc kich thuoc THAT cua engine.
    //
    // Bo dem cua DuckDB tra `bytesTotal` lay tu `Content-Length`, tuc la so byte
    // DA NEN (7,3 MB), trong khi `bytesLoaded` dem byte da giai nen (toi 32,7 MB)
    // vi trinh duyet giai nen trong suot. Chia hai so do cho nhau thi thanh tien
    // trinh len 100% o goi dau tien roi dung im suot ca lan tai - te hon la khong
    // co thanh nao, vi no noi doi thay vi im lang.
    //
    // Mot yeu cau HEAD (~30ms) doi lay mot con so dung. Neu may chu khong gui
    // header do (ban khong nen, hoac ban cu) thi de `undefined` va thanh chuyen
    // sang dang chay vo dinh - van thanh that.
    let engineBytes;
    try {
      const head = await fetch(new URL(WASM_URL, import.meta.url), { method: 'HEAD' });
      engineBytes =
        Number(head.headers.get('x-uncompressed-length')) ||
        Number(head.headers.get('content-length')) ||
        undefined;
    } catch (_) {
      /* khong sao: khong biet tong thi chay vo dinh */
    }

    const duckdb = await import(LOADER_URL);

    // Constructed from a same-origin file, NOT a Blob URL. The usual
    // DuckDB-WASM recipe wraps the worker in a Blob, which would force
    // `worker-src blob:` into the CSP; backend/config.py pins that it must
    // not. Keep this as a plain URL. A test asserts the header.
    const worker = new Worker(new URL(WORKER_URL, import.meta.url));
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    // Tham so thu ba la callback tien trinh - co san trong ban vendor, nen phan
    // tram khong ton them mot byte tai nao. Thieu no thi 34 MB troi qua sau mot
    // vong quay cam, va nguoi dung khong biet minh dang cho cai gi.
    await db.instantiate(
      new URL(WASM_URL, import.meta.url).toString(),
      null,
      (p) => {
        const loaded = Number(p?.bytesLoaded) || 0;
        // `engineBytes` (do HEAD hoi duoc) chu KHONG phai `p.bytesTotal` - xem
        // giai thich o tren. Chi roi ve bytesTotal khi khong hoi duoc gi.
        const total = engineBytes || Number(p?.bytesTotal) || undefined;
        onStatus?.({ text: 'Đang tải công cụ SQL', loaded, total });
      }
    );

    const conn = await db.connect();
    onStatus?.({ text: '' });
    return { duckdb, db, conn };
  })().catch((err) => {
    bootPromise = null; // a failed boot must not poison every later attempt
    throw err;
  });
  return bootPromise;
}

/* --- Arrow -> the shape results.js already understands ---------------------- */

/** Arrow type -> the DuckDB type name format.js keys its formatting off. */
function typeName(field) {
  const t = String(field.type);
  // Arrow's toString is close enough to DuckDB's names for format.js's
  // purposes; normalise the few that differ so numbers still right-align and
  // dates still get the temporal colour.
  const map = {
    Utf8: 'VARCHAR',
    LargeUtf8: 'VARCHAR',
    Bool: 'BOOLEAN',
    Int8: 'TINYINT', Int16: 'SMALLINT', Int32: 'INTEGER', Int64: 'BIGINT',
    Uint8: 'UTINYINT', Uint16: 'USMALLINT', Uint32: 'UINTEGER', Uint64: 'UBIGINT',
    Float32: 'FLOAT', Float64: 'DOUBLE',
    Binary: 'BLOB', LargeBinary: 'BLOB',
  };
  if (map[t]) return map[t];
  if (/^Date/.test(t)) return 'DATE';
  if (/^Timestamp/.test(t)) return 'TIMESTAMP';
  if (/^Time/.test(t)) return 'TIME';
  if (/^Decimal/.test(t)) return t.replace(/^Decimal/, 'DECIMAL');
  if (/^List/.test(t)) return 'LIST';
  if (/^Struct/.test(t)) return 'STRUCT';
  if (/^Map/.test(t)) return 'MAP';
  return t.toUpperCase();
}

/** One Arrow cell -> a value formatCell() can render without losing digits. */
function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    // The same contract api.js uses for BIGINT off the wire: digits as text, so
    // nothing is ever rounded on the way to the screen or the CSV.
    return { __exactDigits: v.toString() };
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null; // NaN / Infinity render as NULL, as on the server
  }
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '');
  if (ArrayBuffer.isView(v)) return `\\x${Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (typeof v === 'object') {
    // Arrow Vector rows (LIST/STRUCT) expose toJSON / toArray.
    if (typeof v.toJSON === 'function') return normaliseJson(v.toJSON());
    if (typeof v.toArray === 'function') return Array.from(v.toArray(), cellValue);
    return normaliseJson(v);
  }
  return String(v);
}

function normaliseJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return { __exactDigits: v.toString() };
  if (Array.isArray(v)) return v.map(normaliseJson);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = normaliseJson(v[k]);
    return out;
  }
  return v;
}

function arrowToResult(table, elapsedMs, sql) {
  const fields = table.schema.fields;
  const columns = fields.map((f) => f.name);
  const columnTypes = fields.map(typeName);

  const total = table.numRows;
  const wanted = Math.min(total, DOWNLOAD_LIMIT);
  const all = new Array(wanted);
  let i = 0;
  for (const row of table) {
    if (i >= wanted) break;
    const out = new Array(columns.length);
    for (let c = 0; c < columns.length; c += 1) out[c] = cellValue(row[columns[c]]);
    all[i] = out;
    i += 1;
  }

  return {
    columns,
    column_types: columnTypes,
    rows: all.slice(0, RENDER_LIMIT),
    row_count: Math.min(total, RENDER_LIMIT),
    row_limit: RENDER_LIMIT,
    truncated: total > RENDER_LIMIT,
    elapsed_ms: elapsedMs,
    executed_sql: sql,
    tables_used: [],
    // Not part of the results.js contract; the sandbox panel uses them for the
    // download and for an honest "you are looking at N of M" line.
    _allRows: all,
    _totalRows: total,
    _downloadTruncated: total > DOWNLOAD_LIMIT,
  };
}

/* --- public surface --------------------------------------------------------- */

/** Doc mot File thanh Uint8Array, co bao tien trinh.
 *
 * `file.arrayBuffer()` don gian hon nhung KHONG bao duoc gi: voi mot parquet
 * 300 MB no im lang vai giay roi tra ve mot cuc.
 *
 * Cap phat DUNG MOT lan theo `file.size` roi do tung khoi vao. Khong day tung
 * khoi vao mang roi noi lai o cuoi: lam the la giu hai ban sao cung luc, va
 * dung cai dieu ma khoi CREATE VIEW ben duoi cat cong tranh.
 */
async function readWithProgress(file, report) {
  if (!file.stream) return new Uint8Array(await file.arrayBuffer());
  const out = new Uint8Array(file.size);
  const reader = file.stream().getReader();
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // File co the dai hon `size` neu no bi ghi de giua chung. Cat cho vua o
    // dem thay vi de `set()` nem RangeError voi mot thong bao khong ai hieu.
    const chunk = at + value.length > out.length ? value.subarray(0, out.length - at) : value;
    out.set(chunk, at);
    at += chunk.length;
    report(at);
    if (at >= out.length) break;
  }
  return at === out.length ? out : out.subarray(0, at);
}

export function createSandbox({ onStatus } = {}) {
  /** name -> { table, file, rows, columns } */
  const registered = new Map();

  async function addFile(file, tag = '') {
    const reader = readerFor(file.name);
    if (!reader) {
      throw new Error(
        `Chưa đọc được "${file.name}". Định dạng nhận được: ` +
          ACCEPTED_EXTENSIONS.join(', ') +
          '. (Excel .xlsx không đọc được ngoại tuyến — hãy Lưu dưới dạng CSV.)'
      );
    }
    // Bao ten file TRUOC khi cho engine. Truoc day boot() dung o day va suot
    // thoi gian tai engine nguoi dung khong co bang chung nao rang cu tha file
    // cua minh duoc ghi nhan.
    onStatus?.({ text: `Chuẩn bị ${file.name}${tag}` });
    const { db, conn } = await boot(onStatus);

    const name = tableNameFor(file.name, new Set(registered.keys()));
    const vpath = `${name}__${file.name}`;
    const bytes = await readWithProgress(file, (loaded) =>
      onStatus?.({ text: `Đang đọc ${file.name}${tag}`, loaded, total: file.size })
    );
    onStatus?.({ text: `Đang tạo bảng từ ${file.name}${tag}…` });
    await db.registerFileBuffer(vpath, bytes);

    // A VIEW, not a CREATE TABLE: the bytes stay in the registered buffer
    // instead of being copied into the engine a second time. For a 300 MB
    // parquet that is the difference between working and running out of memory.
    await conn.query(`CREATE OR REPLACE VIEW "${name}" AS SELECT * FROM ${reader.fn(vpath)}`);

    const info = await conn.query(`SELECT count(*) AS n FROM "${name}"`);
    const rows = Number(info.get(0).n);
    const desc = await conn.query(`DESCRIBE "${name}"`);
    const columns = Array.from(desc, (r) => ({
      name: String(r.column_name),
      type: String(r.column_type),
    }));

    registered.set(name, { table: name, file: file.name, rows, columns });
    onStatus?.({ text: '' });
    return registered.get(name);
  }

  async function addFiles(fileList) {
    const added = [];
    const failed = [];
    const files = Array.from(fileList);
    // Tuan tu, khong song song: hai file cung goi registerFileBuffer se tranh
    // nhau bo nho cua engine. Doi lai phai noi ro dang o file thu may, khong thi
    // nap ba file trong nhu treo giua chung.
    const tag = files.length > 1 ? (i) => ` (${i + 1}/${files.length})` : () => '';
    for (const [i, file] of files.entries()) {
      try {
        added.push(await addFile(file, tag(i)));
      } catch (err) {
        failed.push({ file: file.name, message: err?.message || String(err) });
      }
    }
    return { added, failed };
  }

  async function run(sql) {
    if (!registered.size) {
      throw new Error('Chưa có file nào. Kéo một file CSV/Parquet/JSON vào đây trước.');
    }
    const { conn } = await boot(onStatus);
    const t0 = performance.now();
    const table = await conn.query(sql);
    const elapsed = performance.now() - t0;
    return arrowToResult(table, elapsed, sql);
  }

  async function drop(name) {
    if (!registered.has(name)) return;
    const { conn } = await boot(onStatus);
    await conn.query(`DROP VIEW IF EXISTS "${name}"`);
    registered.delete(name);
  }

  async function reset() {
    if (!bootPromise) {
      registered.clear();
      return;
    }
    const { conn } = await boot(onStatus);
    for (const name of Array.from(registered.keys())) {
      await conn.query(`DROP VIEW IF EXISTS "${name}"`);
    }
    registered.clear();
  }

  /**
   * So do ERD cua cac file da nap: bang, khoa chinh suy ra, quan he suy ra.
   * Cung hinh dang voi GET /schema/game de erd.js ve duoc ma khong biet nguon.
   * Chi doc (SELECT tren cac view da dang ky), khong goi may chu.
   */
  async function inferRelationships() {
    const list = Array.from(registered.values());
    if (!list.length) return { tables: [], relationships: [] };
    const { conn } = await boot(onStatus);
    const MAX_CHECKS = 200;
    let checks = 0;

    // 1. Khoa chinh: trong cac cot trong giong khoa, cot nao duy nhat va khong NULL.
    const withPk = [];
    for (const t of list) {
      const cands = t.columns.map((c) => c.name).filter(isKeyish).slice(0, 8);
      let pk = null;
      if (cands.length && checks < MAX_CHECKS) {
        checks += 1;
        try {
          const parts = cands.map(
            (c, i) => `count(DISTINCT ${ident(c)}) AS d${i}, count(${ident(c)}) AS n${i}`
          );
          const r = (await conn.query(`SELECT count(*) AS total, ${parts.join(', ')} FROM ${ident(t.table)}`)).get(0);
          const total = Number(r.total);
          const unique = cands.filter((_, i) => total > 0 && Number(r[`d${i}`]) === total && Number(r[`n${i}`]) === total);
          const lower = (s) => s.toLowerCase();
          pk =
            unique.find((c) => lower(c) === 'id') ||
            unique.find((c) => stems(t.table).some((s) => lower(c) === `${s}_id`)) ||
            unique[0] ||
            null;
        } catch (_) {
          pk = null; // mot bang loi khong lam hong ca so do
        }
      }
      withPk.push({ name: t.table, columns: t.columns, pk });
    }

    // 2. Ghep theo ten, roi 3. giu canh nao du lieu xac nhan (>= 95% khop).
    const edges = [];
    for (const m of matchByName(withPk)) {
      if (checks >= MAX_CHECKS) break;
      checks += 1;
      try {
        const r = (
          await conn.query(
            `SELECT count(${ident(m.col)}) AS total, ` +
              `count(*) FILTER (WHERE ${ident(m.col)} IS NOT NULL AND ${ident(m.col)} NOT IN ` +
              `(SELECT ${ident(m.toCol)} FROM ${ident(m.to)} WHERE ${ident(m.toCol)} IS NOT NULL)) AS miss ` +
              `FROM ${ident(m.from)}`
          )
        ).get(0);
        const total = Number(r.total);
        const miss = Number(r.miss);
        if (total > 0 && (total - miss) / total >= 0.95) {
          edges.push({
            from_table: m.from,
            from_columns: [m.col],
            to_table: m.to,
            to_columns: [m.toCol],
            inferred: true,
          });
        }
      } catch (_) {
        /* kieu du lieu khong so duoc (so voi chu): khong phai quan he */
      }
    }

    return {
      tables: withPk.map((t) => ({
        name: t.name,
        kind: 'table',
        columns: t.columns.map((c) => ({ name: c.name, type: c.type, primary_key: c.name === t.pk })),
      })),
      relationships: edges,
      note:
        'File không lưu khoá ngoại; các quan hệ nét đứt được suy ra từ tên cột và kiểm tra trên ' +
        'chính dữ liệu của bạn (từ 95% giá trị khớp trở lên). Mọi thứ chạy trên máy bạn.',
    };
  }

  /** A starter query built from whatever is actually loaded — never a
   *  hardcoded table name, for the same reason the console never hardcodes
   *  one: the names must come from the data in front of the student. */
  function starterSql() {
    const first = registered.values().next().value;
    if (!first) return '';
    return `SELECT *\nFROM ${first.table}\nLIMIT 100;`;
  }

  return {
    addFiles,
    run,
    drop,
    reset,
    starterSql,
    inferRelationships,
    tables: () => Array.from(registered.values()),
    isBooted: () => bootPromise !== null,
  };
}
