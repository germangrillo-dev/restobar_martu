const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const path = require("path");
const fs = require("fs");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.get("/prototipo-gestion-bar.html", (req, res) => {
  const nombre = (CAJA_STATE.config || {}).nombreLocal || "El Mostrador";
  let html = fs.readFileSync(path.join(__dirname, "prototipo-gestion-bar.html"), "utf-8");
  html = html.replace("<title>El Mostrador</title>", "<title>" + nombre + "</title>");
  html = html.replace('<meta name="theme-color" content="#1a1715" />', '<meta name="theme-color" content="#1a1715" />\n<meta name="apple-mobile-web-app-title" content="' + nombre + '" />');
  res.set("Content-Type", "text/html");
  res.send(html);
});

app.use(express.static(path.join(__dirname)));

const MENU_CACHE = {};

function serveMenu(req, res) {
  const nombre = (CAJA_STATE.config || {}).nombreLocal || "El Mostrador";
  const logo = (CAJA_STATE.config || {}).logo || "";
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

const PEDIDOS_FILE = path.join(__dirname, "pedidos-whatsapp.json");
const PROD_FILE = path.join(__dirname, "productos.json");
let pedidosPendientes = [];
try { pedidosPendientes = JSON.parse(fs.readFileSync(PEDIDOS_FILE, "utf-8")); } catch {}

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

let PRODUCTOS = [];
try { PRODUCTOS = JSON.parse(fs.readFileSync(PROD_FILE, "utf-8")); } catch {}
if (!PRODUCTOS.length) { PRODUCTOS = DEFAULT_PRODUCTOS; fs.writeFileSync(PROD_FILE, JSON.stringify(PRODUCTOS, null, 2)); }

const prodPorRef = Object.fromEntries(PRODUCTOS.map(p => [p.ref, p]));
const prodPorNombre = Object.fromEntries(PRODUCTOS.map(p => [p.nombre.toLowerCase(), p]));
const DIR_KEYWORDS = ["calle", "av ", "avenida", "pasaje", "ruta", "bulevar", "esq", "nro", "depto", "piso", "manzana", "barrio", "casa", "km"];

let PUBLIC_URL = "http://localhost:3456";

app.post("/api/public-url", (req, res) => {
  PUBLIC_URL = req.body.url || PUBLIC_URL;
  res.json({ ok: true, url: PUBLIC_URL });
});

const MENU_TEXTO = () => {
  const cats = [...new Set(PRODUCTOS.map(p => p.cat))];
  let txt = "🍕 *EL MOSTRADOR - MENÚ*\n\n";
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
    // Cantidad + número: "2x1" o "2x 1"
    const cantNum = p.match(/^(\d+)\s*x\s*(\d{1,3})$/i);
    if (cantNum) {
      const prod = prodPorRef[parseInt(cantNum[2])];
      if (prod) { items.push({ nombre: prod.nombre, ref: prod.ref, cant: parseInt(cantNum[1]), nota: "" }); continue; }
    }
    // Solo número de producto: "1"
    const soloNum = p.match(/^(\d{1,3})$/);
    if (soloNum) {
      const prod = prodPorRef[parseInt(soloNum[1])];
      if (prod) { items.push({ nombre: prod.nombre, ref: prod.ref, cant: 1, nota: "" }); continue; }
    }
    // Formato viejo: "2x Muzzarella" o "2 Muzzarella"
    const notaMatch = p.match(/^(.+?)\((.+?)\)$/);
    const sinNota = notaMatch ? notaMatch[1].trim() : p;
    const nota = notaMatch ? notaMatch[2].trim() : "";
    let cant = 1, nombre = sinNota.replace(/^[\s,]+|[\s,]+$/g, "");
    const m1 = sinNota.match(/^(\d+)\s*x\s*(.+)/i) || sinNota.match(/^(\d+)\s+(.+)/);
    if (m1) { cant = parseInt(m1[1]); nombre = m1[2].trim().replace(/^[\s,]+|[\s,]+$/g, ""); }
    else { const m2 = sinNota.match(/^(.+?)\s*x\s*(\d+)$/i); if (m2) { cant = parseInt(m2[2]); nombre = m2[1].trim().replace(/^[\s,]+|[\s,]+$/g, ""); } }
    const nlow = nombre.toLowerCase();
    const prod = prodPorNombre[nlow] || PRODUCTOS.find(p => nlow.includes(p.nombre.toLowerCase()) || p.nombre.toLowerCase().includes(nlow) || nlow.startsWith(p.nombre.toLowerCase().slice(0, 5)));
    if (prod) { items.push({ nombre: prod.nombre, ref: prod.ref, cant, nota }); continue; }
    partesTexto.push(p);
  }
  // Asignar texto: última parte con keyword → dirección, el resto → nombre
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
        pedidosPendientes.unshift(pedido);
        fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidosPendientes, null, 2));
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

