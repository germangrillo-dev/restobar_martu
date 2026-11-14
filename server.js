const express = require("express");
const net = require("net");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const db = require("./db");
const backup = require("./backup");
const { execFile } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use((req, res, next) => { const line = new Date().toISOString() + " " + req.method + " " + req.url; console.log("[REQ]", req.method, req.url); try { fs.appendFileSync(path.join(__dirname, "requests.log"), line + "\n"); } catch {} res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); res.set('Pragma', 'no-cache'); res.set('Expires', '0'); next(); });

// Acceso público (Tailscale Funnel): solo menú de delivery + visor + sus recursos
function esHostLocal(host) {
  const h = (host || "").toLowerCase().split(":")[0];
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "") return true;
  if (h.startsWith("192.168.")) return true;
  if (h.startsWith("10.")) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./.test(h)) return true; // Tailscale/CGNAT 100.64.0.0/10
  return false;
}

const PATHS_PUBLICOS = [
  "/", "/menu-delivery.html", "/visor.html",
  "/api/menu", "/api/config", "/api/pedidos/mesa", "/api/visor",
  "/app-icon.png", "/icon-192.png", "/icon-512.png", "/icon-192.svg", "/icon-512.svg",
  "/manifest.json", "/service-worker.js", "/favicon.ico",
  "/tmp_comprobante.pdf"
];
app.use((req, res, next) => {
  const host = (req.headers.host || "").toLowerCase();
  if (esHostLocal(host)) return next();
  if (req.path === "/api/update") return next(); // permitir actualización remota
  const p = req.path;
  if (p.startsWith("/comprobantes/")) return next();
  if (PATHS_PUBLICOS.indexOf(p) === -1) {
    return res.status(403).send("<!DOCTYPE html><html><body style=\"background:#1a1715;color:#f5efe6;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:20px\"><div><h1 style=\"color:#e8a23d\">Acceso restringido</h1><p style=\"color:#a89a8c\">Esta URL p\u00fablica es solo para el men\u00fa de delivery.</p><p><a href=\"/menu-delivery.html\" style=\"color:#e8a23d\">Ir al men\u00fa</a></p></div></body></html>");
  }
  next();
});

// --- Inicializar DB ---
db.initDB();
console.log("✅ Base de datos SQLite inicializada");

// Cerrar cajas viejas que quedaron activas por error (más de 1 día de antigüedad)
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
const ayer = new Date();
ayer.setDate(ayer.getDate() - 1);
const ayerStr = ayer.toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
try {
  const oldOpen = db.getDB().prepare("SELECT id FROM caja_sesiones WHERE activa = 1 AND fecha < ?").all(ayerStr);
  if (oldOpen.length > 0) {
    db.getDB().prepare("UPDATE caja_sesiones SET activa = 0 WHERE activa = 1 AND fecha < ?").run(ayerStr);
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
const DEFAULT_PRODUCTOS = [];

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

// --- Tailscale: estado y activación del acceso público (funnel) ---
const PUERTO_FUNNEL = 3456;
function tsBin() {
  const cands = [process.env.TAILSCALE_PATH, "C:\\Program Files\\Tailscale\\tailscale.exe",
    "C:\\Program Files (x86)\\Tailscale\\tailscale.exe", "C:\\ProgramData\\Tailscale\\tailscale.exe", "tailscale"].filter(Boolean);
  for (const c of cands) {
    try { if (c === "tailscale" || fs.existsSync(c)) return c; } catch {}
  }
  return "tailscale";
}
function ejecutarTs(args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile(tsBin(), args, { timeout: timeout || 45000, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
        const out = String(stdout || "") + String(stderr || "").trim();
        resolve({ ok: !err, out: out.trim(), codigo: err ? (err.code != null ? err.code : 1) : 0 });
      });
    } catch (e) { resolve({ ok: false, out: String((e && e.message) || e), codigo: 1 }); }
  });
}
app.get("/api/tailscale", async (req, res) => {
  const st = await ejecutarTs(["serve", "status"]);
  const ver = await ejecutarTs(["version"]);
  res.json({ ok: true, exe: tsBin(), version: ver.out, status: st.out, activo: st.ok && /funnel|https|3456/i.test(st.out) });
});
app.post("/api/tailscale/funnel", async (req, res) => {
  const on = (req.body && req.body.accion) !== "off";
  const pasos = [];
  if (on) {
    pasos.push({ cmd: "tailscale serve --bg " + PUERTO_FUNNEL, ...(await ejecutarTs(["serve", "--bg", String(PUERTO_FUNNEL)])) });
    pasos.push({ cmd: "tailscale funnel --bg " + PUERTO_FUNNEL, ...(await ejecutarTs(["funnel", "--bg", String(PUERTO_FUNNEL)])) });
    if (!pasos[pasos.length - 1].ok) {
      pasos.push({ cmd: "tailscale funnel --bg --set-path / " + PUERTO_FUNNEL, ...(await ejecutarTs(["funnel", "--bg", "--set-path", "/", String(PUERTO_FUNNEL)])) });
    }
  } else {
    pasos.push({ cmd: "tailscale funnel reset", ...(await ejecutarTs(["funnel", "reset"])) });
    pasos.push({ cmd: "tailscale serve reset", ...(await ejecutarTs(["serve", "reset"])) });
  }
  const st = await ejecutarTs(["serve", "status"]);
  const errores = pasos.filter(p => !p.ok).map(p => p.cmd + ": " + (p.out || "").split("\n").slice(0, 3).join(" ")).join(" | ");
  res.json({ ok: !errores, accion: on ? "on" : "off", pasos, errores, status: st.out, exe: tsBin() });
});

