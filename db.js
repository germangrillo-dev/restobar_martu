const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DB_DIR, "martu.db");

let db;

function initDB() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF");

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'cajero',
      clave TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS caja_sesiones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT NOT NULL,
      turno TEXT DEFAULT '',
      usuario TEXT DEFAULT '',
      apertura REAL DEFAULT 0,
      cierre REAL,
      saldo_final REAL,
      arqueo TEXT DEFAULT '{}',
      diff REAL,
      fecha_cierre TEXT,
      activa INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS movimientos (
      id TEXT PRIMARY KEY,
      sesion_id INTEGER REFERENCES caja_sesiones(id),
      tipo TEXT NOT NULL,
      concepto TEXT DEFAULT '',
      monto REAL NOT NULL DEFAULT 0,
      metodo TEXT DEFAULT '',
      hora TEXT DEFAULT '',
      ref TEXT DEFAULT '',
      usuario TEXT DEFAULT '',
      comprobante TEXT DEFAULT '',
      cae TEXT DEFAULT '',
      cae_vto TEXT DEFAULT '',
      afip_cbte INTEGER,
      afip_tipo TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS mesas (
      id INTEGER PRIMARY KEY,
      estado TEXT DEFAULT '{"lineas":[],"enviado":[],"despachado":[],"bebidas":[]}'
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      cliente TEXT DEFAULT '',
      direccion TEXT DEFAULT '',
      telefono TEXT DEFAULT '',
      cuit TEXT DEFAULT '',
      hora TEXT DEFAULT '',
      total REAL DEFAULT 0,
      estado TEXT DEFAULT 'cocina'
    );

    CREATE TABLE IF NOT EXISTS delivery_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT REFERENCES deliveries(id) ON DELETE CASCADE,
      pid TEXT DEFAULT '',
      nombre TEXT DEFAULT '',
      cant INTEGER DEFAULT 1,
      precio REAL DEFAULT 0,
      nota TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS productos (
      id TEXT PRIMARY KEY,
      ref INTEGER,
      cat TEXT DEFAULT '',
      nombre TEXT DEFAULT '',
      precio REAL DEFAULT 0,
      receta TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS insumos (
      id TEXT PRIMARY KEY,
      nombre TEXT DEFAULT '',
      unidad TEXT DEFAULT 'g',
      presentacion TEXT DEFAULT '',
      min REAL DEFAULT 0,
      unidad_compra TEXT DEFAULT 'g',
      factor_compra REAL DEFAULT 1,
      peso_bulto REAL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS stock (
      insumo_id TEXT PRIMARY KEY REFERENCES insumos(id),
      cantidad REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS costos (
      insumo_id TEXT PRIMARY KEY REFERENCES insumos(id),
      costo REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS proveedores (
      id TEXT PRIMARY KEY,
      nombre TEXT DEFAULT '',
      cuit TEXT DEFAULT '',
      condicion TEXT DEFAULT '',
      rubro TEXT DEFAULT '',
      direccion TEXT DEFAULT '',
      localidad TEXT DEFAULT '',
      telefono TEXT DEFAULT '',
      email TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS facturas (
      id TEXT PRIMARY KEY,
      proveedor TEXT DEFAULT '',
      tipo TEXT DEFAULT '',
      numero TEXT DEFAULT '',
      fecha TEXT DEFAULT '',
      total REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS factura_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      factura_id TEXT REFERENCES facturas(id) ON DELETE CASCADE,
      desc TEXT DEFAULT '',
      bulto TEXT DEFAULT '',
      cantidad REAL DEFAULT 0,
      ingreso REAL DEFAULT 0,
      insumo_un TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS contadores (
      key TEXT PRIMARY KEY,
      valor INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pedidos_whatsapp (
      id TEXT PRIMARY KEY,
      origen TEXT DEFAULT '',
      mesa INTEGER DEFAULT 0,
      remitente TEXT DEFAULT '',
      telefono TEXT DEFAULT '',
      nombre TEXT DEFAULT '',
      direccion TEXT DEFAULT '',
      items TEXT DEFAULT '[]',
      total REAL DEFAULT 0,
      hora TEXT DEFAULT '',
      leido INTEGER DEFAULT 0,
      enviado INTEGER DEFAULT 0
    );
  `);

  // Migration: add peso_bulto column if missing
  try { getDB().exec("ALTER TABLE insumos ADD COLUMN peso_bulto REAL DEFAULT 1"); } catch {}

  // Migration: add cuit column to deliveries if missing
  try { getDB().exec("ALTER TABLE deliveries ADD COLUMN cuit TEXT DEFAULT ''"); } catch {}

  return db;
}

function getDB() {
  if (!db) initDB();
  return db;
}

// ─── Config ───
function getConfig() {
  const rows = getDB().prepare("SELECT key, value FROM config").all();
  const cfg = {};
  for (const r of rows) {
    try { cfg[r.key] = JSON.parse(r.value); } catch { cfg[r.key] = r.value; }
  }
  return cfg;
}

function saveConfig(cfg) {
  const stmt = getDB().prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
  const tx = getDB().transaction((obj) => {
    for (const [k, v] of Object.entries(obj)) {
      stmt.run(k, typeof v === "string" ? v : JSON.stringify(v));
    }
  });
  tx(cfg);
}

// ─── Usuarios ───
function getUsuarios() {
  return getDB().prepare("SELECT nombre, rol, clave FROM usuarios").all();
}

function saveUsuarios(usuarios) {
  const del = getDB().prepare("DELETE FROM usuarios");
  const ins = getDB().prepare("INSERT INTO usuarios (nombre, rol, clave) VALUES (?, ?, ?)");
  const tx = getDB().transaction((list) => {
    del.run();
    for (const u of list) ins.run(u.nombre, u.rol, u.clave || "");
  });
  tx(usuarios);
}

// ─── Caja ───
function getCaja() {
  const sesion = getDB().prepare("SELECT * FROM caja_sesiones WHERE activa = 1 ORDER BY id DESC LIMIT 1").get();
  if (!sesion) return null;
  const movs = getDB().prepare("SELECT * FROM movimientos WHERE sesion_id = ?").all(sesion.id);
  return {
    id: sesion.id,
    fecha: sesion.fecha,
    apertura: sesion.apertura,
    movimientos: movs,
    cierre: sesion.cierre,
    saldoFinal: sesion.saldo_final,
    turno: sesion.turno,
    usuario: sesion.usuario,
    arqueo: JSON.parse(sesion.arqueo || "{}")
  };
}

function createCaja(sesion) {
  getDB().prepare("UPDATE caja_sesiones SET activa = 0 WHERE activa = 1").run();
  const result = getDB().prepare(
    "INSERT INTO caja_sesiones (fecha, turno, usuario, apertura, arqueo, activa) VALUES (?, ?, ?, ?, ?, 1)"
  ).run(sesion.fecha, sesion.turno || "", sesion.usuario || "", sesion.apertura || 0, JSON.stringify(sesion.arqueo || {}));
  return result.lastInsertRowid;
}

function addMovimiento(sesionId, mov) {
  getDB().prepare(
    "INSERT OR REPLACE INTO movimientos (id, sesion_id, tipo, concepto, monto, metodo, hora, ref, usuario, comprobante, cae, cae_vto, afip_cbte, afip_tipo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    mov.id, sesionId, mov.tipo, mov.concepto || "", mov.monto, mov.metodo || "",
    mov.hora || "", mov.ref || "", mov.usuario || "", mov.comprobante || "",
    mov.cae || "", mov.caeVto || "", mov.afipCbte || null, mov.afipTipo || ""
  );
}

function updateSesionArqueo(sesionId, arqueo) {
  getDB().prepare("UPDATE caja_sesiones SET arqueo = ? WHERE id = ?").run(JSON.stringify(arqueo || {}), sesionId);
}

function closeCaja(sesionId, cierre, arqueo, diff) {
  getDB().prepare(
    "UPDATE caja_sesiones SET cierre = ?, arqueo = ?, diff = ?, fecha_cierre = ?, activa = 0 WHERE id = ?"
  ).run(cierre, JSON.stringify(arqueo || {}), diff, new Date().toLocaleString("es-AR"), sesionId);
}

function getHistorialCierres() {
  const sesiones = getDB().prepare("SELECT * FROM caja_sesiones WHERE activa = 0 ORDER BY id DESC").all();
  return sesiones.map(s => {
    const movs = getDB().prepare("SELECT * FROM movimientos WHERE sesion_id = ?").all(s.id);
    return {
      fecha: s.fecha,
      apertura: s.apertura,
      movimientos: movs.map(m => ({
        id: m.id, tipo: m.tipo, concepto: m.concepto, monto: m.monto,
        metodo: m.metodo, hora: m.hora, ref: m.ref, usuario: m.usuario,
        comprobante: m.comprobante, cae: m.cae, caeVto: m.cae_vto,
        afipCbte: m.afip_cbte, afipTipo: m.afip_tipo
      })),
      cierre: s.cierre,
      saldoFinal: s.saldo_final,
      turno: s.turno,
      usuario: s.usuario,
      arqueo: JSON.parse(s.arqueo || "{}"),
      diff: s.diff,
      fechaCierre: s.fecha_cierre
    };
  });
}

// ─── FacturaXNum ───
function getFacturaXNum() {
  const row = getDB().prepare("SELECT valor FROM contadores WHERE key = 'facturaXNum'").get();
  return row ? row.valor : 1;
}

function setFacturaXNum(n) {
  getDB().prepare("INSERT OR REPLACE INTO contadores (key, valor) VALUES ('facturaXNum', ?)").run(n);
}

// ─── Mesas ───
function getMesas() {
  const rows = getDB().prepare("SELECT id, estado FROM mesas").all();
  const mesas = {};
  for (const r of rows) {
    mesas[r.id] = JSON.parse(r.estado || '{"lineas":[],"enviado":[],"despachado":[],"bebidas":[]}');
  }
  return mesas;
}

function saveMesas(mesas) {
  const stmt = getDB().prepare("INSERT OR REPLACE INTO mesas (id, estado) VALUES (?, ?)");
  const tx = getDB().transaction((obj) => {
    for (const [id, estado] of Object.entries(obj)) {
      stmt.run(parseInt(id), JSON.stringify(estado));
    }
  });
  tx(mesas);
}

function saveMesa(id, estado) {
  getDB().prepare("INSERT OR REPLACE INTO mesas (id, estado) VALUES (?, ?)").run(parseInt(id), JSON.stringify(estado));
}

// ─── Deliveries ───
function getDeliveries() {
  const dels = getDB().prepare("SELECT * FROM deliveries ORDER BY rowid DESC").all();
  return dels.map(d => {
    const items = getDB().prepare("SELECT * FROM delivery_items WHERE delivery_id = ?").all(d.id);
    return {
      id: d.id, cliente: d.cliente, direccion: d.direccion, telefono: d.telefono, cuit: d.cuit || "",
      hora: d.hora, total: d.total, estado: d.estado,
      items: items.map(i => ({ pid: i.pid, nombre: i.nombre, cant: i.cant, precio: i.precio, nota: i.nota }))
    };
  });
}

function saveDeliveries(deliveries) {
  const upsertDel = getDB().prepare("INSERT OR REPLACE INTO deliveries (id, cliente, direccion, telefono, cuit, hora, total, estado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const delItemsByDel = getDB().prepare("DELETE FROM delivery_items WHERE delivery_id = ?");
  const insItem = getDB().prepare("INSERT INTO delivery_items (delivery_id, pid, nombre, cant, precio, nota) VALUES (?, ?, ?, ?, ?, ?)");
  const tx = getDB().transaction((list) => {
    for (const d of list) {
      upsertDel.run(d.id, d.cliente || "", d.direccion || "", d.telefono || "", d.cuit || "", d.hora || "", d.total || 0, d.estado || "cocina");
      delItemsByDel.run(d.id);
      for (const it of (d.items || [])) insItem.run(d.id, it.pid || "", it.nombre || "", it.cant || 0, it.precio || 0, it.nota || "");
    }
  });
  tx(deliveries);
}

// ─── Productos ───
function getProductos() {
  return getDB().prepare("SELECT * FROM productos ORDER BY ref").all().map(p => ({
    id: p.id, ref: p.ref, cat: p.cat, nombre: p.nombre, precio: p.precio,
    receta: JSON.parse(p.receta || "[]")
  }));
}

function saveProductos(productos) {
  const del = getDB().prepare("DELETE FROM productos");
  const ins = getDB().prepare("INSERT OR REPLACE INTO productos (id, ref, cat, nombre, precio, receta) VALUES (?, ?, ?, ?, ?, ?)");
  const tx = getDB().transaction((list) => {
    del.run();
    for (const p of list) ins.run(p.id, p.ref || null, p.cat || "", p.nombre || "", p.precio || 0, JSON.stringify(p.receta || []));
  });
  tx(productos);
}

// ─── Insumos ───
function getInsumos() {
  return getDB().prepare("SELECT * FROM insumos").all().map(i => ({
    id: i.id, nombre: i.nombre, unidad: i.unidad, presentacion: i.presentacion,
    inicial: getStock(i.id), min: i.min, unidadCompra: i.unidad_compra, factorCompra: i.factor_compra,
    pesoBulto: i.peso_bulto || 1
  }));
}

function saveInsumos(insumos) {
  const del = getDB().prepare("DELETE FROM insumos");
  const ins = getDB().prepare("INSERT OR REPLACE INTO insumos (id, nombre, unidad, presentacion, min, unidad_compra, factor_compra, peso_bulto) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const tx = getDB().transaction((list) => {
    del.run();
    for (const i of list) ins.run(i.id, i.nombre || "", i.unidad || "g", i.presentacion || "", i.min || 0, i.unidadCompra || "g", i.factorCompra || 1, i.pesoBulto || 1);
  });
  tx(insumos);
}

// ─── Stock ───
function getStock(insumoId) {
  if (insumoId) {
    const row = getDB().prepare("SELECT cantidad FROM stock WHERE insumo_id = ?").get(insumoId);
    return row ? row.cantidad : 0;
  }
  const rows = getDB().prepare("SELECT insumo_id, cantidad FROM stock").all();
  const s = {};
  for (const r of rows) s[r.insumo_id] = r.cantidad;
  return s;
}

function saveStock(stock) {
  const del = getDB().prepare("DELETE FROM stock");
  const ins = getDB().prepare("INSERT OR REPLACE INTO stock (insumo_id, cantidad) VALUES (?, ?)");
  const tx = getDB().transaction((obj) => {
    del.run();
    for (const [id, cant] of Object.entries(obj)) ins.run(id, cant);
  });
  tx(stock);
}

function updateStock(insumoId, cantidad) {
  getDB().prepare("INSERT OR REPLACE INTO stock (insumo_id, cantidad) VALUES (?, ?)").run(insumoId, cantidad);
}

// ─── Costos ───
function getCostos() {
  const rows = getDB().prepare("SELECT insumo_id, costo FROM costos").all();
  const c = {};
  for (const r of rows) c[r.insumo_id] = r.costo;
  return c;
}

function saveCostos(costos) {
  const del = getDB().prepare("DELETE FROM costos");
  const ins = getDB().prepare("INSERT OR REPLACE INTO costos (insumo_id, costo) VALUES (?, ?)");
  const tx = getDB().transaction((obj) => {
    del.run();
    for (const [id, c] of Object.entries(obj)) ins.run(id, c);
  });
  tx(costos);
}

// ─── Proveedores ───
function getProveedores() {
  return getDB().prepare("SELECT * FROM proveedores").all();
}

function saveProveedores(proveedores) {
  const del = getDB().prepare("DELETE FROM proveedores");
  const ins = getDB().prepare("INSERT OR REPLACE INTO proveedores (id, nombre, cuit, condicion, rubro, direccion, localidad, telefono, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const tx = getDB().transaction((list) => {
    del.run();
    for (const p of list) ins.run(p.id, p.nombre || "", p.cuit || "", p.condicion || "", p.rubro || "", p.direccion || "", p.localidad || "", p.telefono || "", p.email || "");
  });
  tx(proveedores);
}

// ─── Facturas de compra ───
function getFacturas() {
  const facs = getDB().prepare("SELECT * FROM facturas ORDER BY rowid DESC").all();
  return facs.map(f => {
    const items = getDB().prepare("SELECT * FROM factura_items WHERE factura_id = ?").all(f.id);
    return {
      id: f.id, proveedor: f.proveedor, tipo: f.tipo, numero: f.numero,
      fecha: f.fecha, total: f.total,
      items: items.map(i => ({ desc: i.desc, bulto: i.bulto, cantidad: i.cantidad, ingreso: i.ingreso, insumoUn: i.insumo_un }))
    };
  });
}

function saveFacturas(facturas) {
  const delF = getDB().prepare("DELETE FROM facturas");
  const delI = getDB().prepare("DELETE FROM factura_items");
  const insF = getDB().prepare("INSERT INTO facturas (id, proveedor, tipo, numero, fecha, total) VALUES (?, ?, ?, ?, ?, ?)");
  const insI = getDB().prepare("INSERT INTO factura_items (factura_id, desc, bulto, cantidad, ingreso, insumo_un) VALUES (?, ?, ?, ?, ?, ?)");
  const tx = getDB().transaction((list) => {
    delF.run(); delI.run();
    for (const f of list) {
      insF.run(f.id, f.proveedor || "", f.tipo || "", f.numero || "", f.fecha || "", f.total || 0);
      for (const i of (f.items || [])) insI.run(f.id, i.desc || "", i.bulto || "", i.cantidad || 0, i.ingreso || 0, i.insumoUn || "");
    }
  });
  tx(facturas);
}

// ─── Pedidos WhatsApp ───
function getPedidosPendientes() {
  return getDB().prepare("SELECT * FROM pedidos_whatsapp WHERE enviado = 0").all().map(p => ({
    ...p, items: JSON.parse(p.items || "[]"), leido: !!p.leido, enviado: !!p.enviado
  }));
}

function savePedido(pedido) {
  getDB().prepare(
    "INSERT OR REPLACE INTO pedidos_whatsapp (id, origen, mesa, remitente, telefono, nombre, direccion, items, total, hora, leido, enviado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    pedido.id, pedido.origen || "", pedido.mesa || 0, pedido.remitente || "",
    pedido.telefono || "", pedido.nombre || "", pedido.direccion || "",
    JSON.stringify(pedido.items || []), pedido.total || 0, pedido.hora || "",
    pedido.leido ? 1 : 0, pedido.enviado ? 1 : 0
  );
}

function deletePedido(id) {
  getDB().prepare("DELETE FROM pedidos_whatsapp WHERE id = ?").run(id);
}

function markPedidoEnviado(id) {
  getDB().prepare("UPDATE pedidos_whatsapp SET enviado = 1 WHERE id = ?").run(id);
}

// ─── Backup ───
async function backupDB(destPath) {
  await getDB().backup(destPath);
}

// ─── Close ───
function closeDB() {
  if (db) db.close();
}

module.exports = {
  initDB, getDB, closeDB, backupDB,
  getConfig, saveConfig,
  getUsuarios, saveUsuarios,
  getCaja, createCaja, addMovimiento, closeCaja, getHistorialCierres, updateSesionArqueo,
  getFacturaXNum, setFacturaXNum,
  getMesas, saveMesas, saveMesa,
  getDeliveries, saveDeliveries,
  getProductos, saveProductos,
  getInsumos, saveInsumos,
  getStock, saveStock, updateStock,
  getCostos, saveCostos,
  getProveedores, saveProveedores,
  getFacturas, saveFacturas,
  getPedidosPendientes, savePedido, deletePedido, markPedidoEnviado
};
