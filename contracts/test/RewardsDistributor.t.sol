// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {RewardsDistributor} from "../src/RewardsDistributor.sol";
import {MerkleHelper} from "./MerkleHelper.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract RewardsDistributorTest is Test {
    RewardsDistributor internal distributor;
    MockERC20 internal spy;

    address internal admin = makeAddr("admin");
    address internal publisher = makeAddr("publisher");
    address internal pauser = makeAddr("pauser");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant DISTRIBUTION_ID = 1;

    // SPY decimals are OPEN; the tests use 6 so an assumption of 18 shows up.
    uint256 internal constant ONE_SPY = 1e6;

    function setUp() public {
        spy = new MockERC20("Stock Token", "SPY", 6);
        distributor = new RewardsDistributor(spy, admin);

        vm.startPrank(admin);
        distributor.grantRole(distributor.DISTRIBUTION_PUBLISHER_ROLE(), publisher);
        distributor.grantRole(distributor.PAUSER_ROLE(), pauser);
        distributor.grantRole(distributor.TREASURY_ROLE(), treasury);
        vm.stopPrank();

        spy.mint(address(distributor), 1_000 * ONE_SPY);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _threeLeaves() internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](3);
        leaves[0] = MerkleHelper.leafOf(DISTRIBUTION_ID, alice, 10 * ONE_SPY);
        leaves[1] = MerkleHelper.leafOf(DISTRIBUTION_ID, bob, 20 * ONE_SPY);
        leaves[2] = MerkleHelper.leafOf(DISTRIBUTION_ID, carol, 30 * ONE_SPY);
    }

    function _publishThree() internal returns (bytes32[] memory leaves) {
        leaves = _threeLeaves();
        vm.prank(publisher);
        distributor.publishDistribution(DISTRIBUTION_ID, MerkleHelper.root(leaves), 60 * ONE_SPY);
    }

    // -----------------------------------------------------------------------
    // Deployment
    // -----------------------------------------------------------------------

    function test_constructor_setsTokenAndAdmin() public view {
        assertEq(address(distributor.REWARD_TOKEN()), address(spy));
        assertTrue(distributor.hasRole(distributor.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        new RewardsDistributor(spy, address(0));
    }

    function test_deployerHoldsNoRole() public view {
        // §20 separates permissions. The deploying key must not silently keep
        // admin rights just because it ran the transaction.
        assertFalse(distributor.hasRole(distributor.DEFAULT_ADMIN_ROLE(), address(this)));
    }

    // -----------------------------------------------------------------------
    // Publication
    // -----------------------------------------------------------------------

    function test_publish_commitsTheTotal() public {
        bytes32[] memory leaves = _publishThree();
        (bytes32 root, uint256 total, uint256 claimed, uint256 publishedAt) =
            distributor.distributions(DISTRIBUTION_ID);

        assertEq(root, MerkleHelper.root(leaves));
        assertEq(total, 60 * ONE_SPY);
        assertEq(claimed, 0);
        assertEq(publishedAt, block.timestamp);
        assertEq(distributor.outstandingCommitment(), 60 * ONE_SPY);
    }

    function test_publish_requiresTheRole() public {
        bytes32[] memory leaves = _threeLeaves();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                distributor.DISTRIBUTION_PUBLISHER_ROLE()
            )
        );
        vm.prank(alice);
        distributor.publishDistribution(DISTRIBUTION_ID, MerkleHelper.root(leaves), 60 * ONE_SPY);
    }

    function test_publish_isImmutable() public {
        // §17: published roots are immutable and admin may not edit individual
        // rewards afterwards. There is no overwrite path, not even for admin.
        _publishThree();

        vm.expectRevert(
            abi.encodeWithSelector(
                RewardsDistributor.DistributionAlreadyPublished.selector, DISTRIBUTION_ID
            )
        );
        vm.prank(publisher);
        distributor.publishDistribution(DISTRIBUTION_ID, keccak256("different"), 1);
    }

    function test_publish_rejectsEmptyRootAndZeroTotal() public {
        vm.startPrank(publisher);
        vm.expectRevert(RewardsDistributor.EmptyRoot.selector);
        distributor.publishDistribution(DISTRIBUTION_ID, bytes32(0), 1);

        vm.expectRevert(RewardsDistributor.ZeroTotal.selector);
        distributor.publishDistribution(DISTRIBUTION_ID, keccak256("root"), 0);
        vm.stopPrank();
    }

    function test_publish_worksWhilePaused() public {
        // Pausing protects claimants during an incident. Blocking publication
        // too would strand a window the offchain record already settled.
        vm.prank(pauser);
        distributor.pause();
        _publishThree();
        assertEq(distributor.outstandingCommitment(), 60 * ONE_SPY);
    }

    // -----------------------------------------------------------------------
    // Claiming
    // -----------------------------------------------------------------------

    function test_claim_paysTheAllocation() public {
        bytes32[] memory leaves = _publishThree();

        distributor.claim(DISTRIBUTION_ID, alice, 10 * ONE_SPY, MerkleHelper.proof(leaves, 0));

        assertEq(spy.balanceOf(alice), 10 * ONE_SPY);
        assertTrue(distributor.hasClaimed(DISTRIBUTION_ID, alice));
        assertEq(distributor.outstandingCommitment(), 50 * ONE_SPY);
    }

    function test_claim_paysTheAccountNotTheCaller() public {
        // A third party may pay gas for a user without being able to redirect
        // the reward.
        bytes32[] memory leaves = _publishThree();

        vm.prank(bob);
        distributor.claim(DISTRIBUTION_ID, alice, 10 * ONE_SPY, MerkleHelper.proof(leaves, 0));

        assertEq(spy.balanceOf(alice), 10 * ONE_SPY);
        assertEq(spy.balanceOf(bob), 0);
    }

    function test_claim_rejectsASecondClaim() public {
        bytes32[] memory leaves = _publishThree();
        bytes32[] memory proof = MerkleHelper.proof(leaves, 0);

        distributor.claim(DISTRIBUTION_ID, alice, 10 * ONE_SPY, proof);

        vm.expectRevert(
            abi.encodeWithSelector(
                RewardsDistributor.AlreadyClaimed.selector, DISTRIBUTION_ID, alice
            )
        );
        distributor.claim(DISTRIBUTION_ID, alice, 10 * ONE_SPY, proof);
    }

    function test_claim_rejectsAWrongAmount() public {
        // The amount is inside the leaf, so inflating it invalidates the proof.
        bytes32[] memory leaves = _publishThree();

        vm.expectRevert(RewardsDistributor.InvalidProof.selector);
        distributor.claim(DISTRIBUTION_ID, alice, 11 * ONE_SPY, MerkleHelper.proof(leaves, 0));
    }

    function test_claim_rejectsAnotherAccountsProof() public {
        bytes32[] memory leaves = _publishThree();

        vm.expectRevert(RewardsDistributor.InvalidProof.selector);
        distributor.claim(DISTRIBUTION_ID, alice, 20 * ONE_SPY, MerkleHelper.proof(leaves, 1));
    }

    function test_claim_rejectsAProofFromAnotherDistribution() public {
        // The distribution id is inside the leaf, so a valid proof for window 1
        // proves nothing about window 2.
        bytes32[] memory leaves = _publishThree();

        bytes32[] memory other = new bytes32[](1);
        other[0] = MerkleHelper.leafOf(2, alice, 10 * ONE_SPY);
        vm.prank(publisher);
        distributor.publishDistribution(2, MerkleHelper.root(other), 10 * ONE_SPY);

        vm.expectRevert(RewardsDistributor.InvalidProof.selector);
        distributor.claim(2, alice, 10 * ONE_SPY, MerkleHelper.proof(leaves, 0));
    }

    function test_claim_rejectsAnUnpublishedDistribution() public {
        bytes32[] memory leaves = _threeLeaves();

        vm.expectRevert(
            abi.encodeWithSelector(RewardsDistributor.DistributionNotPublished.selector, 99)
        );
        distributor.claim(99, alice, 10 * ONE_SPY, MerkleHelper.proof(leaves, 0));
    }

    function test_claim_isBlockedWhilePausedAndSurvivesIt() public {
        // §17: pausing must not delete an entitlement.
        bytes32[] memory leaves = _publishThree();
        bytes32[] memory proof = MerkleHelper.proof(leaves, 0);

        vm.prank(pauser);
        distributor.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        distributor.claim(DISTRIBUTION_ID, alice, 10 * ONE_SPY, proof);

        vm.prank(pauser);
        distributor.unpause();

        distributor.claim(DISTRIBUTION_ID, alice, 10 * ONE_SPY, proof);
        assertEq(spy.balanceOf(alice), 10 * ONE_SPY);
    }

    function test_claim_neverExceedsTheDistributionTotal() public {
        // Defence against a malformed root: even a valid proof cannot pull more
        // than the window was published for, so one window cannot drain
        // another's committed SPY.
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = MerkleHelper.leafOf(7, alice, 100 * ONE_SPY);

        vm.prank(publisher);
        distributor.publishDistribution(7, MerkleHelper.root(leaves), 10 * ONE_SPY);

        vm.expectRevert(
            abi.encodeWithSelector(RewardsDistributor.ClaimExceedsDistribution.selector, 7)
        );
        distributor.claim(7, alice, 100 * ONE_SPY, MerkleHelper.proof(leaves, 0));
    }

    function test_claim_allThreeSettlesTheWindow() public {
        bytes32[] memory leaves = _publishThree();

        distributor.claim(DISTRIBUTION_ID, alice, 10 * ONE_SPY, MerkleHelper.proof(leaves, 0));
        distributor.claim(DISTRIBUTION_ID, bob, 20 * ONE_SPY, MerkleHelper.proof(leaves, 1));
        distributor.claim(DISTRIBUTION_ID, carol, 30 * ONE_SPY, MerkleHelper.proof(leaves, 2));

        assertEq(distributor.outstandingCommitment(), 0);
        (bytes32 root, uint256 total, uint256 claimed, uint256 publishedAt) =
            distributor.distributions(DISTRIBUTION_ID);
        assertEq(claimed, total);
        assertEq(claimed, 60 * ONE_SPY);
        assertTrue(root != bytes32(0));
        assertGt(publishedAt, 0);
    }

    // -----------------------------------------------------------------------
    // Treasury
    // -----------------------------------------------------------------------

    function test_withdraw_cannotTouchCommittedFunds() public {
        // §17: withdrawal of unallocated funds only. This is the property that
        // stops a treasury key from emptying a published window.
        _publishThree();

        assertEq(distributor.uncommittedBalance(), 940 * ONE_SPY);

        vm.expectRevert(
            abi.encodeWithSelector(
                RewardsDistributor.InsufficientUncommittedBalance.selector,
                941 * ONE_SPY,
                940 * ONE_SPY
            )
        );
        vm.prank(treasury);
        distributor.withdrawUncommitted(treasury, 941 * ONE_SPY);
    }

    function test_withdraw_movesUncommittedFunds() public {
        _publishThree();

        vm.prank(treasury);
        distributor.withdrawUncommitted(treasury, 940 * ONE_SPY);

        assertEq(spy.balanceOf(treasury), 940 * ONE_SPY);
        // Exactly the committed amount remains, so every claimant is still paid.
        assertEq(spy.balanceOf(address(distributor)), 60 * ONE_SPY);
        assertEq(distributor.uncommittedBalance(), 0);
    }

    function test_withdraw_leavesEnoughForEveryClaimant() public {
        bytes32[] memory leaves = _publishThree();

        // Read the balance before pranking. vm.prank applies to the next call,
        // and an argument that is itself a call would consume it - the withdraw
        // would then run as this contract and revert on the role check.
        uint256 available = distributor.uncommittedBalance();
        vm.prank(treasury);
        distributor.withdrawUncommitted(treasury, available);

        distributor.claim(DISTRIBUTION_ID, alice, 10 * ONE_SPY, MerkleHelper.proof(leaves, 0));
        distributor.claim(DISTRIBUTION_ID, bob, 20 * ONE_SPY, MerkleHelper.proof(leaves, 1));
        distributor.claim(DISTRIBUTION_ID, carol, 30 * ONE_SPY, MerkleHelper.proof(leaves, 2));

        assertEq(spy.balanceOf(address(distributor)), 0);
    }

    function test_withdraw_requiresTheRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                distributor.TREASURY_ROLE()
            )
        );
        vm.prank(alice);
        distributor.withdrawUncommitted(alice, 1);
    }

    function test_withdraw_rejectsZeroTargetAndAmount() public {
        vm.startPrank(treasury);
        vm.expectRevert(RewardsDistributor.ZeroAddress.selector);
        distributor.withdrawUncommitted(address(0), 1);

        vm.expectRevert(RewardsDistributor.ZeroAmount.selector);
        distributor.withdrawUncommitted(treasury, 0);
        vm.stopPrank();
    }

    function test_unclaimedRewardsAreNeverSwept() public {
        // §16.7 and §8.5 give no expiry. A slow claimant has not forfeited
        // anything, so the commitment stands however long it takes.
        _publishThree();
        vm.warp(block.timestamp + 3650 days);

        assertEq(distributor.outstandingCommitment(), 60 * ONE_SPY);
        vm.expectRevert();
        vm.prank(treasury);
        distributor.withdrawUncommitted(treasury, 1_000 * ONE_SPY);
    }

    // -----------------------------------------------------------------------
    // Roles
    // -----------------------------------------------------------------------

    function test_pause_requiresTheRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                distributor.PAUSER_ROLE()
            )
        );
        vm.prank(alice);
        distributor.pause();
    }

    function test_rolesAreSeparate() public view {
        // §20: no single key holds every sensitive permission.
        assertFalse(distributor.hasRole(distributor.TREASURY_ROLE(), publisher));
        assertFalse(distributor.hasRole(distributor.DISTRIBUTION_PUBLISHER_ROLE(), treasury));
        assertFalse(distributor.hasRole(distributor.PAUSER_ROLE(), publisher));
    }

    // -----------------------------------------------------------------------
    // Fuzz
    // -----------------------------------------------------------------------

    function testFuzz_uncommittedNeverIncludesCommittedFunds(uint96 total, uint96 extra) public {
        vm.assume(total > 0);

        spy.mint(address(distributor), extra);
        uint256 balance = spy.balanceOf(address(distributor));
        vm.assume(uint256(total) <= balance);

        vm.prank(publisher);
        distributor.publishDistribution(42, keccak256("root"), total);

        assertEq(distributor.uncommittedBalance(), balance - total);
        assertLe(distributor.uncommittedBalance() + distributor.outstandingCommitment(), balance);
    }

    function testFuzz_claimingRequiresAMatchingLeaf(uint256 amount, address account) public {
        vm.assume(account != address(0));
        bytes32[] memory leaves = _publishThree();

        if (account == alice && amount == 10 * ONE_SPY) return;

        vm.expectRevert();
        distributor.claim(DISTRIBUTION_ID, account, amount, MerkleHelper.proof(leaves, 0));
    }
}
