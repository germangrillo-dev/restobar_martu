const fs = require("fs");
const path = require("path");
const https = require("https");

const OWNER = "germangrillo-dev";
const REPO = "restobar_martu";
const BRANCH = "main";

const installDir = process.argv[2] || process.cwd();
const token = process.argv[3] || "";

function apiRequest(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "martu-installer",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    };
    if (token) options.headers["Authorization"] = "Bearer " + token;
    https.get(url, options, (res) => {
      if (res.statusCode === 302 && res.headers.location) {
        return https.get(res.headers.location, { headers: { "User-Agent": "martu-installer" } }, (r2) => collect(r2, resolve, reject));
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

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent": "martu-installer",
        "Accept": "application/vnd.github.raw+json"
      }
    };
    if (token) options.headers["Authorization"] = "Bearer " + token;
    https.get(url, options, (res) => {
      if (res.statusCode === 302 && res.headers.location) {
        return https.get(res.headers.location, { headers: { "User-Agent": "martu-installer" } }, (r2) => writeStream(r2, dest, resolve, reject));
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

(async () => {
  console.log("[INSTALLER] Descargando listado de archivos...");
  const treeData = await apiRequest(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`);
  const files = (treeData.tree || []).filter(item => item.type === "blob");
  console.log("[INSTALLER] Archivos a descargar:", files.length);

  for (const file of files) {
    const relPath = file.path.replace(/\//g, path.sep);
    const localPath = path.join(installDir, relPath);
    await downloadFile(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${file.path}?ref=${BRANCH}`, localPath);
  }

  console.log("[INSTALLER] Descarga completa.");
})().catch(e => {
  console.error("[INSTALLER ERROR]", e.message);
  process.exit(1);
});
