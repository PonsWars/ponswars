// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SecretStockVault} from "../src/SecretStockVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract SecretStockVaultTest is Test {
    SecretStockVault internal vault;
    MockERC20 internal spy;

    address internal admin = makeAddr("admin");
    address internal reserver = makeAddr("reserver");
    address internal pauser = makeAddr("pauser");
    address internal treasury = makeAddr("treasury");
    address internal winner = makeAddr("winner");
    address internal other = makeAddr("other");

    // SPY decimals are OPEN. Six here, so an assumption of 18 fails loudly.
    uint256 internal constant ONE_SPY = 1e6;

    /// The locked 0.2 SPY reward (§8.1), at six decimals.
    uint256 internal constant REWARD = 200_000;

    function setUp() public {
        spy = new MockERC20("Stock Token", "SPY", 6);
        vault = new SecretStockVault(spy, REWARD, admin);

        vm.startPrank(admin);
        vault.grantRole(vault.RESERVER_ROLE(), reserver);
        vault.grantRole(vault.PAUSER_ROLE(), pauser);
        vault.grantRole(vault.TREASURY_ROLE(), treasury);
        vm.stopPrank();
    }

    function _fund(uint256 amount) internal {
        spy.mint(address(vault), amount);
    }

    // -----------------------------------------------------------------------
    // Deployment
    // -----------------------------------------------------------------------

    function test_constructor_fixesTheReward() public view {
        // §8.1 fixes the reward at 0.2 SPY. Immutable, because a Secret whose
        // value could change after a user won it is not the reward they saw.
        assertEq(vault.REWARD_AMOUNT(), REWARD);
        assertEq(address(vault.REWARD_TOKEN()), address(spy));
    }

    function test_constructor_rejectsZeroValues() public {
        vm.expectRevert(SecretStockVault.ZeroAddress.selector);
        new SecretStockVault(spy, REWARD, address(0));

        vm.expectRevert(SecretStockVault.ZeroAmount.selector);
        new SecretStockVault(spy, 0, admin);
    }

    // -----------------------------------------------------------------------
    // Coverage (§8.3)
    // -----------------------------------------------------------------------

    function test_coverage_isDormantWhenEmpty() public view {
        assertEq(vault.availableBalance(), 0);
        assertFalse(vault.isCovered());
    }

    function test_coverage_becomesActiveAtExactlyOneReward() public {
        // §8.3: RNG is active only when available >= one full reward. The
        // boundary matters — one base unit short must read as dormant.
        _fund(REWARD - 1);
        assertFalse(vault.isCovered());

        _fund(1);
        assertTrue(vault.isCovered());
    }

    function test_coverage_excludesReservedFunds() public {
        // §8.3: availableSecretBalance = vaultBalance - reservedBalance.
        // Reserved SPY belongs to a named winner and is never available.
        _fund(REWARD * 2);
        assertEq(vault.availableBalance(), REWARD * 2);

        vm.prank(reserver);
        vault.reserve(winner);

        assertEq(vault.availableBalance(), REWARD);
        assertEq(vault.totalReserved(), REWARD);
    }

    function test_coverage_allowsOneFinalReservationThenGoesDormant() public {
        // §8.4: if only 0.2 SPY remains, one final Secret may be reserved,
        // after which the vault is inactive until refunded.
        _fund(REWARD);
        assertTrue(vault.isCovered());

        vm.prank(reserver);
        vault.reserve(winner);

        assertFalse(vault.isCovered());
        assertEq(vault.availableBalance(), 0);
    }

    // -----------------------------------------------------------------------
    // Reservation (§8.4)
    // -----------------------------------------------------------------------

    function test_reserve_requiresTheRole() public {
        _fund(REWARD);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                other,
                vault.RESERVER_ROLE()
            )
        );
        vm.prank(other);
        vault.reserve(winner);
    }

    function test_reserve_revertsWithoutCoverage() public {
        // The guarantee that makes reserve-before-reveal real: if coverage has
        // gone since the RNG checked, the reservation fails and the reveal
        // never happens.
        _fund(REWARD - 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                SecretStockVault.InsufficientCoverage.selector, REWARD - 1, REWARD
            )
        );
        vm.prank(reserver);
        vault.reserve(winner);

        assertEq(uint256(vault.entitlements(winner)), 0);
        assertEq(vault.totalReserved(), 0);
    }

    function test_reserve_isOncePerWallet() public {
        // §6 grants one Genesis per wallet, so one Secret per wallet, ever.
        _fund(REWARD * 3);

        vm.prank(reserver);
        vault.reserve(winner);

        vm.expectRevert(abi.encodeWithSelector(SecretStockVault.AlreadyEntitled.selector, winner));
        vm.prank(reserver);
        vault.reserve(winner);

        assertEq(vault.totalReserved(), REWARD);
    }

    function test_reserve_rejectsZeroAddress() public {
        _fund(REWARD);
        vm.expectRevert(SecretStockVault.ZeroAddress.selector);
        vm.prank(reserver);
        vault.reserve(address(0));
    }

    function test_reserve_worksWhilePaused() public {
        // Pausing stops payouts during an incident. Blocking reservation would
        // let a Genesis reveal proceed against a vault that never set the money
        // aside — the exact failure §8.4 exists to prevent.
        _fund(REWARD);
        vm.prank(pauser);
        vault.pause();

        vm.prank(reserver);
        vault.reserve(winner);

        assertEq(uint256(vault.entitlements(winner)), 1);
    }

    // -----------------------------------------------------------------------
    // Claiming (§8.5)
    // -----------------------------------------------------------------------

    function test_claim_paysTheExactReward() public {
        _fund(REWARD * 2);
        vm.prank(reserver);
        vault.reserve(winner);

        vm.prank(winner);
        vault.claim();

        assertEq(spy.balanceOf(winner), REWARD);
        assertEq(vault.totalReserved(), 0);
        assertEq(uint256(vault.entitlements(winner)), 2);
    }

    function test_claim_requiresAnEntitlement() public {
        _fund(REWARD);
        vm.expectRevert(abi.encodeWithSelector(SecretStockVault.NoEntitlement.selector, other));
        vm.prank(other);
        vault.claim();
    }

    function test_claim_happensOnce() public {
        _fund(REWARD * 2);
        vm.prank(reserver);
        vault.reserve(winner);

        vm.prank(winner);
        vault.claim();

        vm.expectRevert(abi.encodeWithSelector(SecretStockVault.AlreadyClaimed.selector, winner));
        vm.prank(winner);
        vault.claim();
    }

    function test_claim_leavesTheTrophyInPlace() public {
        // §8.5: after a claim the trophy stays permanently in the profile. The
        // state moves to CLAIMED rather than back to NONE — resetting it would
        // also let the same wallet be reserved a second time.
        _fund(REWARD * 2);
        vm.prank(reserver);
        vault.reserve(winner);
        vm.prank(winner);
        vault.claim();

        assertEq(uint256(vault.entitlements(winner)), 2);

        vm.expectRevert(abi.encodeWithSelector(SecretStockVault.AlreadyEntitled.selector, winner));
        vm.prank(reserver);
        vault.reserve(winner);
    }

    function test_claim_hasNoExpiry() public {
        // §8.5: the user may claim immediately or later. A reservation held for
        // years is still theirs.
        _fund(REWARD);
        vm.prank(reserver);
        vault.reserve(winner);

        vm.warp(block.timestamp + 3650 days);

        vm.prank(winner);
        vault.claim();
        assertEq(spy.balanceOf(winner), REWARD);
    }

    function test_claim_isBlockedWhilePausedAndSurvivesIt() public {
        // §18: pause must not erase an entitlement.
        _fund(REWARD);
        vm.prank(reserver);
        vault.reserve(winner);

        vm.prank(pauser);
        vault.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(winner);
        vault.claim();

        // The reservation is untouched throughout.
        assertEq(uint256(vault.entitlements(winner)), 1);
        assertEq(vault.totalReserved(), REWARD);

        vm.prank(pauser);
        vault.unpause();

        vm.prank(winner);
        vault.claim();
        assertEq(spy.balanceOf(winner), REWARD);
    }

    // -----------------------------------------------------------------------
    // Treasury (§18)
    // -----------------------------------------------------------------------

    function test_withdraw_cannotTouchReservedFunds() public {
        // The core §18 guarantee: reserved SPY is unreachable from the treasury
        // by construction, not by policy.
        _fund(REWARD * 2);
        vm.prank(reserver);
        vault.reserve(winner);

        vm.expectRevert(
            abi.encodeWithSelector(
                SecretStockVault.InsufficientAvailableBalance.selector, REWARD + 1, REWARD
            )
        );
        vm.prank(treasury);
        vault.withdrawAvailable(treasury, REWARD + 1);
    }

    function test_withdraw_movesUnreservedFunds() public {
        _fund(REWARD * 3);
        vm.prank(reserver);
        vault.reserve(winner);

        vm.prank(treasury);
        vault.withdrawAvailable(treasury, REWARD * 2);

        assertEq(spy.balanceOf(treasury), REWARD * 2);
        // Exactly the reserved amount remains, so the winner is still paid.
        assertEq(spy.balanceOf(address(vault)), REWARD);

        vm.prank(winner);
        vault.claim();
        assertEq(spy.balanceOf(winner), REWARD);
    }

    function test_withdraw_requiresTheRole() public {
        _fund(REWARD);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                other,
                vault.TREASURY_ROLE()
            )
        );
        vm.prank(other);
        vault.withdrawAvailable(other, 1);
    }

    function test_withdraw_rejectsZeroTargetAndAmount() public {
        _fund(REWARD);
        vm.startPrank(treasury);
        vm.expectRevert(SecretStockVault.ZeroAddress.selector);
        vault.withdrawAvailable(address(0), 1);

        vm.expectRevert(SecretStockVault.ZeroAmount.selector);
        vault.withdrawAvailable(treasury, 0);
        vm.stopPrank();
    }

    function test_rolesAreSeparate() public view {
        assertFalse(vault.hasRole(vault.TREASURY_ROLE(), reserver));
        assertFalse(vault.hasRole(vault.RESERVER_ROLE(), treasury));
        assertFalse(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), address(this)));
    }

    // -----------------------------------------------------------------------
    // Invariants under fuzzing
    // -----------------------------------------------------------------------

    function testFuzz_reservedIsNeverWithdrawable(uint96 funding, uint8 winners) public {
        uint256 count = uint256(winners) % 10;
        vm.assume(funding >= REWARD * count);

        _fund(funding);

        for (uint256 i = 0; i < count; i++) {
            vm.prank(reserver);
            vault.reserve(vm.addr(i + 1));
        }

        assertEq(vault.totalReserved(), REWARD * count);
        assertEq(vault.availableBalance(), uint256(funding) - REWARD * count);

        // Whatever the treasury drains, every reserved reward is still payable.
        uint256 available = vault.availableBalance();
        if (available > 0) {
            vm.prank(treasury);
            vault.withdrawAvailable(treasury, available);
        }
        assertGe(spy.balanceOf(address(vault)), vault.totalReserved());

        for (uint256 i = 0; i < count; i++) {
            vm.prank(vm.addr(i + 1));
            vault.claim();
            assertEq(spy.balanceOf(vm.addr(i + 1)), REWARD);
        }
        assertEq(spy.balanceOf(address(vault)), 0);
    }

    function testFuzz_coverageMatchesTheRngGate(uint96 funding) public {
        _fund(funding);
        // The offchain RNG reads isCovered to decide whether the Secret band is
        // reachable. If the two ever disagreed, a user could be shown a Secret
        // the vault cannot pay.
        assertEq(vault.isCovered(), vault.availableBalance() >= REWARD);
    }
}
