const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const db = require("./db");
const backup = require("./backup");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use((req, res, next) => { const line = new Date().toISOString() + " " + req.method + " " + req.url; console.log("[REQ]", req.method, req.url); try { fs.appendFileSync(path.join(__dirname, "requests.log"), line + "\n"); } catch {} res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); res.set('Pragma', 'no-cache'); res.set('Expires', '0'); next(); });

// --- Inicializar DB ---
db.initDB();
console.log("✅ Base de datos SQLite inicializada");

// Cerrar cajas viejas que quedaron activas por error
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
try {
  const oldOpen = db.getDB().prepare("SELECT id FROM caja_sesiones WHERE activa = 1 AND fecha != ?").all(today);
  if (oldOpen.length > 0) {
    db.getDB().prepare("UPDATE caja_sesiones SET activa = 0 WHERE activa = 1 AND fecha != ?").run(today);
    console.log(`🔄 Cerradas ${oldOpen.length} caja(s) vieja(s) que quedaron abiertas`);
  }
} catch (e) { console.warn("Error cerrando cajas viejas:", e.message); }

// Migrar desde JSON si la DB está vacía
const CONFIG = db.getConfig();
if (!CONFIG.nombreLocal && fs.existsSync(path.join(__dirname, "caja-state.json"))) {
  console.log("🔄 Migrando datos de JSON a SQLite...");
  try { require("./migrate")(); } catch (e) { console.error("Error en migración:", e.message); }
}

// Iniciar backups automáticos
backup.iniciarBackupsAutomaticos();

// --- Productos (en memoria para WhatsApp parsing) ---
const DEFAULT_PRODUCTOS = [
  { id: "pz-muzza", ref: 1, nombre: "Muzzarella", cat: "Pizzas", precio: 7000, receta: [["masa",1],["muzza",250],["salsa",150]] },
  { id: "pz-napo", ref: 2, nombre: "Napolitana", cat: "Pizzas", precio: 8000, receta: [["masa",1],["muzza",250],["salsa",150],["tomate",2]] },
  { id: "pz-fuga", ref: 3, nombre: "Fugazzeta", cat: "Pizzas", precio: 8500, receta: [["masa",1],["muzza",300],["cebolla",2]] },
  { id: "pz-esp", ref: 4, nombre: "Especial", cat: "Pizzas", precio: 9000, receta: [["masa",1],["muzza",250],["salsa",150],["jamon",60],["morron",1]] },
  { id: "mi-simple", ref: 5, nombre: "Mila simple c/ papas", cat: "Milanesas", precio: 6500, receta: [["milcarne",1],["huevo",1]] },
  { id: "mi-napo", ref: 6, nombre: "Mila napolitana", cat: "Milanesas", precio: 8000, receta: [["milcarne",1],["huevo",1],["muzza",100],["jamon",60],["tomate",1]] },
  { id: "mi-caballo", ref: 7, nombre: "Mila a caballo", cat: "Milanesas", precio: 7500, receta: [["milcarne",1],["huevo",3]] },
  { id: "pa-noquis", ref: 8, nombre: "Ñoquis c/ salsa", cat: "Pastas", precio: 6000, receta: [["noquis",250],["salsa",150]] },
  { id: "pa-ravioles", ref: 9, nombre: "Ravioles c/ salsa", cat: "Pastas", precio: 6500, receta: [["ravioles",250],["salsa",150]] },
  { id: "pa-tallarines", ref: 10, nombre: "Tallarines c/ salsa", cat: "Pastas", precio: 6000, receta: [["tallarines",200],["salsa",150]] },
  { id: "ha-simple", ref: 11, nombre: "Hamburguesa simple", cat: "Hamburguesas", precio: 4500, receta: [["pan",1],["carne",120],["cheddar",40]] },
  { id: "ha-completa", ref: 12, nombre: "Hamburguesa completa", cat: "Hamburguesas", precio: 6500, receta: [["pan",1],["carne",120],["cheddar",80],["panceta",40],["lechuga",1]] },
  { id: "be-gaseosa", ref: 13, nombre: "Gaseosa", cat: "Bebidas", precio: 2000, receta: [["gaseosa",1]] },
  { id: "be-cerveza", ref: 14, nombre: "Cerveza", cat: "Bebidas", precio: 3000, receta: [["cerveza",1]] },
  { id: "be-agua", ref: 15, nombre: "Agua", cat: "Bebidas", precio: 1800, receta: [["agua",1]] },
];

