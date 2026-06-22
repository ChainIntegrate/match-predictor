const hre = require("hardhat");

async function main() {
  // --- Parametri di deploy: personalizza prima di lanciare ---
  const COLLECTION_NAME = "MatchPredictor Winners";
  const COLLECTION_SYMBOL = "MPW";
  const OWNER_UP_ADDRESS = process.env.OWNER_UP_ADDRESS; // la tua Universal Profile
  const ORACLE_ADDRESS = process.env.ORACLE_ADDRESS;     // EOA dedicata oracolo

  if (!OWNER_UP_ADDRESS || !ORACLE_ADDRESS) {
    throw new Error(
      "Imposta OWNER_UP_ADDRESS e ORACLE_ADDRESS nel file .env prima di deployare."
    );
  }

  console.log("Deploy in corso...");
  console.log("  Owner (UP):", OWNER_UP_ADDRESS);
  console.log("  Oracle (EOA):", ORACLE_ADDRESS);

  const MatchPredictor = await hre.ethers.getContractFactory("MatchPredictor");
  const contract = await MatchPredictor.deploy(
    COLLECTION_NAME,
    COLLECTION_SYMBOL,
    OWNER_UP_ADDRESS,
    ORACLE_ADDRESS
  );

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("\n✅ MatchPredictor deployato con successo!");
  console.log("   Indirizzo contratto:", address);
  console.log("\nProssimi passi:");
  console.log("  1. Verifica il contratto su Blockscout (opzionale)");
  console.log("  2. Crea il primo match con createMatch()");
  console.log("  3. Configura oracle/.env con CONTRACT_ADDRESS=" + address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