const CAJA_FILE = path.join(__dirname, "caja-state.json");
let CAJA_STATE = { caja: null, cajaIniciada: false, historialCierres: [], mesas: null, deliveries: null, insumos: null, stock: null, costos: null, proveedores: null };
try { CAJA_STATE = JSON.parse(fs.readFileSync(CAJA_FILE, "utf-8")); } catch {}
if (typeof CAJA_STATE.cajaIniciada !== "boolean") CAJA_STATE.cajaIniciada = false;
if (!Array.isArray(CAJA_STATE.historialCierres)) CAJA_STATE.historialCierres = [];

app.get("/api/caja", (req, res) => {
  res.json(CAJA_STATE);
});

app.post("/api/caja", (req, res) => {
  try {
  const { caja, cajaIniciada, historialCierres, mesas, deliveries, config, insumos, stock, costos, proveedores, facturaXNum, usuarios } = req.body;
  console.log("[POST /api/caja] mesas recibidas:", mesas ? Object.entries(mesas).map(([k, v]) => k + ":" + JSON.stringify({ l: (v.lineas||[]).length, e: (v.enviado||[]).length, d: (v.despachado||[]).length, b: (v.bebidas||[]).length })) : "null");

  // Client is authority for caja movements
  if (caja !== undefined && caja !== null) {
    const serverFecha = CAJA_STATE.caja && CAJA_STATE.caja.fecha;
    const clientFecha = caja.fecha;
    const today = new Date().toLocaleDateString('sv-SE');

    // New day detected: archive old caja to historialCierres, start fresh
    if (serverFecha && serverFecha !== today && CAJA_STATE.caja.movimientos && CAJA_STATE.caja.movimientos.length > 0) {
      console.log("[POST /api/caja] New day detected, archiving caja from", serverFecha);
      CAJA_STATE.historialCierres = CAJA_STATE.historialCierres || [];
      CAJA_STATE.historialCierres.push({ ...CAJA_STATE.caja, fecha: serverFecha });
      CAJA_STATE.caja = { fecha: today, apertura: null, movimientos: [], cierre: null, saldoFinal: null, turno: "", usuario: "", arqueo: {} };
      CAJA_STATE.cajaIniciada = false;
    }

    // Only accept caja from today - reject stale data from localStorage
    if (clientFecha === today) {
      CAJA_STATE.caja = caja;
    } else {
      console.log("[POST /api/caja] Ignoring stale caja (client:", clientFecha, "≠ today:", today, ")");
    }
  }

  if (cajaIniciada !== undefined) CAJA_STATE.cajaIniciada = cajaIniciada;

  // Client is authority for historialCierres - replace
  if (historialCierres !== undefined && Array.isArray(historialCierres)) {
    CAJA_STATE.historialCierres = historialCierres;
  }

  // Merge mesas - client always wins (one person edits a mesa at a time)
  if (mesas !== undefined && mesas !== null) {
    if (!CAJA_STATE.mesas) CAJA_STATE.mesas = mesas;
    else {
      for (const [id, clientMesa] of Object.entries(mesas)) {
        CAJA_STATE.mesas[id] = clientMesa;
      }
    }
  }

  // Merge deliveries by ID (keep local state priority for entregado/despachado)
  if (deliveries !== undefined && deliveries !== null) {
    if (!CAJA_STATE.deliveries) {
      CAJA_STATE.deliveries = deliveries;
    } else {
      const serverDelIds = new Set(CAJA_STATE.deliveries.map(d => d.id));
      const clientOnlyDels = deliveries.filter(d => !serverDelIds.has(d.id));
      const merged = [...CAJA_STATE.deliveries];
      for (const clientDel of deliveries) {
        const idx = merged.findIndex(d => d.id === clientDel.id);
        if (idx >= 0) {
          merged[idx] = { ...merged[idx], ...clientDel };
        }
      }
      CAJA_STATE.deliveries = [...merged, ...clientOnlyDels];
    }
    // Clean: remove entregado deliveries (fully done)
    CAJA_STATE.deliveries = CAJA_STATE.deliveries.filter(d => (d.estado || "cocina") !== "entregado");
  }

  if (config !== undefined && config !== null) {
    if (!CAJA_STATE.config) CAJA_STATE.config = {};
    for (const [k, v] of Object.entries(config)) {
      if (v !== "" && v !== null && v !== undefined) CAJA_STATE.config[k] = v;
    }
    delete MENU_CACHE.html;
  }
  if (insumos !== undefined && Array.isArray(insumos) && insumos.length > 0) CAJA_STATE.insumos = insumos;
  if (stock !== undefined && typeof stock === "object" && Object.keys(stock).length > 0) CAJA_STATE.stock = stock;
  if (costos !== undefined && typeof costos === "object" && Object.keys(costos).length > 0) CAJA_STATE.costos = costos;
  if (proveedores !== undefined && Array.isArray(proveedores) && proveedores.length > 0) CAJA_STATE.proveedores = proveedores;
  if (usuarios !== undefined && Array.isArray(usuarios) && usuarios.length > 0) CAJA_STATE.usuarios = usuarios;
  if (facturaXNum !== undefined && typeof facturaXNum === "number" && facturaXNum > (CAJA_STATE.facturaXNum || 0)) CAJA_STATE.facturaXNum = facturaXNum;
  fs.writeFileSync(CAJA_FILE, JSON.stringify(CAJA_STATE, null, 2));
  res.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/caja] ERROR:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Endpoints separados para mesas y deliveries ---
app.get("/api/mesas", (req, res) => {
  res.json(CAJA_STATE.mesas || {});
});
app.post("/api/mesas", (req, res) => {
  const mesas = req.body;
  if (!mesas || typeof mesas !== "object") return res.status(400).json({ error: "invalid" });
  CAJA_STATE.mesas = mesas;
  fs.writeFileSync(CAJA_FILE, JSON.stringify(CAJA_STATE, null, 2));
  res.json({ ok: true });
});
app.get("/api/deliveries", (req, res) => {
  res.json((CAJA_STATE.deliveries || []).filter(d => (d.estado || "cocina") !== "entregado"));
});
app.post("/api/deliveries", (req, res) => {
  const deliveries = req.body;
  if (!Array.isArray(deliveries)) return res.status(400).json({ error: "invalid" });
  CAJA_STATE.deliveries = deliveries.filter(d => (d.estado || "cocina") !== "entregado");
  fs.writeFileSync(CAJA_FILE, JSON.stringify(CAJA_STATE, null, 2));
  res.json({ ok: true });
});

// --- API REST ---
app.get("/api/productos", (req, res) => {
  res.json(PRODUCTOS);
});

app.put("/api/productos", (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ ok: false, error: "se espera un array" });
  PRODUCTOS = req.body.map(p => ({ ...p, receta: p.receta || [] }));
  fs.writeFileSync(PROD_FILE, JSON.stringify(PRODUCTOS, null, 2));
  Object.assign(prodPorRef, Object.fromEntries(PRODUCTOS.map(p => [p.ref, p])));
  Object.assign(prodPorNombre, Object.fromEntries(PRODUCTOS.map(p => [p.nombre.toLowerCase(), p])));
  res.json({ ok: true });
});