let PRODUCTOS = db.getProductos();
if (!PRODUCTOS.length) { PRODUCTOS = DEFAULT_PRODUCTOS; db.saveProductos(PRODUCTOS); }

const prodPorRef = Object.fromEntries(PRODUCTOS.map(p => [p.ref, p]));
const prodPorNombre = Object.fromEntries(PRODUCTOS.map(p => [p.nombre.toLowerCase(), p]));
const DIR_KEYWORDS = ["calle", "av ", "avenida", "pasaje", "ruta", "bulevar", "esq", "nro", "depto", "piso", "manzana", "barrio", "casa", "km"];

let PUBLIC_URL = db.getConfig().publicUrl || "http://localhost:3456";

app.post("/api/public-url", (req, res) => {
  PUBLIC_URL = req.body.url || PUBLIC_URL;
  db.saveConfig({ publicUrl: PUBLIC_URL });
  res.json({ ok: true, url: PUBLIC_URL });
});

const MENU_CACHE = {};
function getConfig() { return db.getConfig(); }

const MENU_TEXTO = () => {
  const cfg = getConfig();
  const cats = [...new Set(PRODUCTOS.map(p => p.cat))];
  let txt = "🍕 *" + (cfg.nombreLocal || "EL MOSTRADOR") + " - MENÚ*\n\n";
  cats.forEach(cat => {
    txt += `*${cat.toUpperCase()}*\n`;
    PRODUCTOS.filter(p => p.cat === cat).forEach(p => {
      txt += `${p.ref}. ${p.nombre}\n`;
    });
    txt += "\n";
  });
  txt += `🌐 *Menú web:* ${PUBLIC_URL}/menu-delivery.html\n\n`;
  txt += "📲 *Para pedir:* mandá los números de producto separados por coma\n";
  txt += "Ej: *1, 2, Germán, calle Siempre Viva 123*\n";
  txt += "Para *cantidad* usá el formato *NxM* (ej: 2x1 = dos Muzzarella)\n";
  txt += "Al final poné tu *nombre* y *dirección* separados por coma.\n";
  return txt;
};

const parsearPedido = (texto) => {
  const datos = { cliente: "", direccion: "", telefono: "" };
  const items = [];
  const partes = texto.split(/[,;\n]+/).map(l => l.trim()).filter(Boolean);
  const partesTexto = [];
  for (const p of partes) {
    const cantNum = p.match(/^(\d+)\s*x\s*(\d{1,3})$/i);
    if (cantNum) {
      const prod = prodPorRef[parseInt(cantNum[2])];
      if (prod) { const existing = items.find(i => i.pid === prod.id); if (existing) { existing.cant += parseInt(cantNum[1]); } else { items.push({ pid: prod.id, nombre: prod.nombre, ref: prod.ref, cant: parseInt(cantNum[1]), nota: "" }); } continue; }
    }
    const soloNum = p.match(/^(\d{1,3})$/);
    if (soloNum) {
      const prod = prodPorRef[parseInt(soloNum[1])];
      if (prod) { const existing = items.find(i => i.pid === prod.id); if (existing) { existing.cant += 1; } else { items.push({ pid: prod.id, nombre: prod.nombre, ref: prod.ref, cant: 1, nota: "" }); } continue; }
    }
    const notaMatch = p.match(/^(.+?)\((.+?)\)$/);
    const sinNota = notaMatch ? notaMatch[1].trim() : p;
    const nota = notaMatch ? notaMatch[2].trim() : "";
    let cant = 1, nombre = sinNota.replace(/^[\s,]+|[\s,]+$/g, "");
    const m1 = sinNota.match(/^(\d+)\s*x\s*(.+)/i) || sinNota.match(/^(\d+)\s+(.+)/);
    if (m1) { cant = parseInt(m1[1]); nombre = m1[2].trim().replace(/^[\s,]+|[\s,]+$/g, ""); }
    else { const m2 = sinNota.match(/^(.+?)\s*x\s*(\d+)$/i); if (m2) { cant = parseInt(m2[2]); nombre = m2[1].trim().replace(/^[\s,]+|[\s,]+$/g, ""); } }
    const nlow = nombre.toLowerCase();
    const prod = prodPorNombre[nlow] || PRODUCTOS.find(p => nlow.includes(p.nombre.toLowerCase()) || p.nombre.toLowerCase().includes(nlow) || nlow.startsWith(p.nombre.toLowerCase().slice(0, 5)));
    if (prod) { const existing = items.find(i => i.pid === prod.id && i.nota === nota); if (existing) { existing.cant += cant; } else { items.push({ pid: prod.id, nombre: prod.nombre, ref: prod.ref, cant, nota }); } continue; }
    partesTexto.push(p);
  }
  let idxDir = -1;
  for (let i = partesTexto.length - 1; i >= 0; i--) {
    if (DIR_KEYWORDS.some(k => partesTexto[i].toLowerCase().includes(k))) { idxDir = i; break; }
  }
  if (idxDir >= 0) {
    datos.direccion = partesTexto.slice(idxDir).join(", ");
    datos.cliente = partesTexto.slice(0, idxDir).join(", ");
  } else if (partesTexto.length === 1) {
    datos.cliente = partesTexto[0];
  } else if (partesTexto.length >= 2) {
    datos.cliente = partesTexto.slice(0, -1).join(", ");
    datos.direccion = partesTexto[partesTexto.length - 1];
  }
  return { datos, items };
};

