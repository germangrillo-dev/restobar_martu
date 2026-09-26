const fs = require("fs");
const path = require("path");
const db = require("./db");

const BACKUP_DIR = path.join(__dirname, "data", "backups");
const MAX_BACKUPS = 30;
const INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 horas

let backupTimer = null;

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function fechaBackup() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
}

async function crearBackup(origen) {
  ensureBackupDir();
  const nombre = `martu-${fechaBackup()}.db`;
  const dest = path.join(BACKUP_DIR, nombre);
  try {
    await db.backupDB(dest);
    console.log(`[BACKUP] ${origen}: ${nombre}`);
    limpiarBackupsViejos();
    copiarADrive(dest, nombre);
    return { ok: true, archivo: nombre };
  } catch (e) {
    console.error(`[BACKUP] Error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

function copiarADrive(src, nombre) {
  try {
    const dir = db.getConfig ? db.getConfig().backupDriveDir : null;
    if (!dir || typeof dir !== "string" || !dir.trim()) return;
    const driveDir = dir.trim();
    if (!fs.existsSync(driveDir)) { console.log(`[BACKUP] Carpeta Drive no existe: ${driveDir}`); return; }
    fs.copyFileSync(src, path.join(driveDir, nombre));
    console.log(`[BACKUP] Copiado a Drive: ${path.join(driveDir, nombre)}`);
  } catch (e) {
    console.error(`[BACKUP] Error copiando a Drive: ${e.message}`);
  }
}

function limpiarBackupsViejos() {
  ensureBackupDir();
  const archivos = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("martu-") && f.endsWith(".db"))
    .sort()
    .reverse();
  for (const f of archivos.slice(MAX_BACKUPS)) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`[BACKUP] Borrado: ${f}`);
  }
}

function listarBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith("martu-") && f.endsWith(".db"))
    .sort()
    .reverse()
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { nombre: f, fecha: stat.mtime, tamaño: stat.size };
    });
}

function restaurarBackup(nombre) {
  const src = path.join(BACKUP_DIR, nombre);
  if (!fs.existsSync(src)) return { ok: false, error: "Archivo no encontrado" };
  const dbPath = path.join(__dirname, "data", "martu.db");
  try {
    // Backup del actual antes de restaurar
    crearBackup("pre-restauración");
    db.closeDB();
    fs.copyFileSync(src, dbPath);
    console.log(`[BACKUP] Restaurado: ${nombre}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function iniciarBackupsAutomaticos() {
  console.log(`[BACKUP] Backups automáticos cada ${INTERVAL_MS / 3600000}h`);
  backupTimer = setInterval(() => crearBackup("automático"), INTERVAL_MS);
}

function detenerBackups() {
  if (backupTimer) clearInterval(backupTimer);
}

module.exports = {
  crearBackup,
  listarBackups,
  restaurarBackup,
  iniciarBackupsAutomaticos,
  detenerBackups
};
