require("dotenv").config();
const { ethers } = require("ethers");

const RPC_URL = process.env.LUKSO_RPC_URL || "https://rpc.testnet.lukso.network";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY;

const CONTRACT_ABI = [
  "function reportResult(uint256 matchId, uint8 actualResult) external",
  "function matches(uint256) external view returns (string teamHome, string teamAway, uint256 predictionDeadline, bool resolved, uint8 actualResult, bool exists)"
];

const RESULT_LABELS = { 1: "Vittoria Casa", 2: "Pareggio", 3: "Vittoria Trasferta" };

async function main() {
  const [matchId, resultCode] = process.argv.slice(2);

  if (!matchId || !resultCode || !["1", "2", "3"].includes(resultCode)) {
    console.error("Uso: node scripts/testReportResult.js <matchId> <esito 1|2|3>");
    process.exit(1);
  }

  if (!CONTRACT_ADDRESS || !ORACLE_PRIVATE_KEY) {
    console.error("Errore: imposta CONTRACT_ADDRESS e ORACLE_PRIVATE_KEY nel .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const oracleWallet = new ethers.Wallet(ORACLE_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, oracleWallet);

  const onChainMatch = await contract.matches(matchId);
  if (!onChainMatch.exists) {
    console.error(`Errore: il match #${matchId} non esiste.`);
    process.exit(1);
  }
  if (onChainMatch.resolved) {
    console.log(`Il match #${matchId} è già stato risolto. Nessuna azione necessaria.`);
    return;
  }

  const deadline = Number(onChainMatch.predictionDeadline);
  const now = Math.floor(Date.now() / 1000);
  if (now < deadline) {
    const minutesLeft = Math.ceil((deadline - now) / 60);
    console.error(`Attenzione: la deadline non è ancora passata (${minutesLeft} minuti rimanenti).`);
  }

  console.log(`Match #${matchId}: ${onChainMatch.teamHome} vs ${onChainMatch.teamAway}`);
  console.log(`Riporto risultato: ${RESULT_LABELS[resultCode]}`);

  const tx = await contract.reportResult(matchId, resultCode);
  console.log(`Transazione inviata: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`✅ Confermata nel blocco ${receipt.blockNumber}`);
  console.log(`\nOra puoi tornare al frontend e provare a fare claim().`);
}

main().catch((error) => {
  console.error("Errore:", error.message);
  process.exitCode = 1;
});