// --- WhatsApp Client ---
let client = null;
const WA_OPTS = {
  puppeteer: { headless: true, executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", args: ["--no-sandbox"] },
  authTimeoutMs: 120000,
};
const processedMsgIds = new Set();

function iniciarWhatsApp() {
  const authStrategy = new LocalAuth();
  client = new Client({ authStrategy, ...WA_OPTS });

  client.on("qr", (qr) => {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(" ESCANEÁ ESTE QR CON WHATSAPP EN TU CELU");
    console.log("   (Abrí WhatsApp > 3 puntitos > WhatsApp Web)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    qrcode.generate(qr, { small: true });
    fs.writeFileSync("qr.txt", qr);
    console.log("📌 También podés ver el QR en http://localhost:3456/qr\n");
  });

  client.on("ready", () => {
    console.log("\n✅ WhatsApp conectado. Esperando mensajes...\n");
  });

  client.on("message", async (msg) => {
    const msgId = msg.id._serialized || msg.id.id || msg.id;
    if (processedMsgIds.has(msgId)) return;
    processedMsgIds.add(msgId);
    if (processedMsgIds.size > 500) { const first = processedMsgIds.values().next().value; processedMsgIds.delete(first); }
    const msgAge = Date.now() - (msg.timestamp * 1000);
    if (msgAge > 120000) { console.log(`⏭️ Mensaje viejo (${Math.round(msgAge/1000)}s), ignorado`); return; }
    const remitente = msg.from;
    if (remitente === "status@broadcast" || remitente.endsWith("@newsletter")) return;
    const texto = msg.body.trim().toLowerCase();
    const contacto = await msg.getContact();
    const nombre = contacto.pushname || contacto.name || "Cliente";
    const telefono = remitente.split("@")[0];
    console.log(`📩 Mensaje de ${nombre} (${telefono}): ${msg.body}`);
    const saludos = ["hola", "buenas", "buen dia", "buena tarde", "buena noche", "hello", "hi", "menu", "menú", "comer", "pedir"];
    if (saludos.some(s => texto.includes(s)) && texto.length < 30) {
      await msg.reply(`¡Hola ${nombre}! 👋\n\n${MENU_TEXTO()}`);
      console.log(`✅ Auto-respuesta enviada a ${nombre}`);
      return;
    }
    const tieneNumeros = /\d+\s*x\s*/.test(texto) || /\d+\s+.+/.test(texto);
    const tieneProducto = PRODUCTOS.some(p => texto.includes(p.nombre.toLowerCase().slice(0, 5)));
    if (tieneNumeros || tieneProducto) {
      const res = parsearPedido(msg.body);
      if (res.items.length > 0) {
        const pedido = { id: Date.now().toString(36), remitente, telefono, nombre: res.datos.cliente || nombre, direccion: res.datos.direccion || "", items: res.items, total: 0, hora: new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }), leido: false };
        db.savePedido(pedido);
        const resumen = res.items.map(i => `${i.cant}x ${i.nombre}${i.nota ? " (" + i.nota + ")" : ""}`).join("\n");
        await msg.reply(`✅ Pedido recibido:\n${resumen}\n\n🌐 Seguí tu pedido: ${PUBLIC_URL}/menu-mesa.html\n📋 Sale en comanda. Gracias ${pedido.nombre}!`);
        console.log(`✅ Pedido registrado de ${pedido.nombre}: ${resumen}`);
      }
    }
  });

  client.initialize().catch(err => {
    console.log(`⚠️  WhatsApp: ${err.message || "Error"}. Reintentando en 60 seg...`);
    try { fs.unlinkSync("qr.txt"); } catch {}
    if (!err.message.includes("already running")) {
      try { fs.rmSync(".wwebjs_auth", { recursive: true, force: true }); } catch {}
    }
    setTimeout(iniciarWhatsApp, 60000);
  });
}

