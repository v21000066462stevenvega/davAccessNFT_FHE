pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DavAccessNFT_FHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public currentBatchId;
    bool public batchOpen;
    mapping(uint256 => uint256) public batchSubmissionCount;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Encrypted user preferences
    // For simplicity, we'll assume a fixed set of preferences per NFT
    // In a real scenario, this might be more complex or involve multiple NFTs
    euint32 public encryptedDrivingStyle;
    euint32 public encryptedRoutePreference;
    euint32 public encryptedComfortLevel;

    // Access control list for who can use the DAV
    // This would be checked by the DAV system, possibly after decryption
    // For this contract, we manage the encrypted list.
    // Let's say access is granted if an encrypted score is >= threshold
    euint32 public encryptedAccessScore;
    uint256 public constant ACCESS_THRESHOLD = 50; // Example threshold

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event PreferencesSubmitted(address indexed submitter, uint256 batchId, euint32 drivingStyle, euint32 routePreference, euint32 comfortLevel);
    event AccessScoreUpdated(address indexed updater, uint256 batchId, euint32 accessScore);
    event DecryptionRequested(uint256 indexed requestId, uint256 batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 batchId, uint256 drivingStyle, uint256 routePreference, uint256 comfortLevel, uint256 accessScore, bool accessGranted);

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error PausedContract();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedContract();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[msg.sender] = true;
        emit ProviderAdded(msg.sender);
        cooldownSeconds = 60; // Default 1 minute cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        // Also transfer provider status if desired, or manage separately
        // For simplicity, we don't auto-transfer provider status here.
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batchOpen = true;
        batchSubmissionCount[currentBatchId] = 0;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert InvalidBatch();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitPreferences(
        euint32 _drivingStyle,
        euint32 _routePreference,
        euint32 _comfortLevel
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchNotOpen();

        _initIfNeeded(encryptedDrivingStyle);
        _initIfNeeded(encryptedRoutePreference);
        _initIfNeeded(encryptedComfortLevel);

        encryptedDrivingStyle = encryptedDrivingStyle.add(_drivingStyle);
        encryptedRoutePreference = encryptedRoutePreference.add(_routePreference);
        encryptedComfortLevel = encryptedComfortLevel.add(_comfortLevel);

        batchSubmissionCount[currentBatchId]++;
        lastSubmissionTime[msg.sender] = block.timestamp;

        emit PreferencesSubmitted(msg.sender, currentBatchId, _drivingStyle, _routePreference, _comfortLevel);
    }

    function updateAccessScore(euint32 _accessScore) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchNotOpen();

        _initIfNeeded(encryptedAccessScore);
        encryptedAccessScore = encryptedAccessScore.add(_accessScore);
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit AccessScoreUpdated(msg.sender, currentBatchId, _accessScore);
    }

    function requestAccessCheck() external whenNotPaused checkDecryptionCooldown {
        if (!batchOpen) revert BatchNotOpen(); // Or allow only on closed batches, depending on logic

        _requireInitialized(encryptedDrivingStyle);
        _requireInitialized(encryptedRoutePreference);
        _requireInitialized(encryptedComfortLevel);
        _requireInitialized(encryptedAccessScore);

        // 1. Prepare Ciphertexts
        bytes32[] memory cts = new bytes32[](4);
        cts[0] = encryptedDrivingStyle.toBytes32();
        cts[1] = encryptedRoutePreference.toBytes32();
        cts[2] = encryptedComfortLevel.toBytes32();
        cts[3] = encryptedAccessScore.toBytes32();

        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({ batchId: currentBatchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        emit DecryptionRequested(requestId, currentBatchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        // 5a. Replay Guard
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }

        // 5b. State Verification
        // Rebuild cts in the exact same order as in requestAccessCheck
        bytes32[] memory currentCts = new bytes32[](4);
        currentCts[0] = encryptedDrivingStyle.toBytes32();
        currentCts[1] = encryptedRoutePreference.toBytes32();
        currentCts[2] = encryptedComfortLevel.toBytes32();
        currentCts[3] = encryptedAccessScore.toBytes32();

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }
        // Security Comment: State hash verification ensures that the ciphertexts being decrypted
        // are the same ones that were present when the decryption was requested, preventing
        // certain front-running or reordering attacks.

        // 5c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // 5d. Decode & Finalize
        // Cleartexts are expected in the same order: drivingStyle, routePreference, comfortLevel, accessScore
        uint256 drivingStyleCleartext = abi.decode(cleartexts[0:32], (uint256));
        uint256 routePreferenceCleartext = abi.decode(cleartexts[32:64], (uint256));
        uint256 comfortLevelCleartext = abi.decode(cleartexts[64:96], (uint256));
        uint256 accessScoreCleartext = abi.decode(cleartexts[96:128], (uint256));

        bool accessGranted = accessScoreCleartext >= ACCESS_THRESHOLD;

        decryptionContexts[requestId].processed = true;

        emit DecryptionCompleted(
            requestId,
            decryptionContexts[requestId].batchId,
            drivingStyleCleartext,
            routePreferenceCleartext,
            comfortLevelCleartext,
            accessScoreCleartext,
            accessGranted
        );
        // The DAV system would then use this 'accessGranted' information.
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 v) internal {
        if (!v.isInitialized()) {
            v = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 v) internal view {
        if (!v.isInitialized()) {
            revert NotInitialized();
        }
    }
}