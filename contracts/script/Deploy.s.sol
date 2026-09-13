// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {RewardsDistributor} from "../src/RewardsDistributor.sol";
import {SecretStockVault} from "../src/SecretStockVault.sol";

/// @title Deploy
/// @notice Deploys the two V1 contracts to Robinhood Chain (masterplan §19, §20).
///
/// @dev Run with the environment below, from the repository root:
///
///     DEPLOY_ADMIN=0x…  SPY_TOKEN_ADDRESS=0x…  SPY_TOKEN_DECIMALS=18 \
///     forge script contracts/script/Deploy.s.sol \
///       --rpc-url robinhood_testnet --broadcast --account <keystore>
///
/// What it refuses, before anything is sent:
///
/// - **Any chain but Robinhood Chain.** PonsWars runs on Robinhood Chain
///   mainnet (4663) or testnet (46630); a deployment anywhere else is a
///   mistake, and one that costs real gas to discover.
/// - **A SPY address with no token behind it, or other decimals.** The Secret
///   reward is `0.2 SPY` fixed at construction in base units (§8.1); a wrong
///   decimals value would bake a reward a power of ten off into an immutable.
/// - **A zero admin.** Both contracts give `DEFAULT_ADMIN_ROLE` to `DEPLOY_ADMIN`
///   and nothing else. The deploying key receives no role at all, so a
///   throwaway deployer holds no power once the transactions land. §20 expects
///   the admin to be a multisig; the operational roles are granted by it
///   afterwards (`GrantRoles.s.sol`).
///
/// A broadcast writes `contracts/deployments/<chainId>.json`, the addresses a
/// deployment's `REWARDS_DISTRIBUTOR_ADDRESS` and `SECRET_STOCK_VAULT_ADDRESS`
/// are set from.
contract Deploy is Script {
    uint256 internal constant ROBINHOOD_CHAIN_MAINNET = 4663;
    uint256 internal constant ROBINHOOD_CHAIN_TESTNET = 46630;

    error NotRobinhoodChain(uint256 chainId);
    error ZeroAddress(string parameter);
    error NotAToken(address token);
    error DecimalsMismatch(uint8 onChain, uint256 configured);
    error DecimalsCannotHoldReward(uint256 decimals);

    struct Deployment {
        RewardsDistributor distributor;
        SecretStockVault vault;
        uint256 secretRewardAmount;
    }

    function run() external returns (Deployment memory) {
        return deploy(
            vm.envAddress("DEPLOY_ADMIN"),
            vm.envAddress("SPY_TOKEN_ADDRESS"),
            vm.envUint("SPY_TOKEN_DECIMALS")
        );
    }

    /// @notice The deployment itself, with its inputs as arguments rather than
    /// the environment — which is process-wide, and so not something parallel
    /// tests can each set.
    function deploy(address admin, address spy, uint256 decimals)
        public
        returns (Deployment memory deployment)
    {
        uint256 rewardAmount = checkedRewardAmount(block.chainid, admin, spy, decimals);

        vm.startBroadcast();
        deployment.distributor = new RewardsDistributor(IERC20(spy), admin);
        deployment.vault = new SecretStockVault(IERC20(spy), rewardAmount, admin);
        vm.stopBroadcast();
        deployment.secretRewardAmount = rewardAmount;

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            record(deployment, admin, spy);
        }
    }

    /// @notice Every check above, and the Secret reward in base units: 0.2 SPY.
    function checkedRewardAmount(uint256 chainId, address admin, address spy, uint256 decimals)
        public
        view
        returns (uint256)
    {
        if (chainId != ROBINHOOD_CHAIN_MAINNET && chainId != ROBINHOOD_CHAIN_TESTNET) {
            revert NotRobinhoodChain(chainId);
        }
        if (admin == address(0)) revert ZeroAddress("DEPLOY_ADMIN");
        if (spy == address(0)) revert ZeroAddress("SPY_TOKEN_ADDRESS");
        if (spy.code.length == 0) revert NotAToken(spy);

        try IERC20Metadata(spy).decimals() returns (uint8 onChain) {
            if (onChain != decimals) revert DecimalsMismatch(onChain, decimals);
        } catch {
            revert NotAToken(spy);
        }
        // 0.2 needs one decimal place. A token with none cannot represent it,
        // and rounding the fixed reward to zero or one whole token would not be
        // the reward §8.1 promises.
        if (decimals == 0) revert DecimalsCannotHoldReward(decimals);

        return 2 * 10 ** (decimals - 1);
    }

    function record(Deployment memory deployment, address admin, address spy) internal {
        string memory key = "deployment";
        // No block number: on Robinhood Chain, an Arbitrum chain, `block.number`
        // is an estimate of the Ethereum block, not the chain's own. The
        // broadcast log beside this has the real receipts.
        string memory json = vm.serializeUint(key, "chainId", block.chainid);
        json = vm.serializeAddress(key, "admin", admin);
        json = vm.serializeAddress(key, "spyToken", spy);
        json = vm.serializeUint(key, "secretRewardAmount", deployment.secretRewardAmount);
        json = vm.serializeAddress(key, "secretStockVault", address(deployment.vault));
        json = vm.serializeAddress(key, "rewardsDistributor", address(deployment.distributor));
        vm.writeJson(
            json, string.concat("contracts/deployments/", vm.toString(block.chainid), ".json")
        );
    }
}