// --- API: Config ---
app.get("/api/config", (req, res) => {
  res.json(db.getConfig());
});

// --- API: Caja ---
app.get("/api/caja", (req, res) => {
  const caja = db.getCaja();
  const historialCierres = db.getHistorialCierres();
  const mesas = db.getMesas();
  const deliveries = db.getDeliveries();
  const cfg = db.getConfig();
  const insumos = db.getInsumos();
  const stock = db.getStock();
  const costos = db.getCostos();
  const proveedores = db.getProveedores();
  const usuarios = db.getUsuarios();
  const facturaXNum = db.getFacturaXNum();
  const cajaIniciada = !!caja;
  res.json({ caja, cajaIniciada, historialCierres, mesas, deliveries, config: cfg, insumos, stock, costos, proveedores, usuarios, facturaXNum, productos: PRODUCTOS });
});

app.post("/api/caja", (req, res) => {
  try {
    const { caja, cajaIniciada, historialCierres, mesas, deliveries, config, insumos, stock, costos, proveedores, facturaXNum, usuarios, productos } = req.body;
    console.log("[POST /api/caja] cajaIniciada:", cajaIniciada, "fecha:", caja?.fecha, "turno:", caja?.turno, "movimientos:", caja?.movimientos?.length || 0);

    // Caja
    if (caja !== undefined && caja !== null) {
      if (cajaIniciada === false) {
        // CERRANDO caja: cerrar sesión activa en servidor
        const serverCaja = db.getCaja();
        if (serverCaja) {
          db.closeCaja(serverCaja.id, caja.cierre || 0, caja.arqueo || {}, caja.diff || 0);
          console.log("[POST /api/caja] Caja cerrada, sesión", serverCaja.id);
        }
      } else if (cajaIniciada === true) {
        // ABRIENDO o SINCRONIZANDO caja activa
        let serverCaja = db.getCaja();
        if (!serverCaja) {
          // No hay sesión activa → crear una SOLO si el cliente dice que inició caja
          const sesionId = db.createCaja(caja);
          console.log("[POST /api/caja] Nueva sesión:", sesionId);
          serverCaja = { id: sesionId };
        }
        if (caja.movimientos) {
          for (const mov of caja.movimientos) db.addMovimiento(serverCaja.id, mov);
          console.log("[POST /api/caja] Sync", caja.movimientos.length, "movimientos a sesión", serverCaja.id);
        }
        if (caja.arqueo) db.updateSesionArqueo(serverCaja.id, caja.arqueo);
      }
      // Si cajaIniciada es undefined/ null → no hacer nada (evita crear sesiones por mistake)
    }

    // CajaIniciada
    if (cajaIniciada !== undefined) {
      // Handled by caja session state
    }

    // HistorialCierres
    if (historialCierres !== undefined && Array.isArray(historialCierres)) {
      // Client is authority - handled client-side
    }

    // Mesas
    if (mesas !== undefined && mesas !== null) {
      db.saveMesas(mesas);
    }

    // Deliveries
    if (deliveries !== undefined && deliveries !== null) {
      const filtered = Array.isArray(deliveries) ? deliveries : [];
      db.saveDeliveries(filtered);
    }

    // Config
    if (config !== undefined && config !== null) {
      db.saveConfig(config);
      delete MENU_CACHE.html;
    }

    // Insumos
    if (insumos !== undefined && Array.isArray(insumos) && insumos.length > 0) db.saveInsumos(insumos);
    if (stock !== undefined && typeof stock === "object" && Object.keys(stock).length > 0) db.saveStock(stock);
    if (costos !== undefined && typeof costos === "object" && Object.keys(costos).length > 0) db.saveCostos(costos);
    if (proveedores !== undefined && Array.isArray(proveedores) && proveedores.length > 0) db.saveProveedores(proveedores);
    if (usuarios !== undefined && Array.isArray(usuarios) && usuarios.length > 0) db.saveUsuarios(usuarios);
    if (facturaXNum !== undefined && typeof facturaXNum === "number" && facturaXNum > (db.getFacturaXNum() || 0)) db.setFacturaXNum(facturaXNum);
    if (productos !== undefined && Array.isArray(productos) && productos.length > 0) { PRODUCTOS = productos.map(p => ({ ...p, receta: p.receta || [] })); db.saveProductos(PRODUCTOS); Object.assign(prodPorRef, Object.fromEntries(PRODUCTOS.map(p => [p.ref, p]))); Object.assign(prodPorNombre, Object.fromEntries(PRODUCTOS.map(p => [p.nombre.toLowerCase(), p]))); }

    res.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/caja] ERROR:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- API: Mesas ---
app.get("/api/mesas", (req, res) => {
  res.json(db.getMesas());
});
app.post("/api/mesas", (req, res) => {
  const mesas = req.body;
  if (!mesas || typeof mesas !== "object") return res.status(400).json({ error: "invalid" });
  db.saveMesas(mesas);
  res.json({ ok: true });
});

// --- API: Deliveries ---
app.get("/api/deliveries", (req, res) => {
  res.json(db.getDeliveries());
});
app.post("/api/deliveries", (req, res) => {
  const deliveries = req.body;
  if (!Array.isArray(deliveries)) return res.status(400).json({ error: "invalid" });
  db.saveDeliveries(deliveries);
  res.json({ ok: true });
});

// --- API: Facturas de compra ---
app.get("/api/facturas", (req, res) => {
  res.json(db.getFacturas());
});
app.post("/api/facturas", (req, res) => {
  const facturas = req.body;
  if (!Array.isArray(facturas)) return res.status(400).json({ error: "invalid" });
  db.saveFacturas(facturas);
  res.json({ ok: true });
});

// --- API: Productos ---
app.get("/api/productos", (req, res) => {
  res.json(PRODUCTOS);
});
app.put("/api/productos", (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ ok: false, error: "se espera un array" });
  PRODUCTOS = req.body.map(p => ({ ...p, receta: p.receta || [] }));
  db.saveProductos(PRODUCTOS);
  Object.assign(prodPorRef, Object.fromEntries(PRODUCTOS.map(p => [p.ref, p])));
  Object.assign(prodPorNombre, Object.fromEntries(PRODUCTOS.map(p => [p.nombre.toLowerCase(), p])));
  res.json({ ok: true });
});

