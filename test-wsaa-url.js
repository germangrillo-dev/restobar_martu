const https = require("https");

// Test different WSAA endpoints
const endpoints = [
  "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
  "https://wsaahomo.afip.gov.ar/CmsWS/services/CmsWSAuth",
  "https://wsaahomo.afip.gov.ar/ws/services/AuthCms"
];

let i = 0;
function tryEndpoint() {
  if (i >= endpoints.length) { console.log("All endpoints failed"); return; }
  const url = endpoints[i];
  console.log("Trying:", url);
  const parsedUrl = new URL(url);
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.pathname,
    method: "GET",
  };
  const req = https.request(options, (res) => {
    console.log("STATUS:", res.statusCode);
    let data = "";
    res.on("data", (c) => data += c);
    res.on("end", () => { console.log("BODY:", data.substring(0, 200)); i++; tryEndpoint(); });
  });
  req.on("error", (e) => { console.log("ERROR:", e.message); i++; tryEndpoint(); });
  req.end();
}
tryEndpoint();
