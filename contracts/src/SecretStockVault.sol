// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title SecretStockVault
/// @notice Holds and pays the fixed Secret Stock Drop reward (masterplan §18).
///
/// @dev Independent of `RewardsDistributor` (§18). The two pools are funded
/// separately, accounted separately, and never netted against each other.
///
/// The contract exists to make one ordering guarantee real. §8.4 requires
/// coverage to be **secured before the reveal**: acquire the lock, re-check
/// coverage, create the entitlement, reserve the reward, commit the Genesis
/// result, and only then show the user. `reserve` is that step, and it is
/// atomic — either the SPY is set aside or the reservation reverts and the
/// user is never shown a Secret that cannot be paid.
///
/// Once reserved, SPY belongs to a named wallet:
///
/// - Admin cannot withdraw it. `withdrawAvailable` can only move
///   `balance - totalReserved`.
/// - It cannot be reassigned to another winner. There is no function that
///   moves a reservation.
/// - Pausing blocks the claim transaction but does not erase the entitlement
///   (§18). The reservation is untouched and claims once unpaused.
contract SecretStockVault is AccessControl, Pausable {
    using SafeERC20 for IERC20;

    /// @notice May reserve a reward against a Genesis result (§20).
    /// @dev Held by the Genesis service, which reserves before revealing.
    bytes32 public constant RESERVER_ROLE = keccak256("RESERVER_ROLE");

    /// @notice May pause and unpause claims (§20).
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice May withdraw unreserved funds (§20).
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");

    /// @notice The reward token, SPY.
    IERC20 public immutable REWARD_TOKEN;

    /// @notice The fixed reward, in token base units.
    /// @dev §8.1 fixes it at 0.2 SPY. Immutable rather than settable: a Secret
    /// whose value could be changed after a user won it would not be the reward
    /// they were shown. The base-unit value depends on the token's decimals,
    /// which are configuration (`docs/OPEN_PARAMETERS.md`), so it is a
    /// constructor argument rather than a literal.
    uint256 public immutable REWARD_AMOUNT;

    enum EntitlementState {
        NONE,
        RESERVED,
        CLAIMED
    }

    /// @notice Entitlement state by wallet. §6 grants one Genesis per wallet,
    /// so a wallet holds at most one Secret, ever.
    mapping(address wallet => EntitlementState) public entitlements;

    /// @notice SPY set aside for winners who have not yet claimed.
    uint256 public totalReserved;

    event Reserved(address indexed account, uint256 amount);
    event SecretClaimed(address indexed account, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error AlreadyEntitled(address account);
    error NoEntitlement(address account);
    error AlreadyClaimed(address account);
    error InsufficientCoverage(uint256 available, uint256 required);
    error InsufficientAvailableBalance(uint256 requested, uint256 available);
    error ZeroAddress();
    error ZeroAmount();

    /// @param rewardToken The SPY token.
    /// @param rewardAmount Fixed reward in base units — 0.2 SPY at the token's
    ///   own decimals.
    /// @param admin Receives `DEFAULT_ADMIN_ROLE`; a multisig in production.
    constructor(IERC20 rewardToken, uint256 rewardAmount, address admin) {
        if (address(rewardToken) == address(0) || admin == address(0)) revert ZeroAddress();
        if (rewardAmount == 0) revert ZeroAmount();
        REWARD_TOKEN = rewardToken;
        REWARD_AMOUNT = rewardAmount;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // -----------------------------------------------------------------------
    // Coverage
    // -----------------------------------------------------------------------

    /// @notice SPY not already promised to a winner.
    /// @dev §8.3: `availableSecretBalance = vaultBalance - reservedBalance`.
    function availableBalance() public view returns (uint256) {
        uint256 balance = REWARD_TOKEN.balanceOf(address(this));
        uint256 reserved = totalReserved;
        return balance > reserved ? balance - reserved : 0;
    }

    /// @notice Whether the vault can currently cover one more Secret.
    /// @dev The offchain RNG reads this to decide whether the Secret band is
    /// reachable at all (§8.3). While it is false the 0.1% is reassigned to
    /// Legendary and no Secret can be drawn.
    ///
    /// True at exactly one remaining reward: §8.4 allows one final reservation,
    /// after which the vault becomes dormant until refunded.
    function isCovered() external view returns (bool) {
        return availableBalance() >= REWARD_AMOUNT;
    }

    // -----------------------------------------------------------------------
    // Reservation
    // -----------------------------------------------------------------------

    /// @notice Reserves the reward for a Secret winner.
    /// @dev Called **before** the result is revealed (§8.4). If coverage has
    /// gone since the RNG checked, this reverts and the reveal does not happen —
    /// which is the entire point: a user must never see a successful Secret
    /// without secured coverage.
    ///
    /// Reservation is not pausable. Pausing stops payouts during an incident;
    /// blocking reservation instead would let a Genesis reveal proceed against
    /// a vault that never set the money aside.
    function reserve(address account) external onlyRole(RESERVER_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (entitlements[account] != EntitlementState.NONE) revert AlreadyEntitled(account);

        uint256 available = availableBalance();
        if (available < REWARD_AMOUNT) revert InsufficientCoverage(available, REWARD_AMOUNT);

        entitlements[account] = EntitlementState.RESERVED;
        totalReserved += REWARD_AMOUNT;

        emit Reserved(account, REWARD_AMOUNT);
    }

    // -----------------------------------------------------------------------
    // Claiming
    // -----------------------------------------------------------------------

    /// @notice Claims a reserved reward.
    /// @dev The winner claims for themselves. §8.5 lets them claim immediately
    /// or later, with no expiry — a reservation held for a year is still theirs.
    function claim() external whenNotPaused {
        EntitlementState state = entitlements[msg.sender];
        if (state == EntitlementState.NONE) revert NoEntitlement(msg.sender);
        if (state == EntitlementState.CLAIMED) revert AlreadyClaimed(msg.sender);

        // State moves to CLAIMED rather than back to NONE. §8.5 keeps the
        // trophy permanently visible in the profile, and an entitlement that
        // erased itself would let the same wallet be reserved a second time.
        entitlements[msg.sender] = EntitlementState.CLAIMED;
        totalReserved -= REWARD_AMOUNT;

        emit SecretClaimed(msg.sender, REWARD_AMOUNT);

        REWARD_TOKEN.safeTransfer(msg.sender, REWARD_AMOUNT);
    }

    // -----------------------------------------------------------------------
    // Treasury
    // -----------------------------------------------------------------------

    /// @notice Withdraws unreserved SPY.
    /// @dev §18: admin may withdraw only `balance - reservedBalance`. Reserved
    /// SPY is unreachable from here by construction, not by policy.
    function withdrawAvailable(address to, uint256 amount) external onlyRole(TREASURY_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 available = availableBalance();
        if (amount > available) revert InsufficientAvailableBalance(amount, available);

        emit Withdrawn(to, amount);
        REWARD_TOKEN.safeTransfer(to, amount);
    }

    // -----------------------------------------------------------------------
    // Emergency
    // -----------------------------------------------------------------------

    /// @notice Halts claims without erasing any entitlement (§18).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resumes claims.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