// --- API: Pedidos WhatsApp ---
app.get("/api/pedidos", (req, res) => {
  res.json(db.getPedidosPendientes().filter(p => !p.leido));
});
app.get("/api/pedidos/pendientes", (req, res) => {
  res.json(db.getPedidosPendientes().filter(p => !p.enviado));
});
app.post("/api/pedidos/:id/leido", (req, res) => {
  const p = db.getPedidosPendientes().find(p => p.id === req.params.id);
  if (p) { p.leido = true; db.savePedido(p); }
  res.json({ ok: true });
});
app.post("/api/pedidos/:id/enviado", (req, res) => {
  db.markPedidoEnviado(req.params.id);
  res.json({ ok: true });
});
app.post("/api/pedidos/:id/entregado", (req, res) => {
  db.deletePedido(req.params.id);
  res.json({ ok: true });
});

app.get("/api/menu", (req, res) => {
  res.json(PRODUCTOS);
});

// --- API: Backup ---
app.get("/api/backups", (req, res) => {
  res.json(db.listarBackups ? backup.listarBackups() : []);
});
app.post("/api/backups/crear", async (req, res) => {
  const result = await backup.crearBackup("manual");
  res.json(result);
});
app.post("/api/backups/restaurar", (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: "Sin nombre" });
  const result = backup.restaurarBackup(nombre);
  if (result.ok) {
    res.json({ ok: true, texto: "Restaurado. Reiniciando..." });
    setTimeout(() => {
      const { spawn } = require("child_process");
      const bat = spawn("cmd", ["/c", "taskkill /F /IM node.exe >nul 2>&1 & timeout /t 2 /nobreak >nul & node server.js"], { detached: true, stdio: "ignore", cwd: __dirname });
      bat.unref();
      process.exit(0);
    }, 1000);
  } else {
    res.json(result);
  }
});

