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

    CREATE TABLE IF NOT EXISTS movimientos_borrados (
      id TEXT PRIMARY KEY,
      ts INTEGER
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
  // Deliveries cancelados: se recuerdan para que ningun dispositivo los vuelva a subir
  try { getDB().exec("CREATE TABLE IF NOT EXISTS deliveries_borrados (id TEXT PRIMARY KEY, ts INTEGER)"); } catch {}
  // Registro de ventas eliminadas: quien, cuando, por que y que se borro
  try { getDB().exec("ALTER TABLE movimientos_borrados ADD COLUMN detalle TEXT DEFAULT ''"); } catch {}
  // Cambios de medio de pago: version del movimiento + historial de cambios
  try { getDB().exec("ALTER TABLE movimientos ADD COLUMN editado_ts INTEGER DEFAULT 0"); } catch {}
  // Facturas de compra: guardar tambien insumo, subtotal y unitario de cada item
  try { getDB().exec("ALTER TABLE factura_items ADD COLUMN insumo TEXT DEFAULT ''"); } catch {}
  try { getDB().exec("ALTER TABLE factura_items ADD COLUMN subtotal REAL DEFAULT 0"); } catch {}
  try { getDB().exec("ALTER TABLE factura_items ADD COLUMN unitario REAL DEFAULT 0"); } catch {}
  try { getDB().exec("ALTER TABLE movimientos ADD COLUMN cambios TEXT DEFAULT ''"); } catch {}
  // Comision de tarjeta / Mercado Pago (la venta queda por el total, se recibe monto - comision)
  try { getDB().exec("ALTER TABLE movimientos ADD COLUMN comision REAL DEFAULT 0"); } catch {}
  // Deliveries de cajas anteriores: se guardan aca al abrir una caja nueva (no se pierden)
  try { getDB().exec("CREATE TABLE IF NOT EXISTS deliveries_archivo (id TEXT PRIMARY KEY, datos TEXT, archivado_ts INTEGER)"); } catch {}
try { getDB().exec("ALTER TABLE productos ADD COLUMN imagen TEXT DEFAULT ''"); } catch {}

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

// ─── Cuenta corriente y clientes: cambios de a uno (antes cada pantalla mandaba su lista completa y pisaba lo de otra) ───
function leerConfigLista(d, key) {
  const r = d.prepare("SELECT value FROM config WHERE key = ?").get(key);
  if (!r) return [];
  try { const v = JSON.parse(r.value); return Array.isArray(v) ? v : []; } catch { return []; }
}
function agregarMovimientosCC(entries) {
  const d = getDB();
  let out = [];
  d.transaction(() => {
    const lista = leerConfigLista(d, "cuentaCorriente");
    const ids = new Set(lista.map((e) => e && e.id));
    for (const e of entries || []) if (e && e.id && !ids.has(e.id)) { lista.push(e); ids.add(e.id); }
    d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('cuentaCorriente', ?)").run(JSON.stringify(lista));
    out = lista;
  })();
  return out;
}
function ajustarClientes({ guardar, borrar } = {}) {
  const d = getDB();
  let out = [];
  d.transaction(() => {
    let lista = leerConfigLista(d, "clientes");
    if (guardar && guardar.id) {
      const i = lista.findIndex((c) => c && c.id === guardar.id);
      if (i >= 0) lista[i] = { ...lista[i], ...guardar }; else lista.push(guardar);
    }
    if (borrar) lista = lista.filter((c) => c && c.id !== borrar);
    d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('clientes', ?)").run(JSON.stringify(lista));
    out = lista;
  })();
  return out;
}

// ─── Poner ventas y caja en cero (conserva usuarios, config y catálogo) ───
function resetVentas() {
  const d = getDB();
  const vacia = JSON.stringify({ lineas: [], enviado: [], despachado: [], bebidas: [], datos: { cliente: "", direccion: "", telefono: "", cuit: "" } });
  const tx = d.transaction(() => {
    d.prepare("DELETE FROM movimientos").run();
    d.prepare("DELETE FROM caja_sesiones").run();
    d.prepare("DELETE FROM delivery_items").run();
    d.prepare("DELETE FROM deliveries").run();
    d.prepare("DELETE FROM factura_items").run();
    d.prepare("DELETE FROM facturas").run();
    d.prepare("DELETE FROM pedidos_whatsapp").run();
    for (const r of d.prepare("SELECT id FROM mesas").all()) d.prepare("UPDATE mesas SET estado = ? WHERE id = ?").run(vacia, r.id);
    d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('clientes', ?)").run("[]");
    d.prepare("INSERT OR REPLACE INTO contadores (key, valor) VALUES ('facturaXNum', 1)").run();
  });
  tx();
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

function getMovimientosBorrados() {
  return getDB().prepare("SELECT id FROM movimientos_borrados").all().map(r => r.id);
}

function movimientoBorrado(id) {
  return !!getDB().prepare("SELECT 1 FROM movimientos_borrados WHERE id = ?").get(id);
}

function addMovimiento(sesionId, mov) {
  if (!mov || !mov.id || movimientoBorrado(mov.id)) return;
  // Si el movimiento ya pertenece a otra caja (anterior), no se mueve a la caja actual
  const existente = getDB().prepare("SELECT * FROM movimientos WHERE id = ?").get(mov.id);
  if (existente && existente.sesion_id != sesionId) return;
  // Si el movimiento fue corregido en el servidor (cambio de medio de pago), una pantalla con la version vieja no lo pisa
  const tsExistente = (existente && Number(existente.editado_ts)) || 0;
  if (tsExistente > (Number(mov.editado_ts) || 0)) return;
  getDB().prepare(
    "INSERT OR REPLACE INTO movimientos (id, sesion_id, tipo, concepto, monto, metodo, hora, ref, usuario, comprobante, cae, cae_vto, afip_cbte, afip_tipo, editado_ts, cambios, comision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    mov.id, sesionId, mov.tipo, mov.concepto || "", mov.monto, mov.metodo || "",
    mov.hora || "", mov.ref || "", mov.usuario || "", mov.comprobante || "",
    mov.cae || "", mov.caeVto || "", mov.afipCbte || null, mov.afipTipo || "",
    tsExistente || Number(mov.editado_ts) || 0, (existente && existente.cambios) || mov.cambios || "",
    Math.max(0, Number(mov.comision) || 0)
  );
}

function deleteMovimiento(id, info) {
  if (!id) return false;
  const d = getDB();
  const mov = d.prepare("SELECT * FROM movimientos WHERE id = ?").get(id);
  const r = d.prepare("DELETE FROM movimientos WHERE id = ?").run(id);
  d.prepare("INSERT OR IGNORE INTO movimientos_borrados (id, ts) VALUES (?, ?)").run(id, Date.now());
  if (mov) {
    const detalle = JSON.stringify({ sesion_id: mov.sesion_id, concepto: mov.concepto, monto: mov.monto, metodo: mov.metodo, hora: mov.hora, ref: mov.ref, tipo: mov.tipo, comision: Number(mov.comision) || 0, motivo: (info && info.motivo) || "", usuario: (info && info.usuario) || "", borradoTs: Date.now() });
    try { d.prepare("UPDATE movimientos_borrados SET detalle = ? WHERE id = ?").run(detalle, id); } catch {}
  }
  return r.changes > 0;
}

// Cambia el medio de pago de una venta y deja registrado el cambio
function cambiarMedioMovimiento(id, info) {
  const d = getDB();
  const mov = d.prepare("SELECT * FROM movimientos WHERE id = ?").get(id);
  if (!mov) return null;
  let cambios = []; try { cambios = JSON.parse(mov.cambios || "[]"); } catch {}
  const ts = Date.now();
  const comision = Math.max(0, Number(info.comision) || 0);
  cambios.push({ ts, antes: { metodo: mov.metodo, ref: mov.ref, comision: Number(mov.comision) || 0 }, despues: { metodo: info.metodo, ref: info.ref || "", comision }, motivo: info.motivo || "", usuario: info.usuario || "" });
  let concepto = mov.concepto || "";
  if (mov.metodo && concepto.endsWith(" — " + mov.metodo)) concepto = concepto.slice(0, concepto.length - mov.metodo.length) + info.metodo;
  d.prepare("UPDATE movimientos SET metodo = ?, ref = ?, concepto = ?, editado_ts = ?, cambios = ?, comision = ? WHERE id = ?").run(info.metodo, info.ref || "", concepto, ts, JSON.stringify(cambios), comision, id);
  return d.prepare("SELECT * FROM movimientos WHERE id = ?").get(id);
}

function getMovimientoById(id) {
  return getDB().prepare("SELECT * FROM movimientos WHERE id = ?").get(id);
}

function getVentasEliminadas(sesionId) {
  let rows = [];
  try { rows = getDB().prepare("SELECT id, ts, detalle FROM movimientos_borrados WHERE detalle IS NOT NULL AND detalle != '' ORDER BY ts DESC").all(); } catch { return []; }
  return rows.map((r) => { let det = {}; try { det = JSON.parse(r.detalle); } catch {} return { id: r.id, ts: r.ts, ...det }; })
    .filter((x) => x.motivo && (sesionId == null || x.sesion_id == sesionId));
}

function updateSesionArqueo(sesionId, arqueo) {
  getDB().prepare("UPDATE caja_sesiones SET arqueo = ? WHERE id = ?").run(JSON.stringify(arqueo || {}), sesionId);
}

// Pasa movimientos a otra caja (correccion manual: ventas que quedaron en la caja equivocada)
function moverMovimientos(ids, sesionId) {
  const d = getDB();
  const ses = d.prepare("SELECT id FROM caja_sesiones WHERE id = ?").get(sesionId);
  if (!ses) throw new Error("No existe la caja " + sesionId);
  let n = 0;
  d.transaction(() => { for (const id of ids || []) n += d.prepare("UPDATE movimientos SET sesion_id = ? WHERE id = ?").run(sesionId, id).changes; })();
  return n;
}
// Caja cerrada con esa fecha y turno (para movimientos de una pantalla que se quedo con la caja anterior)
function getSesionPorFechaTurno(fecha, turno) {
  return getDB().prepare("SELECT * FROM caja_sesiones WHERE fecha = ? AND turno = ? ORDER BY id DESC LIMIT 1").get(fecha, turno || "");
}

function closeCaja(sesionId, cierre, arqueo, diff) {
  getDB().prepare(
    "UPDATE caja_sesiones SET cierre = ?, arqueo = ?, diff = ?, fecha_cierre = ?, activa = 0 WHERE id = ?"
  ).run(cierre, JSON.stringify(arqueo || {}), diff, new Date().toLocaleString("es-AR"), sesionId);
}

function deleteCajaSession(id) {
  if (!id) return false;
  const d = getDB();
  const movs = d.prepare("SELECT COUNT(*) AS c FROM movimientos WHERE sesion_id = ?").get(id);
  if (movs && movs.c > 0) return false;
  const r = d.prepare("DELETE FROM caja_sesiones WHERE id = ? AND activa = 0").run(id);
  return r.changes > 0;
}

function getHistorialCierres() {
  const sesiones = getDB().prepare("SELECT * FROM caja_sesiones WHERE activa = 0 ORDER BY id DESC").all();
  return sesiones.map(s => {
    const movs = getDB().prepare("SELECT * FROM movimientos WHERE sesion_id = ?").all(s.id);
    return {
      id: s.id,
      fecha: s.fecha,
      apertura: s.apertura,
      movimientos: movs.map(m => ({
        id: m.id, tipo: m.tipo, concepto: m.concepto, monto: m.monto,
        metodo: m.metodo, hora: m.hora, ref: m.ref, usuario: m.usuario,
        comprobante: m.comprobante, cae: m.cae, caeVto: m.cae_vto,
        afipCbte: m.afip_cbte, afipTipo: m.afip_tipo, comision: Number(m.comision) || 0
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

// Una mesa cobrada/limpiada lleva "cobradaTs". Si llega una version de la mesa anterior a ese cobro
// (de una pantalla desactualizada), se ignora: asi una mesa ya cobrada no vuelve a aparecer.
function mesaEsVieja(id) {
  const row = getDB().prepare("SELECT estado FROM mesas WHERE id = ?").get(parseInt(id));
  if (!row) return () => false;
  let actual = {}; try { actual = JSON.parse(row.estado || "{}"); } catch {}
  const tsActual = Number(actual.cobradaTs) || 0;
  return (estado) => (Number(estado && estado.cobradaTs) || 0) < tsActual;
}

// Cada mesa guarda una version (_v) y quien la cambio por ultima vez (_d = pestaña/equipo).
// Una pantalla solo puede guardar una mesa si parte de la version actual (o si fue ella la ultima en cambiarla):
// asi una copia vieja de otra pantalla ya no pisa un pedido nuevo.
function sinMeta(o) { const { _v, _d, ...r } = o || {}; return JSON.stringify(r); }
function guardarMesaVersionada(id, estado, out) {
  const d = getDB();
  if (!estado || typeof estado !== "object") return;
  const row = d.prepare("SELECT estado FROM mesas WHERE id = ?").get(parseInt(id));
  let actual = null;
  if (row) { try { actual = JSON.parse(row.estado || "{}"); } catch { actual = {}; } }
  const vA = Number(actual && actual._v) || 0;
  if (actual && sinMeta(actual) === sinMeta(estado)) { out.versiones[id] = vA; return; }
  const tsA = Number(actual && actual.cobradaTs) || 0, tsN = Number(estado.cobradaTs) || 0;
  let ok;
  if (!actual) ok = true;
  else if (tsN > tsA) ok = true;            // cobro / limpieza / pago a cuenta mas nuevo
  else if (tsN < tsA) ok = false;           // version anterior a un cobro
  else if (estado._v !== undefined && estado._v !== null && Number(estado._v) === vA) ok = true;
  else if (estado._d && actual._d && estado._d === actual._d) ok = true;
  else ok = false;
  if (!ok) {
    console.log("[MESAS] Rechazada copia desactualizada de mesa", id, "(base", estado._v, "- actual", vA + ")");
    out.rechazadas.push(String(id)); out.versiones[id] = vA; return;
  }
  const nuevo = { ...estado, _v: vA + 1, _d: estado._d || "" };
  d.prepare("INSERT OR REPLACE INTO mesas (id, estado) VALUES (?, ?)").run(parseInt(id), JSON.stringify(nuevo));
  out.versiones[id] = vA + 1;
}

function saveMesas(mesas) {
  const out = { rechazadas: [], versiones: {} };
  const tx = getDB().transaction((obj) => { for (const [id, estado] of Object.entries(obj)) guardarMesaVersionada(id, estado, out); });
  tx(mesas);
  return out;
}

function saveMesa(id, estado) {
  const out = { rechazadas: [], versiones: {} };
  guardarMesaVersionada(id, { ...estado, _d: (estado && estado._d) || "servidor", _v: (estado && estado._v !== undefined) ? estado._v : undefined }, out);
  return out;
}

// ─── Deliveries ───
function getDeliveriesBorrados() {
  return getDB().prepare("SELECT id FROM deliveries_borrados").all().map(r => r.id);
}

function deleteDelivery(id) {
  if (!id) return false;
  const d = getDB();
  d.prepare("DELETE FROM delivery_items WHERE delivery_id = ?").run(id);
  const r = d.prepare("DELETE FROM deliveries WHERE id = ?").run(id);
  d.prepare("INSERT OR IGNORE INTO deliveries_borrados (id, ts) VALUES (?, ?)").run(id, Date.now());
  return r.changes > 0;
}

// Al abrir una caja nueva: guarda los deliveries actuales en deliveries_archivo,
// los marca como borrados (para que ningun dispositivo los vuelva a subir) y limpia la lista.
// Deliveries archivados (con sus items) para armar el detalle de la cuenta corriente
function getDeliveriesArchivo() {
  try { return getDB().prepare("SELECT datos, archivado_ts FROM deliveries_archivo").all().map((r) => { try { return { ...JSON.parse(r.datos), archivadoTs: r.archivado_ts }; } catch { return null; } }).filter(Boolean); } catch { return []; }
}

function archivarDeliveries() {
  const d = getDB();
  const actuales = getDeliveries();
  const insArch = d.prepare("INSERT OR REPLACE INTO deliveries_archivo (id, datos, archivado_ts) VALUES (?, ?, ?)");
  const insBorr = d.prepare("INSERT OR IGNORE INTO deliveries_borrados (id, ts) VALUES (?, ?)");
  const tx = d.transaction(() => {
    const ts = Date.now();
    for (const del of actuales) { insArch.run(del.id, JSON.stringify(del), ts); insBorr.run(del.id, ts); }
    d.prepare("DELETE FROM delivery_items").run();
    d.prepare("DELETE FROM deliveries").run();
  });
  tx();
  return actuales.length;
}

function getDeliveries() {
  const borrados = new Set(getDeliveriesBorrados());
  const dels = getDB().prepare("SELECT * FROM deliveries ORDER BY rowid DESC").all().filter(d => !borrados.has(d.id));
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
    // No se borran los que faltan en la lista: un dispositivo con datos viejos borraria deliveries nuevos.
    // Para cancelar un delivery se usa deleteDelivery(id).
    const borrados = new Set(getDeliveriesBorrados());
    for (const d of (list || [])) {
      if (!d || !d.id || borrados.has(d.id)) continue;
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
    receta: JSON.parse(p.receta || "[]"),
    imagen: p.imagen || ""
  }));
}

function saveProductos(productos) {
  const del = getDB().prepare("DELETE FROM productos");
  const ins = getDB().prepare("INSERT OR REPLACE INTO productos (id, ref, cat, nombre, precio, receta, imagen) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const tx = getDB().transaction((list) => {
    del.run();
    for (const p of list) ins.run(p.id, p.ref || null, p.cat || "", p.nombre || "", p.precio || 0, JSON.stringify(p.receta || []), p.imagen || "");
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

// Cambios de stock atomicos: sumar (ej: factura +360, cocina -2), fijar un valor, borrar o reemplazar todo
function ajustarStock(op) {
  const d = getDB();
  const get = d.prepare("SELECT cantidad FROM stock WHERE insumo_id = ?");
  const put = d.prepare("INSERT OR REPLACE INTO stock (insumo_id, cantidad) VALUES (?, ?)");
  const del = d.prepare("DELETE FROM stock WHERE insumo_id = ?");
  d.transaction(() => {
    if (op.reemplazar && typeof op.reemplazar === "object") { d.prepare("DELETE FROM stock").run(); for (const [id, v] of Object.entries(op.reemplazar)) put.run(id, Number(v) || 0); }
    for (const [id, v] of Object.entries(op.fijar || {})) put.run(id, Math.round((Number(v) || 0) * 100) / 100);
    for (const [id, delta] of Object.entries(op.sumar || {})) { const row = get.get(id); put.run(id, Math.round(((row ? Number(row.cantidad) : 0) + (Number(delta) || 0)) * 100) / 100); }
    for (const id of (op.borrar || [])) del.run(id);
  })();
  return getStock();
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

// Agregar / borrar una factura sin reescribir todas (evita que una pantalla vieja borre facturas nuevas)
function agregarFactura(f) {
  const d = getDB();
  d.transaction(() => {
    d.prepare("DELETE FROM factura_items WHERE factura_id = ?").run(f.id);
    d.prepare("INSERT OR REPLACE INTO facturas (id, proveedor, tipo, numero, fecha, total) VALUES (?, ?, ?, ?, ?, ?)").run(f.id, f.proveedor || "", f.tipo || "", f.numero || "", f.fecha || "", f.total || 0);
    const insI = d.prepare("INSERT INTO factura_items (factura_id, desc, bulto, cantidad, ingreso, insumo_un, insumo, subtotal, unitario) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const i of (f.items || [])) insI.run(f.id, i.desc || "", i.bulto || "", i.cantidad || 0, i.ingreso || 0, i.insumoUn || "", i.insumo || "", i.subtotal || 0, i.unitario || 0);
  })();
}
function borrarFactura(id) {
  const d = getDB();
  d.transaction(() => { d.prepare("DELETE FROM factura_items WHERE factura_id = ?").run(id); d.prepare("DELETE FROM facturas WHERE id = ?").run(id); })();
}
// Costos: fijar solo los que cambian
function ajustarCostos(fijar) {
  const ins = getDB().prepare("INSERT OR REPLACE INTO costos (insumo_id, costo) VALUES (?, ?)");
  getDB().transaction(() => { for (const [id, v] of Object.entries(fijar || {})) ins.run(id, Number(v) || 0); })();
  return getCostos();
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
      items: items.map(i => ({ desc: i.desc, bulto: i.bulto, cantidad: i.cantidad, ingreso: i.ingreso, insumoUn: i.insumo_un, insumo: i.insumo || undefined, subtotal: i.subtotal || 0, unitario: i.unitario || 0 }))
    };
  });
}

function saveFacturas(facturas) {
  const delF = getDB().prepare("DELETE FROM facturas");
  const delI = getDB().prepare("DELETE FROM factura_items");
  const insF = getDB().prepare("INSERT INTO facturas (id, proveedor, tipo, numero, fecha, total) VALUES (?, ?, ?, ?, ?, ?)");
  const insI = getDB().prepare("INSERT INTO factura_items (factura_id, desc, bulto, cantidad, ingreso, insumo_un, insumo, subtotal, unitario) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const tx = getDB().transaction((list) => {
    delF.run(); delI.run();
    for (const f of list) {
      insF.run(f.id, f.proveedor || "", f.tipo || "", f.numero || "", f.fecha || "", f.total || 0);
      for (const i of (f.items || [])) insI.run(f.id, i.desc || "", i.bulto || "", i.cantidad || 0, i.ingreso || 0, i.insumoUn || "", i.insumo || "", i.subtotal || 0, i.unitario || 0);
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
  if (db) { try { db.close(); } catch (e) {} db = null; }
}

module.exports = {
  initDB, getDB, closeDB, backupDB,
  getConfig, saveConfig, resetVentas, agregarMovimientosCC, ajustarClientes,
  getUsuarios, saveUsuarios,
  getCaja, createCaja, getDeliveriesArchivo, moverMovimientos, getSesionPorFechaTurno, ajustarStock, agregarFactura, borrarFactura, ajustarCostos, addMovimiento, deleteMovimiento, getMovimientosBorrados, getMovimientoById, getVentasEliminadas, cambiarMedioMovimiento, closeCaja, deleteCajaSession, getHistorialCierres, updateSesionArqueo,
  getFacturaXNum, setFacturaXNum,
  getMesas, saveMesas, saveMesa,
  getDeliveries, saveDeliveries, deleteDelivery, getDeliveriesBorrados, archivarDeliveries,
  getProductos, saveProductos,
  getInsumos, saveInsumos,
  getStock, saveStock, updateStock,
  getCostos, saveCostos,
  getProveedores, saveProveedores,
  getFacturas, saveFacturas,
  getPedidosPendientes, savePedido, deletePedido, markPedidoEnviado
};
