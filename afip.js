const fs = require("fs");
const path = require("path");
const https = require("https");
const Afip = require("@afipsdk/afip.js");

const CERT_FILE = path.join(__dirname, "certificado.crt");
const KEY_FILE = path.join(__dirname, "privada.key");

const WSFEV1_HOMO = "https://wswhomo.afip.gov.ar/wsfev1/service.asmx";
const WSFEV1_PROD = "https://servicios1.afip.gov.ar/wsfev1/service.asmx";
const SOAP_NS = "http://ar.gov.afip.dif.FEV1/";

let afipSdk = null;

function getAfipSdk(accessToken) {
  const cert = fs.readFileSync(CERT_FILE, "utf-8");
  const key = fs.readFileSync(KEY_FILE, "utf-8");
  afipSdk = new Afip({
    CUIT: 27213414475,
    cert, key,
    production: false,
    access_token: accessToken
  });
  return afipSdk;
}

function soapPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname, method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "SOAPAction": SOAP_NS + "FECAESolicitar"
      }
    }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseTag(xml, tag) {
  const re = new RegExp("<" + tag + "[\\s>]*>([^<]*)<" + "/" + tag + ">");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

async function verificarPuntoVenta(produccion, accessToken) {
  try {
    const sdk = getAfipSdk(accessToken);
    const status = await sdk.ElectronicBilling.getServerStatus();
    return {
      ok: true,
      mensaje: "Conexión AFIP OK. AppServer: " + status.AppServer + ", DBServer: " + status.DbServer + ", AuthServer: " + status.AuthServer
    };
  } catch (e) {
    return { ok: false, mensaje: e.message };
  }
}

async function getLastVoucher(puntoVenta, cbteTipo, produccion, accessToken) {
  const sdk = getAfipSdk(accessToken);
  return await sdk.ElectronicBilling.getLastVoucher(puntoVenta, cbteTipo);
}

async function facturar(data, produccion, accessToken) {
  const sdk = getAfipSdk(accessToken);
  const ta = await sdk.ElectronicBilling.getTokenAuthorization();

  const {
    cbteTipo = 6,
    concepto = 1,
    docTipo = 99,
    docNro = 0,
    puntoVenta = 2,
    items = [],
    condicionIvaReceptor = 5
  } = data;

  const total = items.reduce((a, it) => a + (it.precio || 0) * (it.cant || 1), 0);
  const impNeto = parseFloat(total.toFixed(2));
  const impIVA = cbteTipo === 6 ? parseFloat((impNeto * 0.21).toFixed(2)) : 0;
  const impTotal = cbteTipo === 6 ? parseFloat((impNeto + impIVA).toFixed(2)) : impNeto;

  const lastVoucher = await sdk.ElectronicBilling.getLastVoucher(puntoVenta, cbteTipo);
  const nextNum = lastVoucher + 1;
  const fecha = new Date().toISOString().split("T")[0].replace(/-/g, "");

  const ivaXml = cbteTipo === 6 ? `
            <ar:Iva>
              <ar:AlicIva>
                <ar:Id>5</ar:Id>
                <ar:BaseImp>${impNeto.toFixed(2)}</ar:BaseImp>
                <ar:Importe>${impIVA.toFixed(2)}</ar:Importe>
              </ar:AlicIva>
            </ar:Iva>` : "";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${SOAP_NS}">
  <soap:Body>
    <ar:FECAESolicitar>
      <ar:Auth>
        <ar:Token>${ta.token}</ar:Token>
        <ar:Sign>${ta.sign}</ar:Sign>
        <ar:Cuit>27213414475</ar:Cuit>
      </ar:Auth>
      <ar:FeCAEReq>
        <ar:FeCabReq>
          <ar:CantReg>1</ar:CantReg>
          <ar:PtoVta>${puntoVenta}</ar:PtoVta>
          <ar:CbteTipo>${cbteTipo}</ar:CbteTipo>
        </ar:FeCabReq>
        <ar:FeDetReq>
          <ar:FECAEDetRequest>
            <ar:Concepto>${concepto}</ar:Concepto>
            <ar:DocTipo>${docTipo}</ar:DocTipo>
            <ar:DocNro>${docNro}</ar:DocNro>
            <ar:CondicionIVAReceptorId>${condicionIvaReceptor}</ar:CondicionIVAReceptorId>
            <ar:CbteDesde>${nextNum}</ar:CbteDesde>
            <ar:CbteHasta>${nextNum}</ar:CbteHasta>
            <ar:CbteFch>${fecha}</ar:CbteFch>
            <ar:ImpTotal>${impTotal.toFixed(2)}</ar:ImpTotal>
            <ar:ImpTotConc>0.00</ar:ImpTotConc>
            <ar:ImpNeto>${impNeto.toFixed(2)}</ar:ImpNeto>
            <ar:ImpOpEx>0.00</ar:ImpOpEx>
            <ar:ImpIVA>${impIVA.toFixed(2)}</ar:ImpIVA>
            <ar:ImpTrib>0.00</ar:ImpTrib>
            <ar:MonId>PES</ar:MonId>
            <ar:MonCotiz>1</ar:MonCotiz>${ivaXml}
          </ar:FECAEDetRequest>
        </ar:FeDetReq>
      </ar:FeCAEReq>
    </ar:FECAESolicitar>
  </soap:Body>
</soap:Envelope>`;

  const url = produccion ? WSFEV1_PROD : WSFEV1_HOMO;
  console.log("[AFIP] Enviando factura directa a " + url);
  const response = await soapPost(url, xml);

  const resultado = parseTag(response, "Resultado");
  const cae = parseTag(response, "CAE");
  const vto = parseTag(response, "CAEFchVto");
  const errMsg = parseTag(response, "Msg");

  if (resultado === "A" && cae) {
    console.log("[AFIP] CAE:", cae, "Vto:", vto, "Nro:", nextNum);
    return { cae, vencimiento: vto, cbteNro: nextNum, ptoVenta: puntoVenta };
  }

  throw new Error("AFIP rechazó: " + (errMsg || resultado || response.substring(0, 300)));
}

module.exports = { facturar, verificarPuntoVenta, getLastVoucher };
