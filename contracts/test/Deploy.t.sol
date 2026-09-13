// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {GrantRoles} from "../script/GrantRoles.s.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract DeployTest is Test {
    Deploy internal script;
    MockERC20 internal spy;
    address internal admin = makeAddr("admin");

    function setUp() public {
        script = new Deploy();
        // Six decimals, so a hidden assumption of eighteen fails here.
        spy = new MockERC20("Stock Token", "SPY", 6);
        vm.chainId(46630);
    }

    function test_DeploysBothContractsOnRobinhoodChainTestnet() public {
        Deploy.Deployment memory deployment = script.deploy(admin, address(spy), 6);

        assertEq(address(deployment.distributor.REWARD_TOKEN()), address(spy));
        assertEq(address(deployment.vault.REWARD_TOKEN()), address(spy));
        // 0.2 SPY at six decimals (§8.1).
        assertEq(deployment.vault.REWARD_AMOUNT(), 200_000);
        assertEq(deployment.secretRewardAmount, 200_000);
    }

    function test_GivesTheAdminEverythingAndTheDeployerNothing() public {
        Deploy.Deployment memory deployment = script.deploy(admin, address(spy), 6);
        bytes32 adminRole = deployment.distributor.DEFAULT_ADMIN_ROLE();

        assertTrue(deployment.distributor.hasRole(adminRole, admin));
        assertTrue(deployment.vault.hasRole(adminRole, admin));
        // The broadcasting key walks away with no power over either contract.
        address deployer = DEFAULT_SENDER;
        assertFalse(deployment.distributor.hasRole(adminRole, deployer));
        assertFalse(deployment.vault.hasRole(adminRole, deployer));
        assertFalse(deployment.vault.hasRole(deployment.vault.RESERVER_ROLE(), deployer));
        assertFalse(
            deployment.distributor
                .hasRole(deployment.distributor.DISTRIBUTION_PUBLISHER_ROLE(), deployer)
        );
    }

    function test_DeploysOnRobinhoodChainMainnetWithEighteenDecimals() public {
        MockERC20 spy18 = new MockERC20("Stock Token", "SPY", 18);

        assertEq(script.checkedRewardAmount(4663, admin, address(spy18), 18), 2e17);
    }

    function test_RefusesEveryOtherChain() public {
        uint256[3] memory others = [uint256(1), 8453, 84532];
        for (uint256 index = 0; index < others.length; index++) {
            vm.expectRevert(
                abi.encodeWithSelector(Deploy.NotRobinhoodChain.selector, others[index])
            );
            // forge-lint: disable-next-line(unused-return)
            script.checkedRewardAmount(others[index], admin, address(spy), 6);
        }
    }

    function test_RefusesDecimalsThatAreNotTheToken() public {
        vm.expectRevert(abi.encodeWithSelector(Deploy.DecimalsMismatch.selector, uint8(6), 18));
        // forge-lint: disable-next-line(unused-return)
        script.checkedRewardAmount(46630, admin, address(spy), 18);
    }

    function test_RefusesAnAddressWithNoTokenBehindIt() public {
        address nobody = makeAddr("nobody");
        vm.expectRevert(abi.encodeWithSelector(Deploy.NotAToken.selector, nobody));
        // forge-lint: disable-next-line(unused-return)
        script.checkedRewardAmount(46630, admin, nobody, 6);

        // Code, but not a token.
        vm.expectRevert(abi.encodeWithSelector(Deploy.NotAToken.selector, address(script)));
        // forge-lint: disable-next-line(unused-return)
        script.checkedRewardAmount(46630, admin, address(script), 6);
    }

    function test_RefusesAZeroAdminOrToken() public {
        vm.expectRevert(abi.encodeWithSelector(Deploy.ZeroAddress.selector, "DEPLOY_ADMIN"));
        // forge-lint: disable-next-line(unused-return)
        script.checkedRewardAmount(46630, address(0), address(spy), 6);

        vm.expectRevert(abi.encodeWithSelector(Deploy.ZeroAddress.selector, "SPY_TOKEN_ADDRESS"));
        // forge-lint: disable-next-line(unused-return)
        script.checkedRewardAmount(46630, admin, address(0), 6);
    }

    function test_RefusesATokenThatCannotHoldTheReward() public {
        MockERC20 whole = new MockERC20("Stock Token", "SPY", 0);

        vm.expectRevert(abi.encodeWithSelector(Deploy.DecimalsCannotHoldReward.selector, 0));
        // forge-lint: disable-next-line(unused-return)
        script.checkedRewardAmount(46630, admin, address(whole), 0);
    }

    function test_GrantRolesGrantsOnlyTheRolesItIsGiven() public {
        // A script broadcasts as the key that runs it — in a test, the default
        // sender — so that key is the admin here, as it would be on testnet.
        Deploy.Deployment memory deployment = script.deploy(DEFAULT_SENDER, address(spy), 6);
        address publisher = makeAddr("publisher");
        address pauser = makeAddr("pauser");

        new GrantRoles()
            .grant(
                deployment.distributor, deployment.vault, publisher, address(0), pauser, address(0)
            );

        assertTrue(
            deployment.distributor
                .hasRole(deployment.distributor.DISTRIBUTION_PUBLISHER_ROLE(), publisher)
        );
        assertTrue(deployment.distributor.hasRole(deployment.distributor.PAUSER_ROLE(), pauser));
        assertTrue(deployment.vault.hasRole(deployment.vault.PAUSER_ROLE(), pauser));
        // Not given, so not granted — to anyone. Secret stays off without a reserver.
        assertFalse(deployment.vault.hasRole(deployment.vault.RESERVER_ROLE(), address(0)));
        assertFalse(
            deployment.distributor.hasRole(deployment.distributor.TREASURY_ROLE(), address(0))
        );
    }

    function test_GrantRolesIsRefusedToAnyoneButTheAdmin() public {
        Deploy.Deployment memory deployment = script.deploy(admin, address(spy), 6);
        GrantRoles grants = new GrantRoles();

        // The default sender broadcasts, and it is not the admin here.
        vm.expectRevert();
        grants.grant(
            deployment.distributor,
            deployment.vault,
            makeAddr("publisher"),
            address(0),
            address(0),
            address(0)
        );
    }
}