// --- API: Update ---
const updater = require("./updater");
app.post("/api/update", async (req, res) => {
  const token = req.body && req.body.token;
  try {
    const result = await updater.updateFromGitHub(token);
    res.json({ ok: true, texto: "Actualizado correctamente. Reiniciando...", backup: result.backupDir });
    updater.restartServer();
  } catch (e) {
    console.error("[UPDATE ERROR]", e);
    res.json({ ok: false, texto: "Error al actualizar: " + e.message });
  }
});

// --- Static routes ---
app.get("/prototipo-gestion-bar.html", (req, res) => {
  const cfg = getConfig();
  const nombre = cfg.nombreLocal || "El Mostrador";
  let html = fs.readFileSync(path.join(__dirname, "prototipo-gestion-bar.html"), "utf-8");
  html = html.replace("<title>El Mostrador</title>", "<title>" + nombre + "</title>");
  html = html.replace('<meta name="theme-color" content="#1a1715" />', '<meta name="theme-color" content="#1a1715" />\n<meta name="apple-mobile-web-app-title" content="' + nombre + '" />');
  res.set("Content-Type", "text/html");
  res.send(html);
});

app.use(express.static(path.join(__dirname)));

function serveMenu(req, res) {
  const cfg = getConfig();
  const nombre = cfg.nombreLocal || "El Mostrador";
  const logo = cfg.logo || "";
  let html = MENU_CACHE.html;
  if (!html) {
    try { html = fs.readFileSync(path.join(__dirname, "menu-mesa.html"), "utf-8"); MENU_CACHE.html = html; } catch { return res.status(500).send("Error"); }
  }
  let out = html.replace(/El Mostrador/g, nombre);
  if (logo) {
    out = out.replace('id="ogImage" content="/app-icon.png"', 'id="ogImage" content="' + logo + '"');
  }
  res.set("Content-Type", "text/html");
  res.send(out);
}

app.get("/app-icon.png", (req, res) => {
  const cfg = getConfig();
  const logo = cfg.logo;
  if (logo && logo.startsWith("data:image")) {
    const base64 = logo.split(",")[1];
    const buffer = Buffer.from(base64, "base64");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-cache");
    return res.send(buffer);
  }
  res.sendFile(path.join(__dirname, "icon-192.png"));
});

app.get("/manifest.json", (req, res) => {
  const cfg = getConfig();
  const nombre = cfg.nombreLocal || "El Mostrador";
  const manifest = {
    name: nombre + " - Menú",
    short_name: nombre,
    description: "Menú de " + nombre + " - Hacé tu pedido",
    start_url: "/menu-delivery.html",
    display: "standalone",
    background_color: "#f5f0eb",
    theme_color: "#241a0c",
    orientation: "portrait",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      { src: "/icon-192.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-512.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any" }
    ]
  };
  res.set("Content-Type", "application/json");
  res.set("Cache-Control", "no-cache");
  res.json(manifest);
});

app.get("/manifest-app.json", (req, res) => {
  const cfg = getConfig();
  const nombre = cfg.nombreLocal || "El Mostrador";
  const manifest = {
    name: nombre,
    short_name: nombre,
    description: "Sistema de gestión " + nombre,
    start_url: "/",
    display: "standalone",
    background_color: "#1a1715",
    theme_color: "#1a1715",
    orientation: "any",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
    ]
  };
  res.set("Content-Type", "application/json");
  res.set("Cache-Control", "no-cache");
  res.json(manifest);
});

app.get("/instructivo.html", (req, res) => {
  const cfg = getConfig();
  const nombre = cfg.nombreLocal || "El Mostrador";
  const url = PUBLIC_URL + "/menu-delivery.html";
  let html = fs.readFileSync(path.join(__dirname, "instructivo.html"), "utf-8");
  html = html.replace("COMPLETAR CON LA URL", url);
  html = html.replace("Menú Digital", nombre);
  html = html.replace("id=\"footerName\">Menú Digital", "id=\"footerName\">" + nombre);
  res.set("Content-Type", "text/html");
  res.send(html);
});

