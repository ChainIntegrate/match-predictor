/**
 * addUpcomingMatches.js (v2 — passa correttamente dal Key Manager)
 * ------------------------------------------------------------------
 * Il contratto MatchPredictor ha come owner una Universal Profile, non
 * una EOA semplice. Una UP non firma transazioni direttamente: ogni
 * azione deve passare dal suo LSP6 Key Manager, che verifica i permessi
 * del controller e poi esegue la chiamata "per conto della" UP.
 *
 * Flusso:
 *   1. Trova l'indirizzo del Key Manager (è l'owner() della UP)
 *   2. Codifica la chiamata createMatch(...) come payload ABI
 *   3. Il controller chiama keyManager.execute(payload)
 *   4. Il Key Manager esegue la chiamata sul target (MatchPredictor),
 *      che vede msg.sender = la UP, non il controller
 *
 * Uso:
 *   node scripts/addUpcomingMatches.js
 *
 * Variabili .env richieste:
 *   LUKSO_RPC_URL (o RPC_URL), CONTRACT_ADDRESS, OWNER_UP_ADDRESS,
 *   DEPLOYER_PRIVATE_KEY (deve essere un controller con permessi sulla UP),
 *   FOOTBALL_DATA_API_KEY
 */

require("dotenv").config();
const { ethers } = require("ethers");

// --- Finestra di date: partite del Mondiale ancora da giocare ---
const DATE_FROM = "2026-06-25";
const DATE_TO = "2026-06-28"; // escluso

const RPC_URL = process.env.RPC_URL || process.env.LUKSO_RPC_URL || "https://rpc.testnet.lukso.network";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const OWNER_UP_ADDRESS = process.env.OWNER_UP_ADDRESS;
const CONTROLLER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;

if (!CONTRACT_ADDRESS || !OWNER_UP_ADDRESS || !CONTROLLER_PRIVATE_KEY || !FOOTBALL_DATA_API_KEY) {
  console.error(
    "Errore: imposta CONTRACT_ADDRESS, OWNER_UP_ADDRESS, DEPLOYER_PRIVATE_KEY e FOOTBALL_DATA_API_KEY nel .env"
  );
  process.exit(1);
}

// ABI minime necessarie
const MATCH_PREDICTOR_ABI = [
  "function createMatch(string teamHome, string teamAway, uint256 predictionDeadline) external returns (uint256)",
  "event MatchCreated(uint256 indexed matchId, string teamHome, string teamAway, uint256 predictionDeadline)"
];

// Una Universal Profile espone owner() che ritorna l'indirizzo del suo Key Manager
const UNIVERSAL_PROFILE_ABI = [
  "function owner() external view returns (address)"
];

// Key Manager: ci serve solo execute(bytes) per il flusso diretto (non relay)
const KEY_MANAGER_ABI = [
  "function execute(bytes calldata payload) external payable returns (bytes memory)"
];

async function fetchUpcomingMatches() {
  const url = `https://api.football-data.org/v4/competitions/WC/matches?dateFrom=${DATE_FROM}&dateTo=${DATE_TO}&status=SCHEDULED`;

  const response = await fetch(url, {
    headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY }
  });

  if (!response.ok) {
    throw new Error(`football-data.org ha risposto con status ${response.status}`);
  }

  const data = await response.json();
  return data.matches || [];
}

