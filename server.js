const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const path = require("path");
const fs = require("fs");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

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
    console.log(`⚠️  ${err.message || "Auth timeout"}. Reintentando en 15 seg...`);
    try { fs.unlinkSync("qr.txt"); } catch {}
    try { fs.rmSync(".wwebjs_auth", { recursive: true, force: true }); } catch {}
    setTimeout(iniciarWhatsApp, 15000);
  });
}
iniciarWhatsApp();

const CAJA_FILE = path.join(__dirname, "caja-state.json");
let CAJA_STATE = { caja: null, cajaIniciada: false, historialCierres: [], mesas: null, deliveries: null };
try { CAJA_STATE = JSON.parse(fs.readFileSync(CAJA_FILE, "utf-8")); } catch {}
if (typeof CAJA_STATE.cajaIniciada !== "boolean") CAJA_STATE.cajaIniciada = false;
if (!Array.isArray(CAJA_STATE.historialCierres)) CAJA_STATE.historialCierres = [];

app.get("/api/caja", (req, res) => {
  res.json(CAJA_STATE);
});

app.post("/api/caja", (req, res) => {
  const { caja, cajaIniciada, historialCierres, mesas, deliveries } = req.body;
  if (caja !== undefined) CAJA_STATE.caja = caja;
  if (cajaIniciada !== undefined) CAJA_STATE.cajaIniciada = cajaIniciada;
  if (historialCierres !== undefined) CAJA_STATE.historialCierres = historialCierres;
  if (mesas !== undefined) CAJA_STATE.mesas = mesas;
  if (deliveries !== undefined) CAJA_STATE.deliveries = deliveries;
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

app.get("/menu-delivery.html", (req, res) => { res.sendFile(path.join(__dirname, "menu-mesa.html")); });
app.get("/", (req, res) => { res.redirect("/prototipo-gestion-bar.html"); });
app.get("/menu-mesa.html", (req, res) => { res.sendFile(path.join(__dirname, "menu-mesa.html")); });

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
  console.log(`📡 QR WhatsApp:    http://localhost:${PORT}/qr`);
  console.log(`📡 Menú clientes:  http://localhost:${PORT}/menu-mesa.html?mesa=1`);
  console.log(`📡 Sistema:        http://localhost:${PORT}/prototipo-gestion-bar.html`);
});
