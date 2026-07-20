const fs = require("fs");
const path = require("path");
const db = require("./db");

const CAJA_STATE_PATH = path.join(__dirname, "caja-state.json");
const PRODUCTOS_PATH = path.join(__dirname, "productos.json");

function migrate() {
  console.log("🔄 Iniciando migración de JSON a SQLite...\n");
  db.initDB();

  // Migrar caja-state.json
  if (fs.existsSync(CAJA_STATE_PATH)) {
    const state = JSON.parse(fs.readFileSync(CAJA_STATE_PATH, "utf8"));
    console.log("📦 Migrando caja-state.json...");

    // Config
    if (state.config) {
      db.saveConfig(state.config);
      console.log("  ✅ Config");
    }

    // Usuarios
    if (state.usuarios && Array.isArray(state.usuarios)) {
      db.saveUsuarios(state.usuarios);
      console.log(`  ✅ Usuarios (${state.usuarios.length})`);
    }

    // Caja actual
    if (state.caja && state.caja.fecha) {
      const sesionId = db.createCaja(state.caja);
      if (state.caja.movimientos && Array.isArray(state.caja.movimientos)) {
        for (const mov of state.caja.movimientos) {
          db.addMovimiento(sesionId, mov);
        }
        console.log(`  ✅ Caja ${state.caja.fecha} (${state.caja.movimientos.length} movimientos)`);
      }
    }

    // Historial de cierres
    if (state.historialCierres && Array.isArray(state.historialCierres)) {
      for (const cierre of state.historialCierres) {
        const sid = db.createCaja(cierre);
        if (cierre.movimientos) {
          for (const mov of cierre.movimientos) db.addMovimiento(sid, mov);
        }
        db.closeCaja(sid, cierre.cierre, cierre.arqueo, cierre.diff);
      }
      console.log(`  ✅ Historial (${state.historialCierres.length} cierres)`);
    }

    // FacturaXNum
    if (typeof state.facturaXNum === "number") {
      db.setFacturaXNum(state.facturaXNum);
      console.log(`  ✅ FacturaXNum: ${state.facturaXNum}`);
    }

    // Mesas
    if (state.mesas && typeof state.mesas === "object") {
      db.saveMesas(state.mesas);
      console.log(`  ✅ Mesas (${Object.keys(state.mesas).length})`);
    }

    // Deliveries
    if (state.deliveries && Array.isArray(state.deliveries)) {
      db.saveDeliveries(state.deliveries);
      console.log(`  ✅ Deliveries (${state.deliveries.length})`);
    }

    // Insumos
    if (state.insumos && Array.isArray(state.insumos)) {
      db.saveInsumos(state.insumos);
      console.log(`  ✅ Insumos (${state.insumos.length})`);
    }

    // Stock
    if (state.stock && typeof state.stock === "object") {
      db.saveStock(state.stock);
      console.log(`  ✅ Stock (${Object.keys(state.stock).length})`);
    }

    // Costos
    if (state.costos && typeof state.costos === "object") {
      db.saveCostos(state.costos);
      console.log(`  ✅ Costos (${Object.keys(state.costos).length})`);
    }

    // Proveedores
    if (state.proveedores && Array.isArray(state.proveedores)) {
      db.saveProveedores(state.proveedores);
      console.log(`  ✅ Proveedores (${state.proveedores.length})`);
    }

    console.log("");
  }

  // Migrar productos.json
  if (fs.existsSync(PRODUCTOS_PATH)) {
    const productos = JSON.parse(fs.readFileSync(PRODUCTOS_PATH, "utf8"));
    if (Array.isArray(productos)) {
      db.saveProductos(productos);
      console.log(`  ✅ Productos (${productos.length})`);
    }
  }

  // Migrar pedidos-whatsapp.json
  const PEDIDOS_PATH = path.join(__dirname, "pedidos-whatsapp.json");
  if (fs.existsSync(PEDIDOS_PATH)) {
    const pedidos = JSON.parse(fs.readFileSync(PEDIDOS_PATH, "utf8"));
    if (Array.isArray(pedidos)) {
      for (const p of pedidos) db.savePedido(p);
      console.log(`  ✅ Pedidos WhatsApp (${pedidos.length})`);
    }
  }

  console.log("✅ Migración completada.");
  db.closeDB();
}

migrate();
