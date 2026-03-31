const express = require("express");
const multer  = require("multer");
const QRCode  = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const path    = require("path");
const fs      = require("fs");

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ─── Uploads ───────────────────────────────────────────────────────────────────
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Fallback JSON cuando no hay PostgreSQL (desarrollo local)
const JSON_DB = path.join(__dirname, "data", "documents.json");
const usePg = !!process.env.DATABASE_URL;

function readJSON() {
  try { return JSON.parse(fs.readFileSync(JSON_DB, "utf8")); } catch { return []; }
}
function writeJSON(data) {
  fs.mkdirSync(path.dirname(JSON_DB), { recursive: true });
  fs.writeFileSync(JSON_DB, JSON.stringify(data, null, 2));
}

async function initDB() {
  if (!usePg) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id            TEXT PRIMARY KEY,
      titulo        TEXT NOT NULL,
      descripcion   TEXT DEFAULT '',
      categoria     TEXT DEFAULT 'General',
      icono         TEXT DEFAULT '📄',
      version       TEXT DEFAULT 'v1.0',
      fecha         TEXT DEFAULT '',
      filename      TEXT NOT NULL,
      original_name TEXT,
      mimetype      TEXT,
      size          INTEGER,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS scans (
      id          SERIAL PRIMARY KEY,
      document_id TEXT NOT NULL,
      ip          TEXT,
      user_agent  TEXT,
      device      TEXT,
      scanned_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// ─── Helpers DB ────────────────────────────────────────────────────────────────
async function dbAll(cat, q) {
  if (usePg) {
    let sql = "SELECT * FROM documents WHERE 1=1";
    const params = [];
    if (cat && cat !== "todos") { params.push(cat); sql += ` AND categoria = $${params.length}`; }
    if (q) { params.push(`%${q}%`); sql += ` AND (titulo ILIKE $${params.length} OR descripcion ILIKE $${params.length})`; }
    sql += " ORDER BY categoria, created_at DESC";
    const { rows } = await pool.query(sql, params);
    return rows;
  }
  let docs = readJSON();
  if (cat && cat !== "todos") docs = docs.filter(d => d.categoria === cat);
  if (q) { const lq = q.toLowerCase(); docs = docs.filter(d => d.titulo.toLowerCase().includes(lq) || (d.descripcion||"").toLowerCase().includes(lq)); }
  return docs.sort((a,b) => a.categoria.localeCompare(b.categoria));
}

async function dbGet(id) {
  if (usePg) {
    const { rows } = await pool.query("SELECT * FROM documents WHERE id = $1", [id]);
    return rows[0] || null;
  }
  return readJSON().find(d => d.id === id) || null;
}

async function dbInsert(doc) {
  if (usePg) {
    await pool.query(
      `INSERT INTO documents (id,titulo,descripcion,categoria,icono,version,fecha,filename,original_name,mimetype,size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [doc.id, doc.titulo, doc.descripcion, doc.categoria, doc.icono, doc.version, doc.fecha,
       doc.filename, doc.original_name, doc.mimetype, doc.size]
    );
  } else {
    const docs = readJSON(); docs.push(doc); writeJSON(docs);
  }
}

async function dbUpdate(id, fields) {
  if (usePg) {
    await pool.query(
      `UPDATE documents SET titulo=$1, descripcion=$2, categoria=$3, icono=$4, version=$5, fecha=$6 WHERE id=$7`,
      [fields.titulo, fields.descripcion, fields.categoria, fields.icono, fields.version, fields.fecha, id]
    );
  } else {
    const docs = readJSON();
    const idx  = docs.findIndex(d => d.id === id);
    if (idx !== -1) { docs[idx] = { ...docs[idx], ...fields }; writeJSON(docs); }
  }
}

async function dbDelete(id) {
  if (usePg) {
    await pool.query("DELETE FROM documents WHERE id = $1", [id]);
  } else {
    writeJSON(readJSON().filter(d => d.id !== id));
  }
}

// ─── Scans ────────────────────────────────────────────────────────────────────
// Detectar tipo de dispositivo desde user-agent
function detectDevice(ua = "") {
  if (/android/i.test(ua))       return "Android";
  if (/iphone|ipad|ipod/i.test(ua)) return "iPhone/iPad";
  if (/windows phone/i.test(ua)) return "Windows Phone";
  if (/macintosh|mac os/i.test(ua)) return "Mac";
  if (/windows/i.test(ua))       return "Windows PC";
  if (/linux/i.test(ua))         return "Linux";
  return "Desconocido";
}

// Scans en JSON local (fallback)
const SCANS_FILE = path.join(__dirname, "data", "scans.json");
function readScans() { try { return JSON.parse(fs.readFileSync(SCANS_FILE, "utf8")); } catch { return []; } }
function writeScans(data) { fs.mkdirSync(path.dirname(SCANS_FILE), { recursive: true }); fs.writeFileSync(SCANS_FILE, JSON.stringify(data, null, 2)); }

async function dbLogScan(document_id, ip, user_agent, device) {
  if (usePg) {
    await pool.query(
      "INSERT INTO scans (document_id, ip, user_agent, device) VALUES ($1,$2,$3,$4)",
      [document_id, ip, user_agent, device]
    );
  } else {
    const scans = readScans();
    scans.push({ id: scans.length + 1, document_id, ip, user_agent, device, scanned_at: new Date().toISOString() });
    writeScans(scans);
  }
}

async function dbGetScans(document_id) {
  if (usePg) {
    const { rows } = await pool.query(
      "SELECT * FROM scans WHERE document_id = $1 ORDER BY scanned_at DESC LIMIT 200",
      [document_id]
    );
    return rows;
  }
  return readScans().filter(s => s.document_id === document_id).reverse().slice(0, 200);
}

async function dbGetScanStats() {
  if (usePg) {
    const { rows } = await pool.query(`
      SELECT s.document_id, d.titulo, d.icono, d.categoria,
             COUNT(*) AS total,
             MAX(s.scanned_at) AS last_scan
      FROM scans s
      LEFT JOIN documents d ON d.id = s.document_id
      GROUP BY s.document_id, d.titulo, d.icono, d.categoria
      ORDER BY total DESC
    `);
    return rows;
  }
  const scans = readScans();
  const docs  = readJSON();
  const map   = {};
  scans.forEach(s => {
    if (!map[s.document_id]) {
      const doc = docs.find(d => d.id === s.document_id) || {};
      map[s.document_id] = { document_id: s.document_id, titulo: doc.titulo || s.document_id, icono: doc.icono || "📄", categoria: doc.categoria || "", total: 0, last_scan: null };
    }
    map[s.document_id].total++;
    if (!map[s.document_id].last_scan || s.scanned_at > map[s.document_id].last_scan)
      map[s.document_id].last_scan = s.scanned_at;
  });
  return Object.values(map).sort((a, b) => b.total - a.total);
}

// ─── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "image/jpeg", "image/png", "image/webp",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Tipo de archivo no permitido"), false);
  },
});

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));

// ─── API ───────────────────────────────────────────────────────────────────────
app.get("/api/docs", async (req, res) => {
  try { res.json(await dbAll(req.query.cat, req.query.q)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/docs/:id", async (req, res) => {
  try {
    const doc = await dbGet(req.params.id);
    if (!doc) return res.status(404).json({ error: "Documento no encontrado" });
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/docs", upload.single("archivo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió archivo o tipo no permitido" });
  const { titulo, descripcion, categoria, icono, version, fecha } = req.body;
  if (!titulo?.trim()) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: "El título es requerido" }); }
  const doc = {
    id:            uuidv4(),
    titulo:        titulo.trim(),
    descripcion:   (descripcion || "").trim(),
    categoria:     (categoria || "General").trim(),
    icono:         icono || "📄",
    version:       (version || "v1.0").trim(),
    fecha:         (fecha || new Date().getFullYear().toString()).trim(),
    filename:      req.file.filename,
    original_name: req.file.originalname,
    mimetype:      req.file.mimetype,
    size:          req.file.size,
  };
  try { await dbInsert(doc); res.status(201).json({ id: doc.id }); }
  catch (e) { fs.unlinkSync(req.file.path); res.status(500).json({ error: e.message }); }
});

app.patch("/api/docs/:id", async (req, res) => {
  try {
    const doc = await dbGet(req.params.id);
    if (!doc) return res.status(404).json({ error: "Documento no encontrado" });
    const { titulo, descripcion, categoria, icono, version, fecha } = req.body;
    await dbUpdate(req.params.id, {
      titulo:      (titulo      || doc.titulo).trim(),
      descripcion: (descripcion !== undefined ? descripcion : doc.descripcion).trim(),
      categoria:   (categoria   || doc.categoria).trim(),
      icono:       icono        || doc.icono,
      version:     (version     || doc.version).trim(),
      fecha:       (fecha       || doc.fecha).trim(),
    });
    res.json({ message: "Documento actualizado" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/docs/:id", async (req, res) => {
  try {
    const doc = await dbGet(req.params.id);
    if (!doc) return res.status(404).json({ error: "Documento no encontrado" });
    const filePath = path.join(UPLOADS_DIR, doc.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await dbDelete(req.params.id);
    res.json({ message: "Documento eliminado" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/qr/:id", async (req, res) => {
  try {
    const doc = await dbGet(req.params.id);
    if (!doc) return res.status(404).json({ error: "No encontrado" });
    const size = Math.min(400, Math.max(64, parseInt(req.query.size) || 200));
    const buffer = await QRCode.toBuffer(`${BASE_URL}/ver.html?id=${doc.id}`, {
      width: size, margin: 2,
      color: { dark: "#1e293b", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
    res.set("Content-Type", "image/png").set("Cache-Control", "public, max-age=3600").send(buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/docs/:id/download", async (req, res) => {
  try {
    const doc = await dbGet(req.params.id);
    if (!doc) return res.status(404).json({ error: "No encontrado" });
    const filePath = path.join(UPLOADS_DIR, doc.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Archivo no encontrado en disco" });
    res.download(filePath, doc.original_name || doc.filename);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/config", (req, res) => {
  res.json({ baseUrl: BASE_URL, empresa: process.env.EMPRESA || "Tu Empresa S.A." });
});

// Registrar escaneo (llamado desde ver.html al cargar)
app.post("/api/scan/:id", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "—";
    const ua = req.headers["user-agent"] || "—";
    await dbLogScan(req.params.id, ip, ua, detectDevice(ua));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Historial de escaneos de un documento
app.get("/api/scan/:id", async (req, res) => {
  try { res.json(await dbGetScans(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Estadísticas globales de escaneos
app.get("/api/scan-stats", async (req, res) => {
  try { res.json(await dbGetScanStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Portal RRHH en http://localhost:${PORT} | DB: ${usePg ? "PostgreSQL" : "JSON local"}`);
  });
}).catch(err => {
  console.error("Error iniciando DB:", err.message);
  process.exit(1);
});