app.get("/api/pedidos", (req, res) => {
  res.json(pedidosPendientes.filter(p => !p.leido));
});

app.get("/api/pedidos/pendientes", (req, res) => {
  res.json(pedidosPendientes.filter(p => !p.enviado));
});

app.post("/api/pedidos/:id/leido", (req, res) => {
  pedidosPendientes = pedidosPendientes.map(p => p.id === req.params.id ? { ...p, leido: true } : p);
  fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidosPendientes, null, 2));
  res.json({ ok: true });
});

app.post("/api/pedidos/:id/enviado", (req, res) => {
  pedidosPendientes = pedidosPendientes.map(p => p.id === req.params.id ? { ...p, enviado: true, leido: true } : p);
  fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidosPendientes, null, 2));
  res.json({ ok: true });
});

app.post("/api/pedidos/:id/entregado", (req, res) => {
  pedidosPendientes = pedidosPendientes.filter(p => p.id !== req.params.id);
  fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidosPendientes, null, 2));
  res.json({ ok: true });
});

app.get("/api/menu", (req, res) => {
  res.json(PRODUCTOS);
});

app.get("/api/config", (req, res) => {
  res.json(CAJA_STATE.config || {});
});

app.get("/app-icon.png", (req, res) => {
  const logo = (CAJA_STATE.config || {}).logo;
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
  const nombre = (CAJA_STATE.config || {}).nombreLocal || "El Mostrador";
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
  const nombre = (CAJA_STATE.config || {}).nombreLocal || "El Mostrador";
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
  const nombre = (CAJA_STATE.config || {}).nombreLocal || "El Mostrador";
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
    hora: new Date().toLocaleString("es-AR", { hour: "2-digit", minute: "2-digit" }),
    leido: false,
    enviado: false
  };
  pedidosPendientes.unshift(pedido);
  fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidosPendientes, null, 2));
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