app.get("/menu-delivery.html", (req, res) => { serveMenu(req, res); });
app.get("/admin", (req, res) => { res.redirect("/prototipo-gestion-bar.html?mode=admin"); });
app.get("/", (req, res) => { res.redirect("/prototipo-gestion-bar.html"); });
app.get("/menu-mesa.html", (req, res) => { serveMenu(req, res); });

app.post("/api/pedidos/mesa", (req, res) => {
  const { mesa, telefono, items, nombrePedido, direccion } = req.body;
  if (!items || !items.length) return res.status(400).json({ ok: false, error: "sin items" });
  const pedido = {
    id: "mesa" + Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    origen: "menu-web",
    mesa: mesa || 0,
    telefono: telefono || "",
    nombre: nombrePedido || (mesa ? "Mesa " + mesa : "Para llevar"),
    direccion: direccion || "",
    items: items.map(it => ({ nombre: it.nombre, cant: it.cant, nota: it.nota || "" })),
    total: items.reduce((a, it) => a + (it.precio || 0) * it.cant, 0),
    hora: new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }),
    leido: false,
    enviado: false
  };
  db.savePedido(pedido);
  res.json({ ok: true, id: pedido.id });
});

app.get("/qr", (req, res) => {
  try {
    const qr = fs.readFileSync("qr.txt", "utf-8");
    res.send(`<html><body style="background:#1a1715;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;font-family:sans-serif"><h2 style="color:#e8a23d">Escaneá con WhatsApp</h2><p style="color:#a89a8c;margin-top:-8px">Abrí WhatsApp > 3 puntitos > WhatsApp Web</p><div style="background:#fff;padding:20px;border-radius:16px;margin-top:10px"><img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}" alt="QR WhatsApp"></div><p style="color:#6fa84a;font-size:13px;margin-top:16px">✅ Servidor funcionando en puerto 3456</p></body></html>`);
  } catch {
    res.send(`<html><body style="background:#1a1715;color:#f5efe6;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><p>⚠️ QR no disponible aún. Esperá a que se genere...</p></body></html>`);
  }
});

// --- AFIP ---
const afip = require("./afip");

app.post("/api/afip/test", async (req, res) => {
  try {
    const cfg = getConfig();
    const accessToken = req.body.accessToken || cfg.afipAccessToken || "";
    const result = await afip.verificarPuntoVenta(false, accessToken);
    res.json(result);
  } catch (e) {
    res.json({ ok: false, mensaje: e.message });
  }
});

