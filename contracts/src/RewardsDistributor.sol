// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title RewardsDistributor
/// @notice Settles the 24-hour Rewards Distribution on chain (masterplan §17).
///
/// @dev The contract holds SPY and pays it out against Merkle roots published
/// by an authorised role. It deliberately knows nothing about War Points,
/// picks, battles or eligibility — all of that is offchain authoritative game
/// state (§19), and teaching the contract about it would put gameplay rules
/// somewhere they cannot be corrected.
///
/// What the contract does guarantee:
///
/// - A published root is **immutable**. There is no function that edits or
///   replaces one, so admin cannot change an individual reward after the fact.
/// - A claim happens **once**. Double-claiming is prevented by storage, not by
///   the caller behaving.
/// - Admin can withdraw **only uncommitted funds**. SPY backing a published
///   distribution cannot be pulled out from under the people entitled to it,
///   pause or no pause.
/// - Pausing stops claims. It does not delete an entitlement — the proof stays
///   valid and the claim succeeds once unpaused.
///
/// Non-upgradeable by design (§19). If the logic must change, a new contract is
/// deployed and the old one keeps paying out what it already owes.
contract RewardsDistributor is AccessControl, Pausable {
    using SafeERC20 for IERC20;

    /// @notice May publish a finalized distribution root (§20).
    bytes32 public constant DISTRIBUTION_PUBLISHER_ROLE = keccak256("DISTRIBUTION_PUBLISHER_ROLE");

    /// @notice May pause and unpause claims in an emergency (§20).
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice May withdraw uncommitted funds (§20).
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");

    /// @notice The reward token. Immutable: a distributor that could switch
    /// tokens mid-life would make every historical accounting record ambiguous.
    IERC20 public immutable REWARD_TOKEN;

    struct Distribution {
        bytes32 root;
        /// Total the root allocates. Committed on publication so it cannot be
        /// withdrawn while claims remain open.
        uint256 total;
        uint256 claimed;
        /// Kept at full width rather than packed into a smaller integer. The
        /// other three fields already occupy whole slots, so narrowing this one
        /// saves nothing and would introduce a truncating cast for no gain.
        uint256 publishedAt;
    }

    /// @notice Published distributions by id. Ids come from the offchain window
    /// record, so a root can be traced back to the snapshot that produced it.
    mapping(uint256 distributionId => Distribution) public distributions;

    /// @dev distributionId => wallet => claimed.
    mapping(uint256 => mapping(address => bool)) private _claimed;

    /// @notice Sum of every published total, less everything claimed. This is
    /// the amount the contract owes and may never withdraw.
    uint256 public outstandingCommitment;

    event DistributionPublished(uint256 indexed distributionId, bytes32 root, uint256 total);
    event Claimed(uint256 indexed distributionId, address indexed account, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error DistributionAlreadyPublished(uint256 distributionId);
    error DistributionNotPublished(uint256 distributionId);
    error EmptyRoot();
    error ZeroTotal();
    error AlreadyClaimed(uint256 distributionId, address account);
    error InvalidProof();
    error ClaimExceedsDistribution(uint256 distributionId);
    error InsufficientUncommittedBalance(uint256 requested, uint256 available);
    error ZeroAddress();
    error ZeroAmount();

    /// @param rewardToken The SPY token distributions are paid in.
    /// @param admin Receives `DEFAULT_ADMIN_ROLE`. Expected to be a multisig in
    ///   production (§20) — a single hot key must not hold it.
    constructor(IERC20 rewardToken, address admin) {
        if (address(rewardToken) == address(0) || admin == address(0)) revert ZeroAddress();
        REWARD_TOKEN = rewardToken;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // -----------------------------------------------------------------------
    // Publication
    // -----------------------------------------------------------------------

    /// @notice Publishes a finalized distribution.
    /// @dev Reverts if the id already carries a root. §17 makes published roots
    /// immutable, and the cheapest way to guarantee that is to have no code
    /// path that overwrites one.
    ///
    /// The total is committed immediately, so from this moment the SPY backing
    /// it is outside the treasury's reach.
    ///
    /// Publication is deliberately **not** pausable. Pausing exists to stop
    /// claims during an incident; blocking publication as well would strand a
    /// finalized window that the offchain record already considers settled.
    function publishDistribution(uint256 distributionId, bytes32 root, uint256 total)
        external
        onlyRole(DISTRIBUTION_PUBLISHER_ROLE)
    {
        if (root == bytes32(0)) revert EmptyRoot();
        if (total == 0) revert ZeroTotal();

        Distribution storage distribution = distributions[distributionId];
        if (distribution.root != bytes32(0)) revert DistributionAlreadyPublished(distributionId);

        distribution.root = root;
        distribution.total = total;
        distribution.publishedAt = block.timestamp;

        outstandingCommitment += total;

        emit DistributionPublished(distributionId, root, total);
    }

    // -----------------------------------------------------------------------
    // Claiming
    // -----------------------------------------------------------------------

    /// @notice Claims an allocation.
    /// @dev Claiming is user-driven (§16.8): the contract never pushes funds.
    ///
    /// The leaf is double-hashed. A single `keccak256(abi.encode(...))` leaf can
    /// collide with an internal node of the tree, which lets a crafted proof
    /// authorise a payout that was never in the allocation set. Hashing twice
    /// puts leaves in a domain the internal nodes cannot reach.
    ///
    /// @param distributionId Window to claim from.
    /// @param account Wallet the allocation belongs to. Anyone may submit the
    ///   transaction, but funds always go to `account` — so a third party can
    ///   pay gas for a user without being able to redirect the reward.
    /// @param amount Allocation, in token base units.
    /// @param proof Merkle proof for the leaf.
    function claim(
        uint256 distributionId,
        address account,
        uint256 amount,
        bytes32[] calldata proof
    ) external whenNotPaused {
        Distribution storage distribution = distributions[distributionId];
        if (distribution.root == bytes32(0)) revert DistributionNotPublished(distributionId);
        if (_claimed[distributionId][account]) revert AlreadyClaimed(distributionId, account);

        // Written in Solidity rather than inline assembly on purpose. §19 asks
        // for contracts that are easy to audit, and hand-written assembly in
        // the one line that decides whether a payout is authorised is a poor
        // trade for a few hundred gas on a once-per-wallet call.
        // forge-lint: disable-next-line(asm-keccak256)
        bytes32 leaf =
            keccak256(bytes.concat(keccak256(abi.encode(distributionId, account, amount))));
        if (!MerkleProof.verifyCalldata(proof, distribution.root, leaf)) revert InvalidProof();

        // A correct tree can never exceed its own total. This catches a
        // malformed root before it drains SPY committed to another window.
        uint256 claimedAfter = distribution.claimed + amount;
        if (claimedAfter > distribution.total) revert ClaimExceedsDistribution(distributionId);

        _claimed[distributionId][account] = true;
        distribution.claimed = claimedAfter;
        outstandingCommitment -= amount;

        emit Claimed(distributionId, account, amount);

        REWARD_TOKEN.safeTransfer(account, amount);
    }

    /// @notice Whether a wallet has already claimed from a distribution.
    function hasClaimed(uint256 distributionId, address account) external view returns (bool) {
        return _claimed[distributionId][account];
    }

    // -----------------------------------------------------------------------
    // Treasury
    // -----------------------------------------------------------------------

    /// @notice SPY the treasury may withdraw: everything not owed to a claimant.
    function uncommittedBalance() public view returns (uint256) {
        uint256 balance = REWARD_TOKEN.balanceOf(address(this));
        uint256 committed = outstandingCommitment;
        return balance > committed ? balance - committed : 0;
    }

    /// @notice Withdraws uncommitted SPY.
    /// @dev §17 allows withdrawal only of funds not already committed to active
    /// distributions. Unclaimed rewards from a published window are committed
    /// and stay committed — there is no expiry and no sweep, because a slow
    /// claimant has not forfeited anything.
    ///
    /// Not gated on `whenNotPaused`: pausing is for protecting users during an
    /// incident, and moving genuinely uncommitted funds does not touch them.
    function withdrawUncommitted(address to, uint256 amount) external onlyRole(TREASURY_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 available = uncommittedBalance();
        if (amount > available) revert InsufficientUncommittedBalance(amount, available);

        emit Withdrawn(to, amount);
        REWARD_TOKEN.safeTransfer(to, amount);
    }

    // -----------------------------------------------------------------------
    // Emergency
    // -----------------------------------------------------------------------

    /// @notice Halts claims. Entitlements survive: the proof stays valid and the
    /// claim succeeds once unpaused (§17).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes claims.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