// --- API Update ---
app.post("/api/update", (req, res) => {
  const { execSync } = require("child_process");
  try {
    execSync("git pull origin main", { encoding: "utf-8", timeout: 30000 });
    res.json({ ok: true, texto: "Actualizado correctamente. Reiniciando..." });
    setTimeout(() => { process.exit(0); }, 1000);
  } catch (e) {
    res.json({ ok: false, texto: "Error al actualizar: " + e.message });
  }
});

// --- AFIP Facturación Electrónica ---
const afip = require("./afip");

app.post("/api/afip/test", async (req, res) => {
  try {
    const accessToken = req.body.accessToken || (CAJA_STATE.config || {}).afipAccessToken || "";
    const result = await afip.verificarPuntoVenta(false, accessToken);
    res.json(result);
  } catch (e) {
    res.json({ ok: false, mensaje: e.message });
  }
});

app.post("/api/afip/facturar", async (req, res) => {
  try {
    const data = req.body;
    if (!data.items || !data.items.length) return res.status(400).json({ ok: false, error: "Sin items" });
    const accessToken = data.accessToken || (CAJA_STATE.config || {}).afipAccessToken || "";
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
    const accessToken = (CAJA_STATE.config || {}).afipAccessToken || "";
    const token = await afip.getWSAAToken(false, accessToken);
    res.json({ ok: true, token: token.token ? token.token.substring(0, 20) + "..." : "OK" });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/whatsapp/comprobante", async (req, res) => {
  try {
    const { telefono, items, total, metodo, comprobante, afip, cliente, localName } = req.body;
    if (!telefono) return res.status(400).json({ ok: false, error: "Sin teléfono" });
    const nombre = (CAJA_STATE.config || {}).nombreLocal || localName || "El Mostrador";
    const dir = (CAJA_STATE.config || {}).direccion || "YPF El Cruce / Ruta Nac 157 y 64";
    const cuit = (CAJA_STATE.config || {}).cuit || "27-21341447-5";
    const now = new Date();
    const fecha = now.toLocaleDateString("es-AR");
    const hora = now.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
    let itemsHtml = (items || []).map(it => `<tr><td style="padding:4px 0">${it.cant || 1}x ${it.nombre}</td><td style="text-align:right;padding:4px 0">$${((it.precio || 0) * (it.cant || 1)).toLocaleString("es-AR")}</td></tr>`).join("");
    let afipHtml = "";
    if (afip && afip.cae) {
      afipHtml = `<div style="border-top:1px dashed #ccc;margin-top:12px;padding-top:8px;font-size:11px;color:#555">
        <div><b>Factura Electrónica</b></div>
        <div>CAE: ${afip.cae}</div>
        <div>Vto CAE: ${afip.vencimiento || ""}</div>
        <div>Cbte N°: ${afip.cbteNro || ""}</div>
        <div>Pto Venta: ${afip.ptoVenta || "2"}</div>
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

const PORT = 3456;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  let ts = "";
  try { ts = require("child_process").execSync("tailscale ip -4", { encoding: "utf-8", timeout: 3000 }).trim(); } catch {}
  console.log(`\n🌐 Servidor web: http://localhost:${PORT}`);
  if (ts) console.log(`🔗 Tailscale:      http://${ts}:${PORT}`);
  console.log(`📡 Menú clientes:  http://localhost:${PORT}/menu-mesa.html?mesa=1`);
  console.log(`📡 Sistema:        http://localhost:${PORT}/prototipo-gestion-bar.html`);
});
