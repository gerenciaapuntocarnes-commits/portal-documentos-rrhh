const express = require("express");
const multer  = require("multer");
const QRCode  = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const path    = require("path");
const fs      = require("fs");

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ─── Directorios y base de datos JSON ─────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, "uploads");
const DATA_DIR    = path.join(__dirname, "data");
const DB_FILE     = path.join(DATA_DIR, "documents.json");

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR,    { recursive: true });

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return []; }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ─── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  },
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

// Listar documentos
app.get("/api/docs", (req, res) => {
  let docs = readDB();
  const { cat, q } = req.query;
  if (cat && cat !== "todos") docs = docs.filter(d => d.categoria === cat);
  if (q) {
    const lq = q.toLowerCase();
    docs = docs.filter(d =>
      d.titulo.toLowerCase().includes(lq) ||
      (d.descripcion || "").toLowerCase().includes(lq)
    );
  }
  docs.sort((a, b) => a.categoria.localeCompare(b.categoria));
  res.json(docs);
});

// Obtener uno
app.get("/api/docs/:id", (req, res) => {
  const doc = readDB().find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: "Documento no encontrado" });
  res.json(doc);
});

// Subir nuevo documento
app.post("/api/docs", upload.single("archivo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió archivo o tipo no permitido" });
  const { titulo, descripcion, categoria, icono, version, fecha } = req.body;
  if (!titulo || !titulo.trim()) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "El título es requerido" });
  }
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
    created_at:    new Date().toISOString(),
  };
  const docs = readDB();
  docs.push(doc);
  writeDB(docs);
  res.status(201).json({ id: doc.id, message: "Documento creado" });
});

// Editar metadatos
app.patch("/api/docs/:id", (req, res) => {
  const docs = readDB();
  const idx  = docs.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Documento no encontrado" });
  const { titulo, descripcion, categoria, icono, version, fecha } = req.body;
  const doc = docs[idx];
  docs[idx] = {
    ...doc,
    titulo:      (titulo      || doc.titulo).trim(),
    descripcion: (descripcion !== undefined ? descripcion : doc.descripcion).trim(),
    categoria:   (categoria   || doc.categoria).trim(),
    icono:       icono        || doc.icono,
    version:     (version     || doc.version).trim(),
    fecha:       (fecha       || doc.fecha).trim(),
  };
  writeDB(docs);
  res.json({ message: "Documento actualizado" });
});

// Eliminar
app.delete("/api/docs/:id", (req, res) => {
  const docs = readDB();
  const doc  = docs.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: "Documento no encontrado" });
  const filePath = path.join(UPLOADS_DIR, doc.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  writeDB(docs.filter(d => d.id !== req.params.id));
  res.json({ message: "Documento eliminado" });
});

// Generar QR como PNG
app.get("/api/qr/:id", async (req, res) => {
  const doc = readDB().find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: "No encontrado" });
  const url  = `${BASE_URL}/ver.html?id=${doc.id}`;
  const size = Math.min(400, Math.max(64, parseInt(req.query.size) || 200));
  try {
    const buffer = await QRCode.toBuffer(url, {
      width: size, margin: 2,
      color: { dark: "#1e293b", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(buffer);
  } catch {
    res.status(500).json({ error: "Error generando QR" });
  }
});

// Descargar archivo
app.get("/api/docs/:id/download", (req, res) => {
  const doc = readDB().find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: "No encontrado" });
  const filePath = path.join(UPLOADS_DIR, doc.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Archivo no encontrado en disco" });
  res.download(filePath, doc.original_name || doc.filename);
});

// Config pública (empresa, baseUrl)
app.get("/api/config", (req, res) => {
  res.json({
    baseUrl: BASE_URL,
    empresa: process.env.EMPRESA || "Tu Empresa S.A.",
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Portal RRHH corriendo en http://localhost:${PORT}`);
});