// --- Diagnostico de red local (QR en el celular por WiFi) ---
const { networkInterfaces } = require("os");
function ejecutarCmd(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 8000, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
        resolve({ ok: !err, texto: String(stdout || stderr || (err && err.message) || "").trim() });
      });
    } catch (e) { resolve({ ok: false, texto: e.message }); }
  });
}
function esIpLan(ip) { return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip || ""); }
app.get("/api/red", async (req, res) => {
  try {
    const cfg = db.getConfig();
    const ips = [];
    try {
      const nets = networkInterfaces();
      for (const k of Object.keys(nets)) {
        for (const a of (nets[k] || [])) {
          const fam = a.family === "IPv4" || a.family === 4;
          if (fam && !a.internal) ips.push({ iface: k, ip: a.address, lan: esIpLan(a.address) });
        }
      }
    } catch (e) { /* sin interfaces */ }
    ips.sort((a, b) => (b.lan ? 1 : 0) - (a.lan ? 1 : 0));
    const [ns, fw] = await Promise.all([
      ejecutarCmd("netstat", ["-an"]),
      ejecutarCmd("netsh", ["advfirewall", "firewall", "show", "rule", "name=Martu Resto Bar 3456"])
    ]);
    const escucha = ns.texto.split(/\r?\n/).filter((l) => l.indexOf(":3456") >= 0 && /LISTENING|ESCUCHANDO/i.test(l)).map((s) => s.trim()).slice(0, 6);
    const qrIp = String(cfg.qrUrl || "").replace(/^https?:\/\//, "").split(":")[0].split("/")[0];
    const noEncontrada = /no se encontr|ninguna regla coincide|not found|no element/i.test(fw.texto);
    const regla = noEncontrada ? "no creada" : (fw.ok ? "creada" : "sin permisos para leerla");
    res.json({
      qrUrl: cfg.qrUrl || "",
      publicUrl: cfg.publicUrl || "",
      ipDelQr: qrIp,
      qrIpEsLocal: !!qrIp && ips.some((i) => i.ip === qrIp),
      ips,
      escuchando: escucha,
      firewall: { ok: fw.ok, regla, texto: fw.texto.slice(0, 1200) },
      aviso: (escucha.length === 0 ? "El servidor NO esta escuchando en el puerto 3456." : "") + (!qrIp ? " Falta la URL QR en Configuracion > Local." : "") + (regla !== "creada" ? " El Firewall NO deja pasar el puerto 3456: hay que crear la regla (boton de abajo, como administrador)." : "")
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/red/firewall", async (req, res) => {
  await ejecutarCmd("netsh", ["advfirewall", "firewall", "delete", "rule", "name=Martu Resto Bar 3456"]);
  const r = await ejecutarCmd("netsh", ["advfirewall", "firewall", "add", "rule", "name=Martu Resto Bar 3456", "dir=in", "action=allow", "protocol=TCP", "localport=3456"]);
  res.json({ ok: r.ok, texto: (r.ok ? "Regla creada/actualizada. " : "No se pudo crear la regla (hace falta administrador). ") + r.texto.slice(0, 400) });
});

// --- Impresion termica por red (ESC/POS sobre TCP 9100) ---
const CP437 = { "á":160,"é":130,"í":161,"ó":162,"ú":163,"ñ":165,"Ñ":165,"ü":129,"Á":157,"É":147,"Í":161,"Ó":162,"Ú":163,"°":248,"º":167,"¿":191,"¡":173,"“":34,"”":34,"‘":39,"’":39,"—":45,"–":45,"…":26,"€":213,"·":250 };
function bytesTexto(s) {
  const out = [];
  for (const ch of String(s == null ? "" : s)) {
    if (CP437[ch] !== undefined) out.push(CP437[ch]);
    else { const c = ch.charCodeAt(0); out.push(c < 256 ? c : 63); }
  }
  return out;
}
// QR como imagen (GS v 0): funciona en cualquier impresora que ya imprime el logo
function qrRaster(texto) {
  const QRCode = require("qrcode");
  const q = QRCode.create(String(texto), { errorCorrectionLevel: "M" });
  const n = q.modules.size, borde = 2;
  const escala = Math.max(3, Math.floor(300 / (n + borde * 2)));
  const lado = (n + borde * 2) * escala;
  const fila = Math.ceil(lado / 8);
  const raw = Buffer.alloc(fila * lado);
  for (let y = 0; y < lado; y++) {
    const my = Math.floor(y / escala) - borde;
    for (let x = 0; x < lado; x++) {
      const mx = Math.floor(x / escala) - borde;
      if (mx >= 0 && my >= 0 && mx < n && my < n && q.modules.get(my, mx)) raw[y * fila + (x >> 3)] |= (0x80 >> (x & 7));
    }
  }
  return { raw, fila, alto: lado };
}
function construirESCPOS(lineas) {
  const b = [];
  const push = (...x) => b.push(...x);
  push(27, 64);                 // ESC @ init
  push(27, 97, 1);              // centrado
  for (const l of (lineas || [])) {
    if (l.qr) {
      try {
        const { raw, fila, alto } = qrRaster(l.qr);
        push(27, 97, 1);
        push(29, 118, 48, 0, fila & 255, (fila >> 8) & 255, alto & 255, (alto >> 8) & 255);
        for (let i = 0; i < raw.length; i++) b.push(raw[i]);
        push(10);
      } catch (e) { console.warn("[IMPRIMIR] QR invalido:", e.message); }
      continue;
    }
    if (l.logo) {
      try {
        const raw = Buffer.from(String(l.logo), "base64");
        const ancho = Number(l.ancho) || 576;
        const fila = Math.ceil(ancho / 8);
        const alto = Number(l.alto) || Math.floor(raw.length / fila);
        if (raw.length > 0 && alto > 0) {
          push(27, 97, 1);                                                   // centrado
          push(29, 118, 48, 0, fila & 255, (fila >> 8) & 255, alto & 255, (alto >> 8) & 255); // GS v 0
          for (let i = 0; i < raw.length; i++) b.push(raw[i]);
          push(10);
        }
      } catch (e) { console.warn("[IMPRIMIR] Logo inválido:", e.message); }
      continue;
    }
    const t = l.t == null ? "" : String(l.t);
    if (l.izq) push(27, 97, 0); else if (l.der) push(27, 97, 2); else push(27, 97, 1);
    push(27, 69, l.bold ? 1 : 0);        // ESC E negrita
    push(29, 33, l.grande ? 17 : 0);     // GS ! tamano
    if (l.rayita) push(29, 68, 2);       // GS D punteado
    push(...bytesTexto(t));
    if (l.rayita) push(29, 68, 0);
    push(27, 69, 0);
    push(29, 33, 0);
    push(10);
    for (let i = 0; i < (l.salto || 0); i++) push(10);
  }
  push(10, 10, 10);
  push(29, 86, 66, 0);          // GS V B 0 -> corte total
  return Buffer.from(b);
}
app.post("/api/imprimir", (req, res) => {
  const { ip, puerto, lineas } = req.body || {};
  if (!ip) return res.json({ ok: false, texto: "Falta la IP de la impresora." });
  const p = Number(puerto) || 9100;
  const data = construirESCPOS(lineas);
  const sock = new net.Socket();
  let respondido = false;
  const fin = (ok, texto) => { if (respondido) return; respondido = true; try { sock.destroy(); } catch {} res.json({ ok, texto }); };
  sock.setTimeout(5000);
  sock.on("timeout", () => fin(false, "Sin respuesta de " + ip + ":" + p));
  sock.on("error", (e) => fin(false, "No se pudo imprimir en " + ip + ":" + p + " (" + e.message + ")"));
  sock.connect(p, ip, () => {
    sock.write(data);
    setTimeout(() => fin(true, "Enviado a " + ip), 400);
  });
});


const MENU_CACHE = {};
function getConfig() { return db.getConfig(); }

const MENU_TEXTO = () => {
  const cfg = getConfig();
  const cats = [...new Set(PRODUCTOS.map(p => p.cat))];
  let txt = "🍕 *" + (cfg.nombreLocal || "Martu Resto Bar") + " - MENÚ*\n\n";
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
// Navegador para WhatsApp: Chrome o Edge instalados (si no, el que trae puppeteer)
const NAVEGADOR_WA = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((x) => { try { return fs.existsSync(x); } catch { return false; } });
const WA_OPTS = {
  puppeteer: { headless: true, ...(NAVEGADOR_WA ? { executablePath: NAVEGADOR_WA } : {}), args: ["--no-sandbox"] },
  authTimeoutMs: 120000,
};
const processedMsgIds = new Set();
// Estado de WhatsApp visible desde el sistema (Config > WhatsApp): ya no depende de ver la consola
const waEstado = { estado: "iniciando", qr: "", numero: "", nombre: "", error: "", desde: Date.now(), reintentos: 0 };
const waSet = (cambios) => { Object.assign(waEstado, cambios, { desde: Date.now() }); };
let waTimer = null;
function waReintentar(segundos, borrarSesion) {
  if (waTimer) return;
  waTimer = setTimeout(async () => {
    waTimer = null;
    try { if (client) await client.destroy(); } catch {}
    client = null;
    if (borrarSesion) { try { fs.rmSync(".wwebjs_auth", { recursive: true, force: true }); } catch {} }
    iniciarWhatsApp();
  }, segundos * 1000);
}

// Cierra el Chrome invisible de WhatsApp que pudo quedar de un arranque anterior del servidor
// (al reiniciar se cierra node pero ese Chrome sigue vivo y no deja usar la sesion: "The browser is already running")
function liberarNavegadorWA() {
  if (process.platform !== "win32") return;
  try {
    require("child_process").execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -like '*wwebjs_auth*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\"",
      { stdio: "ignore", timeout: 20000, windowsHide: true }
    );
  } catch {}
  for (const f of ["lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket"]) { try { fs.rmSync(path.join(".wwebjs_auth", "session", f), { force: true }); } catch {} }
}

function iniciarWhatsApp() {
  if (!client) liberarNavegadorWA();
  const authStrategy = new LocalAuth();
  waSet({ estado: "iniciando", qr: "", error: "" });
  client = new Client({ authStrategy, ...WA_OPTS });

  client.on("qr", (qr) => {
    waSet({ estado: "qr", qr, error: "" });
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(" ESCANEÁ ESTE QR CON WHATSAPP EN TU CELU");
    console.log("   (Abrí WhatsApp > 3 puntitos > WhatsApp Web)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    qrcode.generate(qr, { small: true });
    fs.writeFileSync("qr.txt", qr);
    console.log("📌 También podés ver el QR en http://localhost:3456/qr\n");
  });

  client.on("authenticated", () => { waSet({ estado: "autenticando", qr: "" }); try { fs.unlinkSync("qr.txt"); } catch {} });
  client.on("ready", () => {
    let numero = "", nombre = "";
    try { numero = (client.info && client.info.wid && client.info.wid.user) || ""; nombre = (client.info && client.info.pushname) || ""; } catch {}
    waSet({ estado: "conectado", qr: "", error: "", numero, nombre, reintentos: 0 });
    try { fs.unlinkSync("qr.txt"); } catch {}
    console.log("\n✅ WhatsApp conectado. Esperando mensajes...\n");
  });
  client.on("auth_failure", (m) => {
    console.log("⚠️  WhatsApp: fallo la sesion (" + m + "). Hay que escanear el QR de nuevo.");
    waSet({ estado: "error", error: "La sesión guardada no sirve más: hay que escanear el QR de nuevo.", qr: "" });
    waReintentar(5, true);
  });
  client.on("disconnected", (motivo) => {
    console.log("⚠️  WhatsApp desconectado:", motivo);
    const cerroSesion = String(motivo || "").toUpperCase().includes("LOGOUT");
    waSet({ estado: "desconectado", error: cerroSesion ? "Se cerró la sesión desde el celular: escaneá el QR de nuevo." : "Se desconectó (" + motivo + "). Reconectando...", qr: "", numero: "", nombre: "" });
    waReintentar(10, cerroSesion);
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
    // Evitar guardar LID (números largos sin @c.us) como teléfono
    let telefono = "";
    if (remitente.endsWith("@c.us")) telefono = remitente.split("@")[0];
    else if (contacto.number && /^\d{8,13}$/.test(contacto.number)) telefono = contacto.number;
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
        return;
      }
    }
    // No enviar el menú automáticamente en cada mensaje para evitar spam; solo en saludos (ya manejado arriba)
  });

  client.initialize().catch(err => {
    const msg = (err && err.message) || "Error";
    console.log(`⚠️  WhatsApp: ${msg}. Reintentando en 60 seg...`);
    try { fs.unlinkSync("qr.txt"); } catch {}
    waEstado.reintentos = (waEstado.reintentos || 0) + 1;
    waSet({ estado: "error", error: msg + (NAVEGADOR_WA ? "" : " (no se encontró Chrome ni Edge instalado)"), qr: "" });
    // Antes se borraba la sesion en cada error y obligaba a escanear de nuevo: ahora solo despues de varios fallos seguidos
    if (msg.includes("already running")) { client = null; liberarNavegadorWA(); }
    waReintentar(msg.includes("already running") ? 10 : 60, waEstado.reintentos >= 3 && !msg.includes("already running"));
  });
}

app.get("/api/whatsapp/estado", (req, res) => {
  res.json({ ok: true, estado: waEstado.estado, qr: waEstado.qr, numero: waEstado.numero, nombre: waEstado.nombre, error: waEstado.error, desde: waEstado.desde, navegador: NAVEGADOR_WA || "" });
});
app.post("/api/whatsapp/reconectar", (req, res) => {
  try {
    const { clave, nuevoQr } = req.body || {};
    let admins = (db.getUsuarios() || []).filter((u) => u.rol === "admin");
    if (!admins.length) admins = [{ clave: "1234" }];
    if (!admins.some((u) => String(u.clave) === String(clave || ""))) return res.status(403).json({ ok: false, error: "Clave de administrador incorrecta." });
    console.log("[WA] Reconexion pedida desde el sistema" + (nuevoQr ? " (nuevo QR)" : ""));
    waSet({ estado: "iniciando", qr: "", error: "", numero: "", nombre: "" });
    (async () => {
      if (nuevoQr) { try { if (client) await client.logout(); } catch {} }
      if (waTimer) { clearTimeout(waTimer); waTimer = null; }
      waReintentar(1, !!nuevoQr);
    })();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- API: Config ---
app.get("/api/config", (req, res) => {
  res.json(db.getConfig());
});

// Visor remoto (solo lectura): caja activa + movimientos + historial, protegido por PIN
app.get("/api/visor", (req, res) => {
  try {
    const cfg = getConfig();
    const pin = String(req.query.pin || "");
    const esperado = String(cfg.visorPin || "2468");
    if (pin !== esperado) return res.status(401).json({ ok: false, error: "PIN incorrecto" });
    const caja = db.getCaja();
    const historial = db.getHistorialCierres();
    res.json({ ok: true, caja, historial });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Deliveries: el estado nunca retrocede (una pestaña vieja no puede reabrir un pedido entregado) ---
const RANK_DELIVERY = { cocina: 0, despachado: 1, entregado: 2 };
function mergeDeliveries(actual, entrante) {
  const prev = new Map((actual || []).map((d) => [d.id, d]));
  return (entrante || []).map((d) => {
    const p = prev.get(d.id);
    if (!p) return d;
    const rp = RANK_DELIVERY[p.estado] != null ? RANK_DELIVERY[p.estado] : 0;
    const rn = RANK_DELIVERY[d.estado] != null ? RANK_DELIVERY[d.estado] : 0;
    return rn < rp ? { ...d, estado: p.estado } : d;
  });
}

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
  let movimientosBorrados = [];
  try { movimientosBorrados = db.getMovimientosBorrados(); } catch {}
  res.json({ caja, cajaIniciada, historialCierres, mesas, deliveries, config: cfg, insumos, stock, costos, proveedores, usuarios, facturaXNum, productos: PRODUCTOS, movimientosBorrados });
});

app.post("/api/caja", (req, res) => {
  try {
    const { caja, cajaIniciada, historialCierres, mesas, deliveries, config, insumos, stock, costos, proveedores, facturaXNum, usuarios, productos, abrirCaja } = req.body;
    let sinCaja = false;
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
          if (abrirCaja === true) {
            // Apertura real desde el boton "Abrir caja": nueva sesion + se limpian los deliveries del turno anterior
            const sesionId = db.createCaja(caja);
            console.log("[POST /api/caja] Nueva sesión:", sesionId);
            serverCaja = { id: sesionId };
            try { const n = db.archivarDeliveries(); console.log("[POST /api/caja] Apertura: " + n + " deliveries archivados"); } catch (e) { console.error("[POST /api/caja] Error archivando deliveries:", e.message); }
          } else {
            // Un dispositivo con datos viejos (caja ya cerrada) sigue sincronizando: no se abre una caja fantasma
            console.log("[POST /api/caja] Sync ignorado: no hay caja abierta y no es una apertura");
            sinCaja = true;
          }
        }
        if (serverCaja) {
          if (caja.movimientos) {
            // Una pantalla que se quedo con la caja anterior (ej. corte de luz / sin conexion) manda sus movimientos
            // despues de que se abrio la caja nueva: van a la caja de su fecha y turno, no a la que esta abierta
            let destino = serverCaja.id;
            const act = serverCaja.fecha !== undefined ? serverCaja : db.getCaja();
            if (act && caja.fecha && caja.turno && (caja.fecha !== act.fecha || caja.turno !== act.turno)) {
              const otra = db.getSesionPorFechaTurno(caja.fecha, caja.turno);
              if (otra && otra.id !== serverCaja.id) { destino = otra.id; console.log("[POST /api/caja] Pantalla con caja vieja (" + caja.fecha + " " + caja.turno + "): movimientos a sesión", destino); }
            }
            for (const mov of caja.movimientos) db.addMovimiento(destino, mov);
            console.log("[POST /api/caja] Sync", caja.movimientos.length, "movimientos a sesión", destino);
          }
          if (caja.arqueo && caja.fecha && caja.turno && serverCaja.fecha !== undefined && (caja.fecha !== serverCaja.fecha || caja.turno !== serverCaja.turno)) caja.arqueo = null;
          if (caja.arqueo) db.updateSesionArqueo(serverCaja.id, caja.arqueo);
        }
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
      db.saveDeliveries(mergeDeliveries(db.getDeliveries(), filtered));
    }

    // Config
    if (config !== undefined && config !== null) {
      // El modo de facturacion (prueba/real) y el punto de venta solo se cambian con /api/afip/config (clave admin)
      // Cuenta corriente y clientes van por /api/cc/movimientos y /api/clientes/ajuste (si no, una pantalla con la lista vieja borraba los cargos de otra)
      const { afipModo, afipPuntoVenta, cuentaCorriente: _cc, clientes: _cl, ...configResto } = config;
      db.saveConfig(configResto);
      delete MENU_CACHE.html;
    }

    // Insumos
    if (insumos !== undefined && Array.isArray(insumos) && insumos.length > 0) db.saveInsumos(insumos);
    // El stock ya no se guarda desde aca: cada pantalla mandaba su copia completa y una vieja pisaba a la nueva.
    // Ahora cada cambio va por /api/stock/ajuste (sumar/fijar), que es atomico en el servidor.
    if (costos !== undefined && typeof costos === "object" && Object.keys(costos).length > 0) db.saveCostos(costos);
    if (proveedores !== undefined && Array.isArray(proveedores) && proveedores.length > 0) db.saveProveedores(proveedores);
    if (usuarios !== undefined && Array.isArray(usuarios) && usuarios.length > 0) db.saveUsuarios(usuarios);
    if (facturaXNum !== undefined && typeof facturaXNum === "number" && facturaXNum > (db.getFacturaXNum() || 0)) db.setFacturaXNum(facturaXNum);
    if (productos !== undefined && Array.isArray(productos) && productos.length > 0) { PRODUCTOS = productos.map(p => ({ ...p, receta: p.receta || [] })); db.saveProductos(PRODUCTOS); Object.assign(prodPorRef, Object.fromEntries(PRODUCTOS.map(p => [p.ref, p]))); Object.assign(prodPorNombre, Object.fromEntries(PRODUCTOS.map(p => [p.nombre.toLowerCase(), p]))); }

    res.json({ ok: true, sinCaja });
  } catch (e) {
    console.error("[POST /api/caja] ERROR:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- API: Poner ventas/caja en cero ---
app.post("/api/reset", (req, res) => {
  try {
    db.resetVentas();
    delete MENU_CACHE.html;
    console.log("[RESET] Ventas y caja puestas en cero");
    res.json({ ok: true, texto: "Sistema puesto en cero." });
  } catch (e) {
    console.error("[RESET] ERROR:", e.message);
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
  const r = db.saveMesas(mesas) || { rechazadas: [], versiones: {} };
  res.json({ ok: true, rechazadas: r.rechazadas, versiones: r.versiones });
});

// --- API: Deliveries ---
app.get("/api/deliveries", (req, res) => {
  res.json(db.getDeliveries());
});
app.post("/api/deliveries", (req, res) => {
  const deliveries = req.body;
  if (!Array.isArray(deliveries)) return res.status(400).json({ error: "invalid" });
  const borrados = new Set(db.getDeliveriesBorrados());
  const filtered = deliveries.filter((d) => !borrados.has(d.id));
  db.saveDeliveries(mergeDeliveries(db.getDeliveries(), filtered));
  res.json({ ok: true });
});

// --- API: Cancelar (borrar) un delivery ---
app.post("/api/deliveries/delete", (req, res) => {
  try {
    const id = req.body && req.body.id;
    if (!id || typeof id !== "string") return res.status(400).json({ error: "id" });
    const ok = db.deleteDelivery(id);
    console.log("[DELIVERY DELETE]", id, ok ? "borrado" : "no existia");
    res.json({ ok: true, borrado: ok });
  } catch (e) {
    console.error("[DELIVERY DELETE] ERROR:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get("/api/deliveries/borrados", (req, res) => {
  try { res.json(db.getDeliveriesBorrados()); } catch (e) { res.json([]); }
});

// --- API: Eliminar una venta (requiere clave de administrador y motivo; queda registrado) ---
app.post("/api/caja/venta/eliminar", (req, res) => {
  try {
    const { id, clave, motivo, usuario } = req.body || {};
    if (!id || typeof id !== "string") return res.status(400).json({ ok: false, error: "Falta la venta." });
    if (!motivo || !String(motivo).trim()) return res.status(400).json({ ok: false, error: "Escribí el motivo." });
    let admins = (db.getUsuarios() || []).filter((u) => u.rol === "admin");
    if (!admins.length) admins = [{ nombre: "Admin", rol: "admin", clave: "1234" }];
    if (!admins.some((u) => String(u.clave) === String(clave || ""))) return res.status(403).json({ ok: false, error: "Clave de administrador incorrecta." });
    const mov = db.getMovimientoById(id);
    if (!mov) return res.status(404).json({ ok: false, error: "La venta no existe (puede que ya se haya eliminado)." });
    if (mov.tipo !== "venta") return res.status(400).json({ ok: false, error: "Solo se pueden eliminar ventas desde aca." });
    db.deleteMovimiento(id, { motivo: String(motivo).trim(), usuario: usuario || "" });
    console.log("[VENTA ELIMINADA]", id, mov.concepto, mov.monto, "-", motivo, "-", usuario);
    res.json({ ok: true });
  } catch (e) {
    console.error("[VENTA ELIMINADA] ERROR:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// --- API: Cambiar el medio de pago de una venta (clave de administrador + motivo; queda registrado) ---
app.post("/api/caja/venta/cambiar-medio", (req, res) => {
  try {
    const { id, metodo, ref, clave, motivo, usuario } = req.body || {};
    const CON_COMISION = ["Mercado Pago", "Tarjeta débito", "Tarjeta crédito"];
    const MEDIOS = ["Efectivo", "Transferencia", "Mercado Pago", "Tarjeta débito", "Tarjeta crédito"];
    if (!id || typeof id !== "string") return res.status(400).json({ ok: false, error: "Falta la venta." });
    if (!MEDIOS.includes(metodo)) return res.status(400).json({ ok: false, error: "Medio de pago inválido." });
    if (!motivo || !String(motivo).trim()) return res.status(400).json({ ok: false, error: "Escribí el motivo." });
    let admins = (db.getUsuarios() || []).filter((u) => u.rol === "admin");
    if (!admins.length) admins = [{ nombre: "Admin", rol: "admin", clave: "1234" }];
    if (!admins.some((u) => String(u.clave) === String(clave || ""))) return res.status(403).json({ ok: false, error: "Clave de administrador incorrecta." });
    const mov = db.getMovimientoById(id);
    if (!mov) return res.status(404).json({ ok: false, error: "La venta no existe." });
    if (mov.tipo !== "venta") return res.status(400).json({ ok: false, error: "Solo se puede cambiar el medio de una venta." });
    if (mov.metodo === "Cuenta corriente") return res.status(400).json({ ok: false, error: "Las ventas a cuenta corriente no se cambian desde aca." });
    let comision = CON_COMISION.includes(metodo) ? Math.round((Number(req.body.comision) || 0) * 100) / 100 : 0;
    if (comision < 0 || comision >= Number(mov.monto)) return res.status(400).json({ ok: false, error: "La comisión tiene que ser menor al total de la venta." });
    if (mov.metodo === metodo && (mov.ref || "") === (ref || "") && Math.abs((Number(mov.comision) || 0) - comision) < 0.01) return res.status(400).json({ ok: false, error: "La venta ya tiene ese medio de pago." });
    const nuevo = db.cambiarMedioMovimiento(id, { metodo, ref: ref || "", comision, motivo: String(motivo).trim(), usuario: usuario || "" });
    console.log("[VENTA MEDIO CAMBIADO]", id, mov.metodo, "->", metodo, "-", motivo, "-", usuario);
    res.json({ ok: true, mov: nuevo });
  } catch (e) {
    console.error("[VENTA MEDIO] ERROR:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// --- API: Ajustar stock (atomico) ---
app.post("/api/cc/movimientos", (req, res) => {
  try {
    const { entries } = req.body || {};
    const lista = db.agregarMovimientosCC(Array.isArray(entries) ? entries : []);
    console.log("[CC]", (entries || []).map((e) => e.tipo + " " + e.monto + " " + (e.concepto || "")).join(" | ").slice(0, 300));
    res.json({ ok: true, cuentaCorriente: lista });
  } catch (e) {
    console.error("[CC] ERROR:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// Detalle de los cargos de cuenta corriente que no guardaron sus items (cargos viejos de delivery):
// se buscan en los deliveries (actuales y archivados) por nombre del cliente y total
app.get("/api/cc/detalle", (req, res) => {
  try {
    const clienteId = String(req.query.clienteId || "");
    const cfg = db.getConfig();
    const cargos = (Array.isArray(cfg.cuentaCorriente) ? cfg.cuentaCorriente : []).filter((e) => e.clienteId === clienteId && e.tipo === "cargo" && !(Array.isArray(e.items) && e.items.length));
    const norm = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
    const dels = [...db.getDeliveries(), ...db.getDeliveriesArchivo()];
    const usados = new Set();
    const detalle = {};
    for (const e of cargos) {
      const m = String(e.concepto || "").match(/^Delivery:\s*(.+)$/i);
      if (!m) continue;
      const nombre = norm(m[1]);
      const cands = dels.filter((d) => d && !usados.has(d.id) && norm(d.cliente) === nombre && Math.abs((Number(d.total) || 0) - (Number(e.monto) || 0)) < 1 && Array.isArray(d.items) && d.items.length);
      if (!cands.length) continue;
      // el mas cercano a la fecha del cargo
      const fe = Date.parse(e.fecha || "") || 0;
      cands.sort((a, b) => Math.abs((Date.parse(a.fecha || "") || a.archivadoTs || 0) - fe) - Math.abs((Date.parse(b.fecha || "") || b.archivadoTs || 0) - fe));
      const d = cands[0]; usados.add(d.id);
      detalle[e.id] = d.items.map((it) => ({ nombre: it.nombre, cant: it.cant, precio: it.precio }));
    }
    res.json({ ok: true, detalle });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/clientes/ajuste", (req, res) => {
  try {
    const { guardar, borrar } = req.body || {};
    const clientes = db.ajustarClientes({ guardar, borrar });
    res.json({ ok: true, clientes });
  } catch (e) {
    console.error("[CLIENTES] ERROR:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/api/caja/mover-movimientos", (req, res) => {
  try {
    const { ids, sesionId, clave, usuario } = req.body || {};
    let admins = (db.getUsuarios() || []).filter((u) => u.rol === "admin");
    if (!admins.length) admins = [{ nombre: "Admin", rol: "admin", clave: "1234" }];
    if (!admins.some((u) => String(u.clave) === String(clave || ""))) return res.status(403).json({ ok: false, error: "Clave de administrador incorrecta." });
    if (!Array.isArray(ids) || !ids.length || !sesionId) return res.status(400).json({ ok: false, error: "Faltan datos." });
    const n = db.moverMovimientos(ids, sesionId);
    console.log("[CAJA] Movidos", n, "movimientos a sesión", sesionId, "por", usuario || "");
    res.json({ ok: true, movidos: n });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/stock/ajuste", (req, res) => {
  try {
    const { sumar, fijar, borrar, reemplazar, motivo } = req.body || {};
    const stock = db.ajustarStock({ sumar, fijar, borrar, reemplazar });
    console.log("[STOCK]", motivo || "", JSON.stringify({ sumar, fijar, borrar, reemplazo: !!reemplazar }).slice(0, 300));
    res.json({ ok: true, stock });
  } catch (e) {
    console.error("[STOCK] ERROR:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get("/api/caja/ventas-eliminadas", (req, res) => {
  try {
    const caja = db.getCaja();
    const sesion = req.query.sesion != null ? req.query.sesion : (caja ? caja.id : -1);
    res.json(db.getVentasEliminadas(sesion));
  } catch (e) { res.json([]); }
});

// --- API: Borrar un movimiento de caja (ej: cobro duplicado) ---
app.post("/api/caja/mov/delete", (req, res) => {
  try {
    const id = req.body && req.body.id;
    if (!id || typeof id !== "string") return res.status(400).json({ error: "id" });
    const ok = db.deleteMovimiento(id);
    console.log("[MOV DELETE]", id, ok ? "borrado" : "no existia");
    res.json({ ok, borrado: ok });
  } catch (e) {
    console.error("[MOV DELETE] ERROR:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- API: Facturas de compra ---
app.get("/api/facturas", (req, res) => {
  res.json(db.getFacturas());
});
app.post("/api/facturas/agregar", (req, res) => {
  try { const f = req.body; if (!f || !f.id) return res.status(400).json({ ok: false }); db.agregarFactura(f); res.json({ ok: true }); }
  catch (e) { console.error("[FACTURA] ERROR:", e.message); res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/facturas/borrar", (req, res) => {
  try { const { id } = req.body || {}; if (!id) return res.status(400).json({ ok: false }); db.borrarFactura(id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/costos/ajuste", (req, res) => {
  try { const costos = db.ajustarCostos((req.body || {}).fijar || {}); res.json({ ok: true, costos }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
  try { res.json(backup.listarBackups()); } catch (e) { res.json([]); }
});
app.post("/api/backups/crear", async (req, res) => {
  const result = await backup.crearBackup("manual");
  res.json(result);
});
app.post("/api/backups/restaurar", async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ ok: false, error: "Sin nombre" });
  const result = await backup.restaurarBackup(nombre);
  if (result.ok) {
    res.json({ ok: true, texto: "Restaurado. Reiniciando..." });
    require("./updater").restartServer(__dirname);
  } else {
    res.json(result);
  }
});

// --- API: Update ---
const updater = require("./updater");
// Version del archivo del sistema (para avisar a las pantallas que recarguen despues de una actualizacion)
app.get("/api/html-version", (req, res) => {
  try { const st = fs.statSync(path.join(__dirname, "marturestobar.html")); res.json({ v: Math.round(st.mtimeMs) + "-" + st.size }); } catch (e) { res.json({ v: null }); }
});
app.get("/api/version", (req, res) => {
  let version = {};
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8")); } catch {}
  res.json(version);
});
app.post("/api/update", async (req, res) => {
  const token = req.body && req.body.token;
  try {
    const result = await updater.updateFromGitHub(token);
    let version = {};
    try { version = JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8")); } catch {}
    res.json({ ok: true, texto: "Actualizado correctamente. Reiniciando...", backup: result.backupDir, version });
    updater.restartServer(__dirname);
  } catch (e) {
    console.error("[UPDATE ERROR]", e);
    res.json({ ok: false, texto: "Error al actualizar: " + e.message });
  }
});

// --- Static routes ---
app.get("/marturestobar.html", (req, res) => {
  const cfg = getConfig();
  const nombre = cfg.nombreLocal || "Martu Resto Bar";
  let html = fs.readFileSync(path.join(__dirname, "marturestobar.html"), "utf-8");
  html = html.replace("<title>El Mostrador</title>", "<title>" + nombre + "</title>");
  html = html.replace('<meta name="theme-color" content="#f5f0eb" />', '<meta name="theme-color" content="#f5f0eb" />\n<meta name="apple-mobile-web-app-title" content="' + nombre + '" />');
  res.set("Content-Type", "text/html");
  res.send(html);
});

// Redirect legacy URL for backwards compatibility
app.get("/prototipo-gestion-bar.html", (req, res) => { res.redirect("/marturestobar.html" + (req.url.includes("?") ? "?" + req.url.split("?").slice(1).join("?") : "")); });

app.use(express.static(path.join(__dirname)));

function serveMenu(req, res) {
  const cfg = getConfig();
  const nombre = cfg.nombreLocal || "Martu Resto Bar";
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
  const nombre = cfg.nombreLocal || "Martu Resto Bar";
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
  const nombre = cfg.nombreLocal || "Martu Resto Bar";
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
  const nombre = cfg.nombreLocal || "Martu Resto Bar";
  const url = PUBLIC_URL + "/menu-delivery.html";
  let html = fs.readFileSync(path.join(__dirname, "instructivo.html"), "utf-8");
  html = html.replace("COMPLETAR CON LA URL", url);
  html = html.replace("Menú Digital", nombre);
  html = html.replace("id=\"footerName\">Menú Digital", "id=\"footerName\">" + nombre);
  res.set("Content-Type", "text/html");
  res.send(html);
});

app.get("/menu-delivery.html", (req, res) => { serveMenu(req, res); });
app.get("/admin", (req, res) => { res.redirect("/marturestobar.html?mode=admin"); });
app.get("/", (req, res) => { const esPublico = !esHostLocal(req.headers.host || ""); res.redirect(esPublico ? "/menu-delivery.html" : "/marturestobar.html"); });
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
    res.send(`<html><body style="background:#1a1715;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;font-family:sans-serif"><h2 style="color:#e8a23d">Escaneá con WhatsApp</h2><p style="color:#a89a8c;margin-top:-8px">Abrí WhatsApp > 3 puntitos > WhatsApp Web</p><div style="background:#fff;padding:20px;border-radius:16px;margin-top:10px"><img src="/api/qr?size=300&data=${encodeURIComponent(qr)}" alt="QR WhatsApp"></div><p style="color:#6fa84a;font-size:13px;margin-top:16px">✅ Servidor funcionando en puerto 3456</p></body></html>`);
  } catch {
    res.send(`<html><body style="background:#1a1715;color:#f5efe6;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><p>⚠️ QR no disponible aún. Esperá a que se genere...</p></body></html>`);
  }
});

// --- QR local (sin depender de internet) ---
app.get("/api/qr", async (req, res) => {
  try {
    const QRCode = require("qrcode");
    const data = String(req.query.data || "");
    const size = Math.min(1024, Math.max(64, parseInt(req.query.size, 10) || 300));
    if (!data) return res.status(400).send("");
    const buf = await QRCode.toBuffer(data, { width: size, margin: 1, color: { dark: "#000000", light: "#ffffff" } });
    res.set("Content-Type", "image/png");
    res.send(buf);
  } catch (e) {
    console.error("[QR] ERROR:", e.message);
    res.status(500).send("");
  }
});

// --- AFIP ---
const afip = require("./afip");
// Configuracion de facturacion: modo prueba/real, punto de venta, tipo (C = monotributo)
const afipOpts = (cfg) => ({ produccion: cfg.afipModo === "produccion", cuit: Number(String(cfg.afipCuit || "27213414475").replace(/[^0-9]/g, "")) || 27213414475, puntoVenta: Number(cfg.afipPuntoVenta) || 2, cbteTipo: Number(cfg.afipCbteTipo) || 11 });
app.get("/api/afip/config", (req, res) => {
  const o = afipOpts(getConfig());
  const fs2 = require("fs"); const path2 = require("path");
  res.json({ ok: true, modo: o.produccion ? "produccion" : "homologacion", cuit: o.cuit, puntoVenta: o.puntoVenta, cbteTipo: o.cbteTipo, certProduccion: fs2.existsSync(path2.join(__dirname, "certificado-produccion.crt")) && fs2.existsSync(path2.join(__dirname, "privada-produccion.key")) });
});
app.post("/api/afip/config", (req, res) => {
  try {
    const { modo, puntoVenta, clave, usuario } = req.body || {};
    let admins = (db.getUsuarios() || []).filter((u) => u.rol === "admin");
    if (!admins.length) admins = [{ nombre: "Admin", rol: "admin", clave: "1234" }];
    if (!admins.some((u) => String(u.clave) === String(clave || ""))) return res.status(403).json({ ok: false, error: "Clave de administrador incorrecta." });
    if (modo !== "produccion" && modo !== "homologacion") return res.status(400).json({ ok: false, error: "Modo invalido." });
    const pv = parseInt(puntoVenta, 10);
    if (!(pv > 0 && pv < 100000)) return res.status(400).json({ ok: false, error: "Punto de venta invalido." });
    db.saveConfig({ afipModo: modo, afipPuntoVenta: pv });
    console.log("[AFIP CONFIG]", modo, "PV", pv, "por", usuario || "");
    res.json({ ok: true, modo, puntoVenta: pv });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/afip/test", async (req, res) => {
  try {
    const cfg = getConfig();
    const accessToken = req.body.accessToken || cfg.afipAccessToken || "";
    const o = afipOpts(cfg);
    const result = await afip.verificarPuntoVenta(o.produccion, accessToken, o);
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
    const o = afipOpts(cfg);
    // Condicion frente al IVA del receptor: la que viene, o la del cliente cargado con ese CUIT/DNI, o Consumidor Final
    const cli = data.cliente || {};
    const docCli = String(cli.cuit || "").replace(/[^0-9]/g, "");
    const delListado = docCli ? (Array.isArray(cfg.clientes) ? cfg.clientes : []).find((c) => String(c.cuit || "").replace(/[^0-9]/g, "") === docCli) : null;
    data.condicionIvaReceptor = Number(cli.condicionIva) || Number(delListado && delListado.condicionIva) || 5;
    const result = await afip.facturar(data, o.produccion, accessToken, o);
    console.log("[AFIP] Factura", result.cbteTipo === 11 ? "C" : result.cbteTipo, o.produccion ? "REAL" : "PRUEBA", "PV", result.ptoVenta, "Nro", result.cbteNro, "CAE", result.cae);
    res.json({ ok: true, cae: result.cae, vencimiento: result.vencimiento, cbteNro: result.cbteNro, ptoVenta: result.ptoVenta, cbteTipo: result.cbteTipo, produccion: result.produccion, fecha: result.fecha, total: result.total, cuit: result.cuit, docTipo: result.docTipo, docNro: result.docNro, condicionIva: result.condicionIva });
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

// Guardar el Access Token de AfipSDK en el servidor (persistente y compartido entre equipos)
app.post("/api/afip/token", (req, res) => {
  try {
    const tok = (req.body && req.body.accessToken) || "";
    const cfg = getConfig();
    cfg.afipAccessToken = tok;
    db.saveConfig({ afipAccessToken: tok });
    res.json({ ok: true, guardado: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/whatsapp/comprobante", async (req, res) => {
  try {
    const cfg = getConfig();
    const { telefono, items, total, metodo, comprobante, afip: afipData, cliente, clienteData, localName, remitente } = req.body;
    if (!telefono && !remitente) return res.status(400).json({ ok: false, error: "Sin teléfono" });
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
    let afipQrImg = "";
    if (afipData && afipData.cae) {
      try {
        const f = String(afipData.fecha || "");
        const j = { ver: 1, fecha: /^\d{8}$/.test(f) ? f.slice(0, 4) + "-" + f.slice(4, 6) + "-" + f.slice(6, 8) : new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10), cuit: Number(afipData.cuit) || 27213414475, ptoVta: Number(afipData.ptoVenta) || 2, tipoCmp: Number(afipData.cbteTipo) || 11, nroCmp: Number(afipData.cbteNro) || 0, importe: Number(afipData.total) || Number(total) || 0, moneda: "PES", ctz: 1, tipoDocRec: Number(afipData.docTipo) || 99, nroDocRec: Number(afipData.docNro) || 0, tipoCodAut: "E", codAut: Number(afipData.cae) };
        afipQrImg = await require("qrcode").toDataURL("https://www.afip.gob.ar/fe/qr/?p=" + Buffer.from(JSON.stringify(j)).toString("base64"), { margin: 1, width: 240 });
      } catch (e) { console.warn("[QR] factura:", e.message); }
      afipHtml = `<div style="border-top:1px dashed #ccc;margin-top:12px;padding-top:8px;font-size:11px;color:#555">
        <div><b>Factura C${afipData.produccion === false ? " (PRUEBA - sin validez fiscal)" : ""}</b></div>
        <div>CAE: ${afipData.cae}</div>
        <div>Vto CAE: ${afipData.vencimiento || ""}</div>
        <div>Cbte N°: ${afipData.cbteNro || ""}</div>
        <div>Pto Venta: ${afipData.ptoVenta || "2"}</div>
        <div>CUIT: ${cuit}</div>
        <div>Régimen: Monotributo</div>
        <div>A ${({ 1: "IVA Responsable Inscripto", 4: "IVA Exento", 6: "Responsable Monotributo", 7: "Sujeto no categorizado", 10: "IVA Liberado", 15: "IVA No Alcanzado" })[Number(afipData.condicionIva)] || "Consumidor Final"}</div>
        ${afipQrImg ? `<div style="text-align:center;margin-top:8px"><img src="${afipQrImg}" style="width:120px;height:120px"></div><div style="text-align:center">Comprobante autorizado por ARCA</div>` : ""}
      </div>`;
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Courier New',monospace;width:100%;max-width:300px;padding:8px;background:#fff;color:#000;font-size:12px}
      @page{size:80mm auto;margin:4mm}
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
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 10000 });
    const pdfBuffer = await page.pdf({ width: "80mm", height: "200mm", printBackground: true, margin: { top: "4mm", bottom: "4mm", left: "4mm", right: "4mm" } });
    await browser.close();
    const carpetaComp = path.join(__dirname, "comprobantes");
    if (!fs.existsSync(carpetaComp)) fs.mkdirSync(carpetaComp, { recursive: true });
    const nombreArchivo = "comprobante_" + Date.now() + ".pdf";
    const pdfPath = path.join(carpetaComp, nombreArchivo);
    fs.writeFileSync(pdfPath, pdfBuffer);
    // Mantener también el último para compatibilidad
    fs.writeFileSync(path.join(__dirname, "tmp_comprobante.pdf"), pdfBuffer);
    let num = (telefono || "").replace(/[^0-9]/g, "");
    if (num && !num.startsWith("54")) num = "549" + num;
    const clientWpp = client;
    let chatId = null;
    if (remitente && remitente.includes("@")) chatId = remitente;
    else if (num) chatId = num + "@c.us";
    if (!chatId) return res.status(400).json({ ok: false, error: "Sin destinatario" });
    if (clientWpp && clientWpp.info && clientWpp.info.wid) {
      const pdfUrl = (cfg.publicUrl || PUBLIC_URL || "http://localhost:3456") + "/comprobantes/" + nombreArchivo;
      await clientWpp.sendMessage(chatId, `Comprobante ${nombre} - ${comprobante || ""}\nTotal: $${(total || 0).toLocaleString("es-AR")}\nDescargá tu PDF: ${pdfUrl}`);
      res.json({ ok: true, archivo: nombreArchivo });
    } else {
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

app.get("/tmp_comprobante.pdf", (req, res) => {
  const p = path.join(__dirname, "tmp_comprobante.pdf");
  if (!fs.existsSync(p)) return res.status(404).send("No PDF");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=comprobante.pdf");
  res.sendFile(p);
});

app.get("/comprobantes/:file", (req, res) => {
  const p = path.join(__dirname, "comprobantes", path.basename(req.params.file));
  if (!fs.existsSync(p)) return res.status(404).send("No PDF");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=" + path.basename(p));
  res.sendFile(p);
});

app.get("/api/caja/sesiones", (req, res) => {
  try {
    const dbx = db.getDB();
    const sesiones = dbx.prepare("SELECT * FROM caja_sesiones ORDER BY id DESC").all();
    const out = sesiones.map(s => {
      const movs = dbx.prepare("SELECT * FROM movimientos WHERE sesion_id = ?").all(s.id);
      return { id: s.id, fecha: s.fecha, turno: s.turno, usuario: s.usuario, activa: s.activa, apertura: s.apertura, cierre: s.cierre, diff: s.diff, movimientos: movs.length, totalVentas: movs.filter(m => m.tipo === "venta").reduce((a,m)=>a+m.monto,0) };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recuperar movimientos de una sesión cerrada reciente si la caja activa está vacía
try {
  const activa = db.getCaja();
  if (activa && (!activa.movimientos || activa.movimientos.length === 0)) {
    const ultimaCerrada = db.getDB().prepare("SELECT id FROM caja_sesiones WHERE activa = 0 AND (SELECT COUNT(*) FROM movimientos WHERE sesion_id = caja_sesiones.id) > 0 ORDER BY id DESC LIMIT 1").get();
    if (ultimaCerrada) {
      db.getDB().prepare("UPDATE movimientos SET sesion_id = ? WHERE sesion_id = ?").run(activa.id, ultimaCerrada.id);
      console.log("Recovered movements from session " + ultimaCerrada.id + " to active session " + activa.id);
    }
  }
} catch (e) { console.error("Recovery error:", e.message); }

app.post("/api/caja/sesion/delete", (req, res) => {
  try {
    const { id } = req.body || {};
    const ok = db.deleteCajaSession(id);
    res.json({ ok });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/caja/sesion/editar", (req, res) => {
  try {
    const { id, cierre, diff, arqueo } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "Sin id" });
    db.getDB().prepare("UPDATE caja_sesiones SET cierre = ?, diff = ?, arqueo = ? WHERE id = ? AND activa = 0").run(cierre || 0, diff || 0, JSON.stringify(arqueo || {}), id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/db/download", async (req, res) => {
  if (!esHostLocal(req.headers.host || "")) return res.status(403).send("Forbidden");
  try {
    const tmpPath = path.join(__dirname, "data", "martu_download.db");
    await db.backupDB(tmpPath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", "attachment; filename=martu.db");
    res.sendFile(tmpPath, () => { try { fs.unlinkSync(tmpPath); } catch {} });
  } catch (e) {
    console.error("[DB DOWNLOAD] backup error:", e.message);
    try { db.getDB().pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    const p = path.join(__dirname, "data", "martu.db");
    if (!fs.existsSync(p)) return res.status(404).send("No DB");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", "attachment; filename=martu.db");
    res.sendFile(p);
  }
});

const PORT = 3456;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  let ts = "";
  try { ts = require("child_process").execSync("tailscale ip -4", { encoding: "utf-8", timeout: 3000 }).trim(); } catch {}
  console.log(`\n🌐 Servidor web: http://localhost:${PORT}`);
  if (ts) console.log(`🔗 Tailscale:      http://${ts}:${PORT}`);
  console.log(`📡 Menú clientes:  http://localhost:${PORT}/menu-mesa.html?mesa=1`);
  console.log(`📡 Sistema:        http://localhost:${PORT}/marturestobar.html`);
  console.log(`💾 SQLite:         ${path.join(__dirname, "data", "martu.db")}`);
  iniciarWhatsApp();
});
