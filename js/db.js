// ---------------------------------------------------------------
// db.js — the entire "backend" of this app, running in-browser via
// sql.js (real SQLite compiled to WebAssembly). No server, no
// network calls (except loading fonts). Persists to IndexedDB.
// ---------------------------------------------------------------
const DB = (function () {
  "use strict";

  const IDB_NAME = "ledger-app-db";
  const IDB_STORE = "sqlite";
  const IDB_KEY = "database-file";

  let sql = null; // SQL.js module
  let db = null; // active sqlite Database instance

  // -----------------------------------------------------------
  // IndexedDB persistence (auto-save/load the whole sqlite file)
  // -----------------------------------------------------------
  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbLoad() {
    const idb = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSave(uint8array) {
    const idb = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(uint8array, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function persist() {
    const bytes = db.export(); // Uint8Array snapshot of the whole database
    await idbSave(bytes);
  }

  // -----------------------------------------------------------
  // Schema
  // -----------------------------------------------------------
  const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_date TEXT NOT NULL,
      client_name TEXT NOT NULL,
      amount_usd REAL NOT NULL DEFAULT 0,
      amount_eur REAL NOT NULL DEFAULT 0,
      amount_rub REAL NOT NULL DEFAULT 0,
      amount_tl REAL NOT NULL DEFAULT 0,
      amount_transferred_tl REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rates (
      currency_code TEXT PRIMARY KEY,
      rate_to_usd REAL NOT NULL
    );

    -- Every accepted edit to an entry (via the Data tab's row editor) is
    -- logged here: which field, what it was, what it became, and when.
    -- This is what powers the "entry details" popup's change history.
    CREATE TABLE IF NOT EXISTS entry_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_entry_history_entry_id ON entry_history(entry_id);

    DROP VIEW IF EXISTS entries_computed;
    CREATE VIEW entries_computed AS
    SELECT
      e.*,
      e.amount_usd
        + e.amount_eur * (SELECT rate_to_usd FROM rates WHERE currency_code = 'EUR')
        + e.amount_rub * (SELECT rate_to_usd FROM rates WHERE currency_code = 'RUB')
        + (e.amount_tl + e.amount_transferred_tl) * (SELECT rate_to_usd FROM rates WHERE currency_code = 'TL')
        AS converted_total_usd,
      date(e.entry_date, '-' || ((CAST(strftime('%w', e.entry_date) AS INTEGER) + 6) % 7) || ' days')
        AS week_start_date
    FROM entries e;
  `;
  const DEFAULT_RATES = [
    ["EUR", 1.08],
    ["RUB", 0.011],
    ["TL", 0.029],
  ];

  function seedRatesIfEmpty() {
    const res = db.exec("SELECT COUNT(*) FROM rates");
    const count = res[0].values[0][0];
    if (count === 0) {
      const stmt = db.prepare("INSERT INTO rates (currency_code, rate_to_usd) VALUES (?, ?)");
      DEFAULT_RATES.forEach(([code, rate]) => stmt.run([code, rate]));
      stmt.free();
    }
  }

  // -----------------------------------------------------------
  // Init
  // -----------------------------------------------------------
  async function init() {
    // Decode the embedded base64 wasm into raw bytes -- no fetch involved,
    // so this works identically whether the page is opened via file:// or http(s).
    const binary = Uint8Array.from(atob(SQL_WASM_BASE64), (c) => c.charCodeAt(0));
    sql = await initSqlJs({ wasmBinary: binary.buffer });

    const saved = await idbLoad();
    db = saved ? new sql.Database(new Uint8Array(saved)) : new sql.Database();
    db.run(SCHEMA_SQL);
    seedRatesIfEmpty();
    await persist();
  }

  // -----------------------------------------------------------
  // Query helpers
  // -----------------------------------------------------------
  function queryAll(sqlText, params) {
    const stmt = db.prepare(sqlText);
    if (params) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  function run(sqlText, params) {
    db.run(sqlText, params || []);
  }

  // -----------------------------------------------------------
  // Entries
  // -----------------------------------------------------------
  const CURRENCY_COLUMN_MAP = {
    USD: "amount_usd",
    EUR: "amount_eur",
    RUB: "amount_rub",
    TL: "amount_tl",
    TRANSFERRED_TL: "amount_transferred_tl",
  };
  const EDITABLE_FIELDS = [
    "entry_date", "client_name", "amount_usd", "amount_eur", "amount_rub", "amount_tl", "amount_transferred_tl",
  ];
  const TEXT_FIELDS = new Set(["entry_date", "client_name"]);

  async function insertEntry({ entry_date, client_name, currency, amount }) {
    const col = CURRENCY_COLUMN_MAP[currency];
    if (!col) throw new Error("Unknown currency: " + currency);
    run(`INSERT INTO entries (entry_date, client_name, ${col}) VALUES (?, ?, ?)`, [entry_date, client_name, amount]);
    await persist();
  }

  /**
   * One submission, one row: `amounts` is e.g. { USD: 100, TL: 4000 } and every
   * currency present lands in its own column on a single new row -- this is
   * what makes a multi-currency submission a single ledger entry, not several.
   * `created_at` is stamped automatically by the column default below.
   */
  async function insertEntryMulti({ entry_date, client_name, amounts }) {
    const cols = ["entry_date", "client_name"];
    const placeholders = ["?", "?"];
    const values = [entry_date, client_name];
    Object.entries(amounts).forEach(([code, amount]) => {
      const col = CURRENCY_COLUMN_MAP[code];
      if (!col) throw new Error("Unknown currency: " + code);
      cols.push(col);
      placeholders.push("?");
      values.push(amount);
    });
    run(`INSERT INTO entries (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`, values);
    await persist();
  }

  /**
   * Applies a batch of field edits to one entry in a single transaction-like
   * pass, comparing each proposed value against what's currently stored.
   * Only fields that actually changed are written and logged to
   * entry_history -- editing a row and hitting save without touching a
   * field never produces a no-op history entry. Returns the list of field
   * names that were actually changed (empty array if nothing changed).
   */
  async function saveEntryChanges(id, changes) {
    const fields = Object.keys(changes || {});
    if (!fields.length) return [];
    fields.forEach((field) => {
      if (!EDITABLE_FIELDS.includes(field)) throw new Error("Field not editable: " + field);
    });

    const rows = queryAll("SELECT * FROM entries WHERE id = ?", [id]);
    if (!rows.length) return [];
    const current = rows[0];

    const changedFields = [];
    fields.forEach((field) => {
      const oldValue = current[field];
      const newValue = changes[field];
      const isChanged = TEXT_FIELDS.has(field)
        ? String(oldValue == null ? "" : oldValue) !== String(newValue == null ? "" : newValue)
        : Number(oldValue) !== Number(newValue);
      if (!isChanged) return;

      run(
        "INSERT INTO entry_history (entry_id, field, old_value, new_value) VALUES (?, ?, ?, ?)",
        [id, field, oldValue == null ? "" : String(oldValue), newValue == null ? "" : String(newValue)]
      );
      run(`UPDATE entries SET ${field} = ? WHERE id = ?`, [newValue, id]);
      changedFields.push(field);
    });

    if (changedFields.length) await persist();
    return changedFields;
  }

  // Kept for a single-field edit; delegates to saveEntryChanges so every
  // write path shares the same change-detection and history logging.
  async function updateEntryField(id, field, value) {
    const changed = await saveEntryChanges(id, { [field]: value });
    return changed.length > 0;
  }

  async function deleteEntry(id) {
    run("DELETE FROM entries WHERE id = ?", [id]);
    run("DELETE FROM entry_history WHERE entry_id = ?", [id]);
    await persist();
  }

  async function insertBlankEntry() {
    const now = new Date();
    // Local-date components (not toISOString, which goes through UTC and can
    // shift the date near midnight in timezones ahead of/behind UTC).
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    run("INSERT INTO entries (entry_date, client_name, amount_usd) VALUES (?, ?, 0)", [iso, ""]);
    // last_insert_rowid() must be read BEFORE persist(): sql.js's db.export()
    // (which persist() calls) resets it to 0 as a side effect, so reading it
    // afterward always returned 0 -- meaning "Add row" could never actually
    // open its new row in edit mode. Capture the id first, persist after.
    const res = queryAll("SELECT last_insert_rowid() AS id");
    const newId = res[0].id;
    await persist();
    return newId;
  }

  function listEntries() {
    return queryAll("SELECT * FROM entries_computed ORDER BY entry_date DESC, id DESC");
  }

  /** All entries in one ISO week, newest first -- used for the dashboard's
   *  per-client breakdown panel. */
  function getWeekEntries(weekStart) {
    return queryAll(
      "SELECT * FROM entries_computed WHERE week_start_date = ? ORDER BY entry_date DESC, id DESC",
      [weekStart]
    );
  }

  /** Full edit history for one entry, most recent change first. */
  function getEntryHistory(id) {
    return queryAll("SELECT * FROM entry_history WHERE entry_id = ? ORDER BY id DESC, changed_at DESC", [id]);
  }

  // -----------------------------------------------------------
  // Rates
  // -----------------------------------------------------------
  function listRates() {
    return queryAll("SELECT * FROM rates ORDER BY currency_code");
  }
  async function updateRate(code, rate) {
    run("UPDATE rates SET rate_to_usd = ? WHERE currency_code = ?", [rate, code]);
    await persist();
  }

  // -----------------------------------------------------------
  // Dashboard: weekly buckets, oldest first, current week last
  // -----------------------------------------------------------
  function getDashboardWeeks() {
    const rows = queryAll(`
      SELECT entry_date, week_start_date, converted_total_usd
      FROM entries_computed
      ORDER BY entry_date ASC
    `);
    const weekMap = {};
    rows.forEach((row) => {
      const key = row.week_start_date;
      if (!weekMap[key]) {
        const start = new Date(key + "T00:00:00");
        const end = new Date(start);
        end.setDate(end.getDate() + 6);
        weekMap[key] = {
          week_start: key,
          week_end: end.toISOString().slice(0, 10),
          days: [0, 0, 0, 0, 0, 0, 0],
          total: 0,
        };
      }
      const d = new Date(row.entry_date + "T00:00:00");
      const dayIdx = (d.getDay() + 6) % 7;
      weekMap[key].days[dayIdx] += row.converted_total_usd;
      weekMap[key].total += row.converted_total_usd;
    });
    return Object.values(weekMap).sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
  }

  /**
   * Per-week raw currency sums (not converted), keyed by week_start_date.
   * Used for the dashboard's always-visible per-currency breakdown line
   * under each week's total. Shape matches an entries row, so the same
   * buildAmountTags() formatter used for individual rows can be reused
   * as-is for a week's totals.
   */
  function getWeeklyCurrencyTotals() {
    const rows = queryAll(`
      SELECT
        week_start_date,
        SUM(amount_usd) AS amount_usd,
        SUM(amount_eur) AS amount_eur,
        SUM(amount_rub) AS amount_rub,
        SUM(amount_tl) AS amount_tl,
        SUM(amount_transferred_tl) AS amount_transferred_tl
      FROM entries_computed
      GROUP BY week_start_date
    `);
    const map = {};
    rows.forEach((row) => (map[row.week_start_date] = row));
    return map;
  }

  // -----------------------------------------------------------
  // Sharing / downloading exported files
  //
  // On Android and iOS, a plain <a download> click silently drops the
  // file into the Downloads folder with no way to pick "Google Drive"
  // or "Save to Files" directly -- and inside some embedded WebViews
  // (e.g. a bare Capacitor/Cordova wrapper with no filesystem plugin)
  // it can do nothing at all. The Web Share API's file-sharing mode is
  // what lets a user tap "Export backup" and hand the file straight to
  // Google Drive, Gmail, WhatsApp, Files, etc. We try that first and
  // only fall back to the anchor-download trick when it isn't
  // available or fails (which is also exactly what happens on desktop
  // browsers, where a normal download is what people expect anyway).
  // -----------------------------------------------------------
  async function shareOrDownload(filename, blob, meta) {
    try {
      if (navigator.canShare && navigator.share) {
        const file = new File([blob], filename, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: (meta && meta.title) || filename,
            text: (meta && meta.text) || undefined,
          });
          return { method: "share" };
        }
      }
    } catch (err) {
      if (err && err.name === "AbortError") return { method: "cancelled" };
      // Any other share failure (permissions, odd WebView, etc.) falls
      // through to the plain download below rather than surfacing an error.
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke slightly later: some browsers need the blob URL to stay valid
    // a little past the synchronous click for the download to actually start.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { method: "download" };
  }

  // -----------------------------------------------------------
  // CSV export
  // -----------------------------------------------------------
  function toCsv(rows, columns) {
    const esc = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = columns.join(",");
    const lines = rows.map((r) => columns.map((c) => esc(r[c])).join(","));
    return [header, ...lines].join("\n");
  }
  async function exportEntriesCsv(meta) {
    const rows = listEntries();
    const cols = [
      "id", "entry_date", "client_name", "amount_usd", "amount_eur", "amount_rub",
      "amount_tl", "amount_transferred_tl", "converted_total_usd", "week_start_date", "created_at",
    ];
    const blob = new Blob([toCsv(rows, cols)], { type: "text/csv;charset=utf-8" });
    return shareOrDownload("entries.csv", blob, meta);
  }
  async function exportRatesCsv(meta) {
    const blob = new Blob([toCsv(listRates(), ["currency_code", "rate_to_usd"])], { type: "text/csv;charset=utf-8" });
    return shareOrDownload("rates.csv", blob, meta);
  }

  // -----------------------------------------------------------
  // Full .sqlite backup export / import
  // -----------------------------------------------------------
  const SQLITE_MAGIC = "SQLite format 3\u0000";

  function looksLikeSqliteFile(bytes) {
    if (!bytes || bytes.length < SQLITE_MAGIC.length) return false;
    for (let i = 0; i < SQLITE_MAGIC.length; i++) {
      if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
    }
    return true;
  }

  async function exportSqliteFile(meta) {
    const bytes = db.export();
    const blob = new Blob([bytes], { type: "application/x-sqlite3" });
    return shareOrDownload("ledger-backup.sqlite", blob, meta);
  }

  async function importSqliteFile(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (!looksLikeSqliteFile(bytes)) {
      const err = new Error("Not a valid .sqlite file");
      err.code = "INVALID_SQLITE_FILE";
      throw err;
    }

    let next;
    try {
      next = new sql.Database(bytes);
      // Touch the database so a file with the right magic bytes but garbage
      // contents past the header still fails here, inside the try block.
      next.exec("PRAGMA schema_version");
    } catch (e) {
      const err = new Error("Not a valid .sqlite file");
      err.code = "INVALID_SQLITE_FILE";
      throw err;
    }

    db = next;
    db.run(SCHEMA_SQL); // no-op for tables/view already present, adds any that are missing
    await persist();
  }

  return {
    init,
    insertEntry,
    insertEntryMulti,
    updateEntryField,
    saveEntryChanges,
    deleteEntry,
    insertBlankEntry,
    listEntries,
    getWeekEntries,
    getEntryHistory,
    listRates,
    updateRate,
    getDashboardWeeks,
    getWeeklyCurrencyTotals,
    exportEntriesCsv,
    exportRatesCsv,
    exportSqliteFile,
    importSqliteFile,
  };
})();