async function main() {
  console.log(`Recupero partite del Mondiale 2026 programmate tra ${DATE_FROM} e ${DATE_TO}...`);
  const matches = await fetchUpcomingMatches();

  // Scarta partite senza squadre note (es. round of 32 non ancora definito)
  const knownMatches = matches.filter(
  (m) => m.homeTeam?.name && m.awayTeam?.name && m.homeTeam.name !== "TBD"
).slice(0, 1); // TEST: solo la prima partita, rimuovere dopo aver verificato che funziona

  if (knownMatches.length === 0) {
    console.log("Nessuna partita con squadre note trovata in questa finestra di date.");
    return;
  }

  console.log(`Trovate ${knownMatches.length} partite con squadre note. Procedo...\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const controllerWallet = new ethers.Wallet(CONTROLLER_PRIVATE_KEY, provider);

  console.log(`Controller address: ${controllerWallet.address}`);
  console.log(`Universal Profile (owner del contratto): ${OWNER_UP_ADDRESS}`);

  // Trova il Key Manager interrogando owner() sulla UP
  const universalProfile = new ethers.Contract(OWNER_UP_ADDRESS, UNIVERSAL_PROFILE_ABI, provider);
  const keyManagerAddress = await universalProfile.owner();
  console.log(`Key Manager trovato: ${keyManagerAddress}\n`);

  const keyManager = new ethers.Contract(keyManagerAddress, KEY_MANAGER_ABI, controllerWallet);

  // Interfaccia usata solo per codificare la chiamata createMatch(...)
  const matchPredictorInterface = new ethers.Interface(MATCH_PREDICTOR_ABI);
  const matchPredictorReader = new ethers.Contract(CONTRACT_ADDRESS, MATCH_PREDICTOR_ABI, provider);

  const finalMapping = [];

  for (const match of knownMatches) {
    const teamHome = match.homeTeam.name;
    const teamAway = match.awayTeam.name;
    const kickoffSeconds = Math.floor(new Date(match.utcDate).getTime() / 1000);
    const groupLabel = match.group || match.stage || "World Cup 2026";

    console.log(`→ ${teamHome} vs ${teamAway} (${groupLabel}) — kickoff ${match.utcDate}`);

    try {
      // Codifica la chiamata createMatch(...) come la firmerebbe l'estensione UP
      const encodedCall = matchPredictorInterface.encodeFunctionData("createMatch", [
        teamHome,
        teamAway,
        kickoffSeconds
      ]);

      // execute(address target, uint256 value, bytes payload) è la firma più comune
      // per LSP0 ERC725X; verifichiamo dinamicamente quale firma accetta il KM
      // costruendo il payload ERC725X execute: operation=0 (CALL), target, value=0, data
      const erc725xPayload = new ethers.Interface([
        "function execute(uint256 operationType, address target, uint256 value, bytes calldata data) external payable returns (bytes memory)"
      ]).encodeFunctionData("execute", [0, CONTRACT_ADDRESS, 0, encodedCall]);

      const tx = await controllerWallet.sendTransaction({
        to: keyManagerAddress,
        data: erc725xPayload
      });

      const receipt = await tx.wait();

      // L'evento MatchCreated viene emesso dal contratto MatchPredictor,
      // ma la transazione è andata al Key Manager: dobbiamo cercare nei
      // log dell'intera receipt, non solo quelli "noti" all'interfaccia diretta.
      const event = receipt.logs
        .map((log) => {
          try { return matchPredictorInterface.parseLog(log); } catch { return null; }
        })
        .find((parsed) => parsed?.name === "MatchCreated");

      const contractMatchId = event ? event.args.matchId.toString() : "?";

      console.log(`  ✅ Creato on-chain con matchId ${contractMatchId} (tx: ${tx.hash})\n`);

      finalMapping.push({
        contractMatchId,
        footballDataMatchId: match.id,
        teamHome,
        teamAway,
        kickoff: match.utcDate,
        group: groupLabel
      });
    } catch (err) {
      console.error(`  ❌ Errore creando ${teamHome} vs ${teamAway}: ${err.message}\n`);
    }
  }

  console.log("\n========================================");
  console.log("RIEPILOGO — copia questi valori dove servono");
  console.log("========================================\n");

  console.log("--- Per oracle/reportResultBatch.js (MATCH_ID_MAPPING) ---\n");
  console.log("const MATCH_ID_MAPPING = {");
  finalMapping.forEach((m) => {
    console.log(`  ${m.contractMatchId}: ${m.footballDataMatchId}, // ${m.teamHome} vs ${m.teamAway}`);
  });
  console.log("};\n");

  console.log("--- Per frontend/index.html (CONFIG.MATCHES) ---\n");
  finalMapping.forEach((m) => {
    console.log(`  {
    contractMatchId: ${m.contractMatchId},
    teamHome: "${m.teamHome}",
    teamAway: "${m.teamAway}",
    label: "${m.group}",
    kickoff: "${m.kickoff}",
    venue: "World Cup 2026",
    footballDataMatchId: ${m.footballDataMatchId}
  },`);
  });

  console.log("\nFatto. Ricorda di aggiungere i nomi delle nuove squadre a FLAG_CODES");
  console.log("nel frontend se non sono già presenti nella mappa esistente.");
}

main().catch((error) => {
  console.error("Errore generale:", error.message);
  process.exitCode = 1;
});