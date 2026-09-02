const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync, spawn } = require("child_process");

const OWNER = "germangrillo-dev";
const REPO = "restobar_martu";
const BRANCH = "main";

function apiRequest(url, token) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "martu-updater",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    };
    if (token) options.headers["Authorization"] = "Bearer " + token;
    https.get(url, options, (res) => {
      if (res.statusCode === 302 && res.headers.location) {
        return https.get(res.headers.location, { headers: { "User-Agent": "martu-updater" } }, (r2) => collect(r2, resolve, reject));
      }
      collect(res, resolve, reject);
    }).on("error", reject);
  });
}

function collect(res, resolve, reject) {
  let data = "";
  res.on("data", (chunk) => data += chunk);
  res.on("end", () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try { resolve(JSON.parse(data)); } catch { resolve(data); }
    } else {
      reject(new Error("HTTP " + res.statusCode + ": " + data.slice(0, 500)));
    }
  });
}

function downloadFile(url, dest, token) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "martu-updater",
        "Accept": "application/vnd.github.raw+json"
      }
    };
    if (token) options.headers["Authorization"] = "Bearer " + token;
    https.get(url, options, (res) => {
      if (res.statusCode === 302 && res.headers.location) {
        return https.get(res.headers.location, { headers: { "User-Agent": "martu-updater" } }, (r2) => writeStream(r2, dest, resolve, reject));
      }
      writeStream(res, dest, resolve, reject);
    }).on("error", reject);
  });
}

function writeStream(res, dest, resolve, reject) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    return reject(new Error("HTTP " + res.statusCode + " downloading " + dest));
  }
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = fs.createWriteStream(dest);
  res.pipe(file);
  file.on("finish", () => { file.close(); resolve(); });
  file.on("error", reject);
}

async function updateFromGitHub(token) {
  const installDir = process.cwd();
  const backupDir = path.join(installDir, "backups-instalacion", "pre-update-" + Date.now());

  console.log("[UPDATER] Obteniendo listado de archivos del repo...");
  const treeUrl = `https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`;
  const treeData = await apiRequest(treeUrl, token);
  const files = (treeData.tree || []).filter(item => item.type === "blob");

  const exclude = ["data/", "node_modules/", ".git/", "backups-instalacion/", "caja-state.json", "caja-state.json.bak"];

  console.log("[UPDATER] Archivos a sincronizar:", files.length);

  for (const file of files) {
    const relPath = file.path.replace(/\//g, path.sep);
    if (exclude.some(p => relPath.startsWith(p))) continue;

    const localPath = path.join(installDir, relPath);
    const backupPath = path.join(backupDir, relPath);

    if (fs.existsSync(localPath)) {
      if (!fs.existsSync(path.dirname(backupPath))) fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(localPath, backupPath);
    }

    const contentUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${file.path}?ref=${BRANCH}`;
    await downloadFile(contentUrl, localPath, token);
  }

  console.log("[UPDATER] Archivos descargados. Backup en:", backupDir);

  // Reinstall dependencies if package.json changed
  if (files.some(f => f.path === "package.json") && fs.existsSync(path.join(installDir, "package.json"))) {
    console.log("[UPDATER] package.json actualizado. Instalando dependencias...");
    try {
      execSync("npm install", { cwd: installDir, stdio: "inherit", timeout: 120000 });
    } catch (e) {
      console.error("[UPDATER] Error en npm install:", e.message);
    }
  }

  return { ok: true, backupDir };
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
