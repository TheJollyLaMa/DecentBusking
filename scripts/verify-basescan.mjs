#!/usr/bin/env node
// Publishes Sourcify exact-match sources to Basescan (Etherscan V2 API).
// Usage: ETHERSCAN_API_KEY=... node scripts/verify-basescan.mjs [--dry-run]
// The key may also be read from discord-bot/.env or ../DecentMarket/.env (BASESCAN_API_KEY or ETHERSCAN_API_KEY).
// No private key is needed; verification only publishes source code.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CHAIN_ID = 8453;
const SOURCIFY = "https://sourcify.dev/server/v2/contract";
const ETHERSCAN = `https://api.etherscan.io/v2/api?chainid=${CHAIN_ID}`;

export const BASE_CONTRACTS = [
  { label: "ArtFi settlement router", address: "0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5" },
  { label: "DJuke v0.5 (live)", address: "0xf51D2F7892cF9D49e14DF4afDf227a59ee170A51" },
  { label: "DJuke sponsored playlist module", address: "0x093d2dbCcBA612d2B2aD9B620cA4d0A03D98fE11" },
  { label: "DJuke v0.4 (retired)", address: "0xBBCb7F7369978cbdc32C6719B1d24B07f3d55619" },
  { label: "DJuke v0.3 (retired)", address: "0x5d07489163feBCdB39C9F579CCC36dff5A067FF9" },
  { label: "DJuke v0.2", address: "0x333Aa353d6fc70aE79Cf91CE090645CD740FEf59" },
  { label: "DeVert v0.1", address: "0x135Cbc573F87637158eb3186C87c584fb0B34CD9" },
  { label: "DecentEscrow v0.1", address: "0x31b07b83e99A9bdF379bf40225b8A80d3804C89d" },
  { label: "LivePerformanceEscrow", address: "0x20C08F2e877389D68cFbcF49664211E8CE9554Ec" },
  { label: "DecentNFT v0.2", address: "0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B" },
  { label: "DecentNFT v0.3", address: "0x64D5aDc50E5513975EfF7e9ba366B7eE58586fa3" },
  { label: "BNUT", address: "0x25ACb773159Af5a5c672DEfe31C7Fff6a9A93736" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadKey() {
  const fromEnv = process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY;
  if (fromEnv) return fromEnv.trim();
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of ["../discord-bot/.env", "../../DecentMarket/.env"]) {
    try {
      const env = await readFile(path.resolve(here, file), "utf8");
      const m = env.match(/^\s*(?:ETHERSCAN|BASESCAN)_API_KEY\s*=\s*["']?([^"'\s#]+)/m);
      if (m) return m[1];
    } catch {}
  }
  return "";
}

async function etherscan(params, key, method = "GET") {
  await sleep(400); // free tier allows 3 calls/sec
  const body = new URLSearchParams({ ...params, apikey: key });
  const res = method === "GET"
    ? await fetch(`${ETHERSCAN}&${body}`)
    : await fetch(ETHERSCAN, { method: "POST", body });
  return res.json();
}

async function basescanVerified(address, key) {
  const r = await etherscan({ module: "contract", action: "getsourcecode", address }, key);
  return Boolean(r?.result?.[0]?.SourceCode);
}

async function sourcify(address) {
  const fields = "compilation,stdJsonInput,creationBytecode.transformationValues";
  const res = await fetch(`${SOURCIFY}/${CHAIN_ID}/${address}?fields=${fields}`);
  if (!res.ok) return null;
  const d = await res.json();
  return d.match ? d : null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const key = await loadKey();
  if (!key && !dryRun) {
    console.error("Missing ETHERSCAN_API_KEY (Etherscan V2 key, free at etherscan.io/myapikey). Use --dry-run to preview.");
    process.exit(1);
  }
  let failures = 0;
  for (const c of BASE_CONTRACTS) {
    const tag = `${c.label.padEnd(24)} ${c.address}`;
    if (key && (await basescanVerified(c.address, key))) {
      console.log(`✔ ${tag} already verified on Basescan`);
      continue;
    }
    const s = await sourcify(c.address);
    if (!s) {
      console.log(`✖ ${tag} not verified on Sourcify; cannot source it`);
      failures++;
      continue;
    }
    const args = (s.creationBytecode?.transformationValues?.constructorArguments || "").replace(/^0x/, "");
    if (dryRun) {
      console.log(`• ${tag} would submit ${s.compilation.fullyQualifiedName} (${s.compilation.compilerVersion}, ${args.length / 64} ctor words)`);
      continue;
    }
    const sub = await etherscan({
      module: "contract",
      action: "verifysourcecode",
      contractaddress: c.address,
      sourceCode: JSON.stringify(s.stdJsonInput),
      codeformat: "solidity-standard-json-input",
      contractname: s.compilation.fullyQualifiedName,
      compilerversion: `v${s.compilation.compilerVersion}`,
      constructorArguements: args,
    }, key, "POST");
    if (sub.status !== "1") {
      console.log(`✖ ${tag} submit failed: ${sub.result}`);
      failures++;
      continue;
    }
    let result = "Pending";
    for (let i = 0; i < 20 && /pending/i.test(result); i++) {
      await sleep(5000);
      result = (await etherscan({ module: "contract", action: "checkverifystatus", guid: sub.result }, key)).result;
    }
    const ok = /pass|already verified/i.test(result);
    if (!ok) failures++;
    console.log(`${ok ? "✔" : "✖"} ${tag} ${result}`);
  }
  process.exit(failures ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