app.post("/api/afip/facturar", async (req, res) => {
  try {
    const cfg = getConfig();
    const data = req.body;
    if (!data.items || !data.items.length) return res.status(400).json({ ok: false, error: "Sin items" });
    const accessToken = data.accessToken || cfg.afipAccessToken || "";
    delete data.accessToken;
    const result = await afip.facturar(data, false, accessToken);
    res.json({ ok: true, cae: result.cae, vencimiento: result.vencimiento, cbteNro: result.cbteNro, ptoVenta: result.ptoVenta });
  } catch (e) {
    console.error("[AFIP] Error facturando:", e.message);
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/afip/token", async (req, res) => {
  try {
    const cfg = getConfig();
    const accessToken = cfg.afipAccessToken || "";
    const token = await afip.getWSAAToken(false, accessToken);
    res.json({ ok: true, token: token.token ? token.token.substring(0, 20) + "..." : "OK" });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/whatsapp/comprobante", async (req, res) => {
  try {
    const cfg = getConfig();
    const { telefono, items, total, metodo, comprobante, afip: afipData, cliente, clienteData, localName } = req.body;
    if (!telefono) return res.status(400).json({ ok: false, error: "Sin teléfono" });
    const nombre = cfg.nombreLocal || localName || "El Mostrador";
    const dir = cfg.direccion || "YPF El Cruce / Ruta Nac 157 y 64";
    const cuit = cfg.cuit || "27-21341447-5";
    const now = new Date();
    const fecha = now.toLocaleDateString("es-AR");
    const hora = now.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
    let itemsHtml = (items || []).map(it => `<tr><td style="padding:4px 0">${it.cant || 1}x ${it.nombre}</td><td style="text-align:right;padding:4px 0">$${((it.precio || 0) * (it.cant || 1)).toLocaleString("es-AR")}</td></tr>`).join("");
    let clienteHtml = "";
    if (cliente || (clienteData && (clienteData.cuit || clienteData.direccion || clienteData.telefono))) {
      clienteHtml = `<div style="margin-bottom:8px;font-size:11px;color:#555">
        <div><b>Cliente:</b> ${cliente || ""}</div>
        ${clienteData?.cuit ? `<div>CUIT: ${clienteData.cuit}</div>` : ""}
        ${clienteData?.direccion ? `<div>${clienteData.direccion}</div>` : ""}
        ${clienteData?.telefono ? `<div>Tel: ${clienteData.telefono}</div>` : ""}
      </div>`;
    }
    let afipHtml = "";
    if (afipData && afipData.cae) {
      afipHtml = `<div style="border-top:1px dashed #ccc;margin-top:12px;padding-top:8px;font-size:11px;color:#555">
        <div><b>Factura Electrónica</b></div>
        <div>CAE: ${afipData.cae}</div>
        <div>Vto CAE: ${afipData.vencimiento || ""}</div>
        <div>Cbte N°: ${afipData.cbteNro || ""}</div>
        <div>Pto Venta: ${afipData.ptoVenta || "2"}</div>
        <div>CUIT: ${cuit}</div>
        <div>Régimen: Monotributo</div>
      </div>`;
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Courier New',monospace;width:300px;padding:16px;background:#fff;color:#000;font-size:13px}
      .center{text-align:center}
      .bold{font-weight:700}
      .small{font-size:11px;color:#555}
      table{width:100%;border-collapse:collapse}
    </style></head><body>
      <div class="center bold" style="font-size:16px;margin-bottom:4px">${nombre}</div>
      ${dir ? '<div class="center small">' + dir + '</div>' : ''}
      <div class="center small">CUIT: ${cuit}</div>
      <div class="center small" style="margin-bottom:8px">${fecha} ${hora}</div>
      ${clienteHtml}
      <div style="border-top:1px dashed #000;margin:8px 0"></div>
      <table>${itemsHtml}</table>
      <div style="border-top:1px dashed #000;margin:8px 0"></div>
      <table><tr><td class="bold">TOTAL</td><td style="text-align:right;font-weight:700;font-size:15px">$${(total || 0).toLocaleString("es-AR")}</td></tr></table>
      <div class="center small" style="margin-top:4px">Pago: ${metodo || "Efectivo"}</div>
      <div class="center small">${comprobante || ""}</div>
      ${afipHtml}
      <div class="center small" style="margin-top:12px;border-top:1px dashed #ccc;padding-top:8px">¡Gracias por su compra!</div>
    </body></html>`;
    const browser = await require("puppeteer").launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true, margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" } });
    await browser.close();
    const pdfPath = path.join(__dirname, "tmp_comprobante.pdf");
    fs.writeFileSync(pdfPath, pdfBuffer);
    let num = telefono.replace(/[^0-9]/g, "");
    if (!num.startsWith("54")) num = "549" + num;
    const chatId = num + "@c.us";
    const clientWpp = client;
    if (clientWpp && clientWpp.info && clientWpp.info.wid) {
      await clientWpp.sendMessage(chatId, { caption: `Comprobante ${nombre} — ${comprobante || ""}`, filename: "comprobante.pdf", mimetype: "application/pdf", document: fs.readFileSync(pdfPath) });
      try { fs.unlinkSync(pdfPath); } catch {}
      res.json({ ok: true });
    } else {
      try { fs.unlinkSync(pdfPath); } catch {}
      res.json({ ok: false, error: "WhatsApp no conectado" });
    }
  } catch (e) {
    console.error("[WA comprobante]", e.message);
    res.json({ ok: false, error: e.message });
  }
});

process.on("unhandledRejection", (err) => {
  console.log("⚠️  (ignorado) " + err.message);
});

process.on("exit", () => {
  backup.detenerBackups();
  db.closeDB();
});

const PORT = 3456;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  let ts = "";
  try { ts = require("child_process").execSync("tailscale ip -4", { encoding: "utf-8", timeout: 3000 }).trim(); } catch {}
  console.log(`\n🌐 Servidor web: http://localhost:${PORT}`);
  if (ts) console.log(`🔗 Tailscale:      http://${ts}:${PORT}`);
  console.log(`📡 Menú clientes:  http://localhost:${PORT}/menu-mesa.html?mesa=1`);
  console.log(`📡 Sistema:        http://localhost:${PORT}/prototipo-gestion-bar.html`);
  console.log(`💾 SQLite:         ${path.join(__dirname, "data", "martu.db")}`);
});
