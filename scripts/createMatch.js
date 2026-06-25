require("dotenv").config();
const { ethers } = require("ethers");

const RPC_URL = process.env.LUKSO_RPC_URL || "https://rpc.testnet.lukso.network";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

const CONTRACT_ABI = [
  "function createMatch(string teamHome, string teamAway, uint256 predictionDeadline) external returns (uint256)",
  "event MatchCreated(uint256 indexed matchId, string teamHome, string teamAway, uint256 predictionDeadline)"
];

async function main() {
  const [teamHome, teamAway, minutesFromNow] = process.argv.slice(2);

  if (!teamHome || !teamAway || !minutesFromNow) {
    console.error('Uso: node scripts/createMatch.js "Squadra A" "Squadra B" <minuti_da_ora>');
    process.exit(1);
  }

  if (!CONTRACT_ADDRESS || !DEPLOYER_PRIVATE_KEY) {
    console.error("Errore: imposta CONTRACT_ADDRESS e DEPLOYER_PRIVATE_KEY nel .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);

  const deadline = Math.floor(Date.now() / 1000) + parseInt(minutesFromNow, 10) * 60;

  console.log(`Creazione match: ${teamHome} vs ${teamAway}`);
  console.log(`Deadline pronostici: ${new Date(deadline * 1000).toISOString()}`);

  const tx = await contract.createMatch(teamHome, teamAway, deadline);
  console.log(`Transazione inviata: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`✅ Confermata nel blocco ${receipt.blockNumber}`);

  const event = receipt.logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "MatchCreated");

  if (event) {
    console.log(`\n🎉 Match creato con ID: ${event.args.matchId}`);
    console.log(`Usa questo ID in CONFIG.MATCHES nel frontend (contractMatchId).`);
  }
}

main().catch((error) => {
  console.error("Errore:", error.message);
  process.exitCode = 1;
});
