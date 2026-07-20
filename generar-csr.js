const forge = require("node-forge");
const fs = require("fs");

const CUIT = "27213414475"; // CUIT del cliente, sin guiones
const ALIAS = "marturestobar"; // el mismo alias que vas a usar en ARCA
const ORGANIZACION = "marturestobar";

const keys = forge.pki.rsa.generateKeyPair(2048);

const csr = forge.pki.createCertificationRequest();
csr.publicKey = keys.publicKey;
csr.setSubject([
  { name: "commonName", value: ALIAS },
  { name: "organizationName", value: ORGANIZACION },
  { name: "countryName", value: "AR" },
  { type: "2.5.4.5", value: `CUIT ${CUIT}` }, // serialNumber, con el OID explícito
]);
csr.sign(keys.privateKey);

const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
const csrPem = forge.pki.certificationRequestToPem(csr);

fs.writeFileSync("privada.key", privateKeyPem);
fs.writeFileSync("pedido.csr", csrPem);

console.log("Listo. Se generaron privada.key y pedido.csr");