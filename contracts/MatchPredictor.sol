// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LSP8Mintable} from "@lukso/lsp8-contracts/contracts/presets/LSP8Mintable.sol";
import {_LSP8_TOKENID_FORMAT_NUMBER} from "@lukso/lsp8-contracts/contracts/LSP8Constants.sol";

contract MatchPredictor is LSP8Mintable {
    enum Result {
        NONE,
        HOME_WIN,
        DRAW,
        AWAY_WIN
    }

    struct Match {
        string teamHome;
        string teamAway;
        uint256 predictionDeadline;
        bool resolved;
        Result actualResult;
        bool exists;
    }

    address public oracle;

    bytes32 private constant _LSP4_METADATA_KEY =
        0x9afb95cacc9f95858ec44aa8c3b685511002e30ae54415823f406128b85b238e;

    bytes private constant _BADGE_METADATA_VALUE =
        hex"00006f357c6a0020f475cbcd54b7c27982ec7d29586cc08d69164fcf0f0bf008e2a00c9f17ee3956697066733a2f2f6261666b726569643337696a6934777969616c6833736c696a613670706873626f7332326e3532656a727766366c65647468776d746a6c64377471";

    mapping(uint256 => Match) public matches;
    mapping(uint256 => mapping(address => Result)) public predictions;
    mapping(uint256 => mapping(address => bool)) public claimed;

    uint256 public nextMatchId;
    uint256 private nextTokenId;

    event MatchCreated(uint256 indexed matchId, string teamHome, string teamAway, uint256 predictionDeadline);
    event PredictionMade(uint256 indexed matchId, address indexed predictor, Result predictedResult);
    event ResultReported(uint256 indexed matchId, Result actualResult);
    event PrizeClaimed(uint256 indexed matchId, address indexed winner, bytes32 tokenId);
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);

    error NotOracle();
    error MatchDoesNotExist();
    error PredictionWindowClosed();
    error MatchAlreadyResolved();
    error MatchNotResolvedYet();
    error AlreadyPredicted();
    error InvalidResult();
    error NoPredictionFound();
    error AlreadyClaimed();
    error PredictionWasIncorrect();
    error DeadlineMustBeFuture();

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address ownerUP_,
        address oracle_
    )
        LSP8Mintable(
            name_,
            symbol_,
            ownerUP_,
            0,
            _LSP8_TOKENID_FORMAT_NUMBER
        )
    {
        oracle = oracle_;
    }

    function createMatch(
        string calldata teamHome,
        string calldata teamAway,
        uint256 predictionDeadline
    ) external onlyOwner returns (uint256 matchId) {
        if (predictionDeadline <= block.timestamp) revert DeadlineMustBeFuture();

        matchId = nextMatchId++;
        matches[matchId] = Match({
            teamHome: teamHome,
            teamAway: teamAway,
            predictionDeadline: predictionDeadline,
            resolved: false,
            actualResult: Result.NONE,
            exists: true
        });

        emit MatchCreated(matchId, teamHome, teamAway, predictionDeadline);
    }

    function predict(uint256 matchId, Result predictedResult) external {
        Match storage m = matches[matchId];
        if (!m.exists) revert MatchDoesNotExist();
        if (block.timestamp >= m.predictionDeadline) revert PredictionWindowClosed();
        if (predictedResult == Result.NONE) revert InvalidResult();
        if (predictions[matchId][msg.sender] != Result.NONE) revert AlreadyPredicted();

        predictions[matchId][msg.sender] = predictedResult;
        emit PredictionMade(matchId, msg.sender, predictedResult);
    }

    function reportResult(uint256 matchId, Result actualResult) external onlyOracle {
        Match storage m = matches[matchId];
        if (!m.exists) revert MatchDoesNotExist();
        if (m.resolved) revert MatchAlreadyResolved();
        if (actualResult == Result.NONE) revert InvalidResult();

        m.resolved = true;
        m.actualResult = actualResult;

        emit ResultReported(matchId, actualResult);
    }

    function claim(uint256 matchId) external {
        Match storage m = matches[matchId];
        if (!m.exists) revert MatchDoesNotExist();
        if (!m.resolved) revert MatchNotResolvedYet();

        Result myPrediction = predictions[matchId][msg.sender];
        if (myPrediction == Result.NONE) revert NoPredictionFound();
        if (claimed[matchId][msg.sender]) revert AlreadyClaimed();
        if (myPrediction != m.actualResult) revert PredictionWasIncorrect();

        claimed[matchId][msg.sender] = true;

        bytes32 tokenId = bytes32(nextTokenId++);
        _mint(msg.sender, tokenId, true, "");
        _setDataForTokenId(tokenId, _LSP4_METADATA_KEY, _BADGE_METADATA_VALUE);

        emit PrizeClaimed(matchId, msg.sender, tokenId);
    }

    function setOracle(address newOracle) external onlyOwner {
        address previous = oracle;
        oracle = newOracle;
        emit OracleUpdated(previous, newOracle);
    }

    function getMatch(uint256 matchId) external view returns (Match memory) {
        if (!matches[matchId].exists) revert MatchDoesNotExist();
        return matches[matchId];
    }

    function hasWon(uint256 matchId, address wallet) external view returns (bool) {
        Match storage m = matches[matchId];
        if (!m.exists || !m.resolved) return false;
        Result p = predictions[matchId][wallet];
        return p != Result.NONE && p == m.actualResult;
    }
}