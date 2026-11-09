const fs = require("fs");
const path = require("path");
const https = require("https");
const Afip = require("@afipsdk/afip.js");

const CERT_FILE = path.join(__dirname, "certificado.crt");
const KEY_FILE = path.join(__dirname, "privada.key");
// Modo real: certificado emitido por ARCA en produccion (si no existe se usa el de prueba y ARCA lo rechaza)
const CERT_FILE_PROD = path.join(__dirname, "certificado-produccion.crt");
const KEY_FILE_PROD = path.join(__dirname, "privada-produccion.key");
const CUIT_DEFAULT = 27213414475;

const WSFEV1_HOMO = "https://wswhomo.afip.gov.ar/wsfev1/service.asmx";
const WSFEV1_PROD = "https://servicios1.afip.gov.ar/wsfev1/service.asmx";
const SOAP_NS = "http://ar.gov.afip.dif.FEV1/";

let afipSdk = null;

function archivosCert(produccion) {
  if (produccion) {
    if (!fs.existsSync(CERT_FILE_PROD) || !fs.existsSync(KEY_FILE_PROD)) throw new Error("Falta el certificado de produccion (certificado-produccion.crt y privada-produccion.key en la carpeta del sistema).");
    return { cert: CERT_FILE_PROD, key: KEY_FILE_PROD };
  }
  return { cert: CERT_FILE, key: KEY_FILE };
}

function getAfipSdk(accessToken, produccion, cuit) {
  const f = archivosCert(!!produccion);
  const cert = fs.readFileSync(f.cert, "utf-8");
  const key = fs.readFileSync(f.key, "utf-8");
  afipSdk = new Afip({
    CUIT: Number(cuit) || CUIT_DEFAULT,
    cert, key,
    production: !!produccion,
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

async function verificarPuntoVenta(produccion, accessToken, opts = {}) {
  try {
    const sdk = getAfipSdk(accessToken, produccion, opts.cuit);
    const status = await sdk.ElectronicBilling.getServerStatus();
    return {
      ok: true,
      mensaje: (produccion ? "[REAL] " : "[PRUEBA] ") + "Conexión AFIP OK. AppServer: " + status.AppServer + ", DBServer: " + status.DbServer + ", AuthServer: " + status.AuthServer
    };
  } catch (e) {
    return { ok: false, mensaje: e.message };
  }
}

async function getLastVoucher(puntoVenta, cbteTipo, produccion, accessToken, opts = {}) {
  const sdk = getAfipSdk(accessToken, produccion, opts.cuit);
  return await sdk.ElectronicBilling.getLastVoucher(puntoVenta, cbteTipo);
}

async function facturar(data, produccion, accessToken, opts = {}) {
  const cuit = Number(opts.cuit) || CUIT_DEFAULT;
  const sdk = getAfipSdk(accessToken, produccion, cuit);
  const ta = await sdk.ElectronicBilling.getTokenAuthorization();

  // Tipo y punto de venta los define la configuracion del servidor (Factura C = 11 para monotributo)
  const cbteTipo = Number(opts.cbteTipo) || 11;
  const puntoVenta = Number(opts.puntoVenta) || Number(data.puntoVenta) || 2;
  const {
    concepto = 1,
    docTipo = 99,
    docNro = 0,
    items = [],
    condicionIvaReceptor = 5,
    cliente = {}
  } = data;

  const cuitLimpio = (cliente.cuit || "").replace(/[^0-9]/g, "");
  const finalDocTipo = cuitLimpio ? 80 : 99;
  const finalDocNro = cuitLimpio ? parseInt(cuitLimpio, 10) : 0;
  const finalCondicionIva = 5; // Consumidor Final

  const total = items.reduce((a, it) => a + (it.precio || 0) * (it.cant || 1), 0);
  // Los precios de la carta son finales (IVA incluido). Factura C: sin IVA discriminado (neto = total).
  const impTotal = parseFloat(total.toFixed(2));
  const impNeto = cbteTipo === 6 ? parseFloat((impTotal / 1.21).toFixed(2)) : impTotal;
  const impIVA = cbteTipo === 6 ? parseFloat((impTotal - impNeto).toFixed(2)) : 0;
  if (!(impTotal > 0)) throw new Error("El total a facturar tiene que ser mayor a 0.");

  const lastVoucher = await sdk.ElectronicBilling.getLastVoucher(puntoVenta, cbteTipo);
  const nextNum = lastVoucher + 1;
  const fecha = new Date(Date.now() - 3 * 3600 * 1000).toISOString().split("T")[0].replace(/-/g, ""); // fecha de Argentina (UTC-3)

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
        <ar:Cuit>${cuit}</ar:Cuit>
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
            <ar:DocTipo>${finalDocTipo}</ar:DocTipo>
            <ar:DocNro>${finalDocNro}</ar:DocNro>
            <ar:CondicionIVAReceptorId>${finalCondicionIva}</ar:CondicionIVAReceptorId>
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
    return { cae, vencimiento: vto, cbteNro: nextNum, ptoVenta: puntoVenta, cbteTipo, produccion: !!produccion, fecha, total: impTotal, cuit };
  }

  throw new Error("AFIP rechazó: " + (errMsg || resultado || response.substring(0, 300)));
}

module.exports = { facturar, verificarPuntoVenta, getLastVoucher };
