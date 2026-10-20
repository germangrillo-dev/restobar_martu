const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync, spawn } = require("child_process");

const OWNER = "germangrillo-dev";
const REPO = "restobar_martu";
const BRANCH = "main";

function httpGet(url, headers, redirects) {
  redirects = redirects === undefined ? 5 : redirects;
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
        res.resume();
        const next = loc.indexOf("http") === 0 ? loc : new URL(loc, url).toString();
        return resolve(httpGet(next, headers, redirects - 1));
      }
      resolve(res);
    }).on("error", reject);
  });
}

function readAll(res) {
  return new Promise((resolve, reject) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => resolve(data));
    res.on("error", reject);
  });
}

function download(url, dest, token, redirectCount) {
  redirectCount = redirectCount === undefined ? 5 : redirectCount;
  const headers = { "User-Agent": "martu-updater" };
  if (token) headers["Authorization"] = "Bearer " + token;
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirectCount > 0) {
        res.resume();
        const next = loc.indexOf("http") === 0 ? loc : new URL(loc, url).toString();
        return resolve(download(next, dest, token, redirectCount - 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode + " descargando " + url));
      }
      const dir = path.dirname(dest);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    }).on("error", reject);
  });
}

function borrarDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function listarArchivos(base, prefix, out) {
  prefix = prefix || "";
  out = out || [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) listarArchivos(path.join(base, entry.name), rel, out);
    else out.push(rel);
  }
  return out;
}

function obtenerSha() {
  const url = `https://github.com/${OWNER}/${REPO}/commits/${BRANCH}.atom`;
  return httpGet(url, { "User-Agent": "martu-updater" })
    .then((res) => readAll(res))
    .then((xml) => {
      const m = xml.match(/Grit::Commit\/([0-9a-f]{40})/i) || xml.match(/<id>tag:github\.com[^<]*\/([0-9a-f]{40})<\/id>/i);
      return m ? m[1] : null;
    })
    .catch((e) => { console.error("[UPDATER] No se pudo leer el SHA:", e.message); return null; });
}

async function updateFromGitHub(token) {
  const installDir = process.cwd();
  const backupDir = path.join(installDir, "backups-instalacion", "pre-update-" + Date.now());
  const staging = path.join(installDir, "backups-instalacion", "actualizacion_tmp");
  const zipFile = path.join(installDir, "backups-instalacion", "actualizacion.zip");

  const sha = await obtenerSha();
  if (sha) console.log("[UPDATER] Commit a aplicar:", sha);

  // Descarga en un solo request: el zip de codeload NO tiene límite de peticiones
  console.log("[UPDATER] Descargando el repositorio (zip)...");
  borrarDir(staging);
  await download(`https://github.com/${OWNER}/${REPO}/archive/refs/heads/${BRANCH}.zip`, zipFile, token);
  console.log("[UPDATER] Zip descargado.");

  execSync(
    `powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${staging}' -Force"`,
    { stdio: "ignore", timeout: 120000 }
  );

  const root = fs.readdirSync(staging)[0];
  const origen = path.join(staging, root);
  const files = listarArchivos(origen);

  const exclude = ["data/", "node_modules/", ".git/", "backups-instalacion/", "caja-state.json", "caja-state.json.bak"];
  const aCopiar = files.filter((rel) => !exclude.some((p) => rel.startsWith(p)));

  console.log("[UPDATER] Archivos a sincronizar:", aCopiar.length);

  for (const rel of aCopiar) {
    const relPath = rel.replace(/\//g, path.sep);
    const localPath = path.join(installDir, relPath);
    const backupPath = path.join(backupDir, relPath);

    if (fs.existsSync(localPath)) {
      if (!fs.existsSync(path.dirname(backupPath))) fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(localPath, backupPath);
    }
    if (!fs.existsSync(path.dirname(localPath))) fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.copyFileSync(path.join(origen, relPath), localPath);
  }

  borrarDir(staging);
  try { if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile); } catch (e) { /* ignore */ }

  console.log("[UPDATER] Archivos aplicados. Backup en:", backupDir);

  try {
    fs.writeFileSync(path.join(installDir, "version.json"), JSON.stringify({ sha: sha || "desconocido", fecha: new Date().toISOString() }, null, 2));
    console.log("[UPDATER] Versión aplicada:", sha || "desconocido");
  } catch (e) {
    console.error("[UPDATER] No se pudo registrar la versión:", e.message);
  }

  if (aCopiar.some((rel) => rel === "package.json") && fs.existsSync(path.join(installDir, "package.json"))) {
    console.log("[UPDATER] package.json actualizado. Instalando dependencias...");
    try {
      execSync("npm install", { cwd: installDir, stdio: "ignore", timeout: 120000 });
    } catch (e) {
      console.error("[UPDATER] Error en npm install:", e.message);
    }
  }

  return { ok: true, backupDir, sha: sha || "desconocido" };
}

function restartServer() {
  const installDir = process.cwd();
  setTimeout(() => {
    const bat = spawn("cmd", ["/c", "taskkill /F /IM node.exe >nul 2>&1 & timeout /t 2 /nobreak >nul & node server.js"], { detached: true, stdio: "ignore", cwd: installDir });
    bat.unref();
    process.exit(0);
  }, 1000);
}

module.exports = { updateFromGitHub, restartServer };
