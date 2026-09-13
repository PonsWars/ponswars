// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {RewardsDistributor} from "../src/RewardsDistributor.sol";
import {SecretStockVault} from "../src/SecretStockVault.sol";

/// @title GrantRoles
/// @notice Grants the operational roles on both contracts (masterplan §20).
///
/// @dev Sent by the admin, since only `DEFAULT_ADMIN_ROLE` may grant. On testnet
/// the admin can be a key and this script sends the grants directly:
///
///     REWARDS_DISTRIBUTOR_ADDRESS=0x…  SECRET_STOCK_VAULT_ADDRESS=0x… \
///     DISTRIBUTION_PUBLISHER=0x…  SECRET_RESERVER=0x…  PAUSER=0x…  TREASURY=0x… \
///     forge script contracts/script/GrantRoles.s.sol \
///       --rpc-url robinhood_testnet --broadcast --account <admin keystore>
///
/// In production the admin is a multisig (§20), which a script cannot sign
/// for; the same grants are proposed there as `grantRole(role, account)` calls.
///
/// Each role is optional: an unset or zero address grants nothing, so a role
/// nobody has decided on stays with nobody rather than with a placeholder. The
/// reserver in particular is what turns Secret results on, and should be
/// granted only once the Genesis service holds that key.
contract GrantRoles is Script {
    function run() external {
        grant(
            RewardsDistributor(vm.envAddress("REWARDS_DISTRIBUTOR_ADDRESS")),
            SecretStockVault(vm.envAddress("SECRET_STOCK_VAULT_ADDRESS")),
            vm.envOr("DISTRIBUTION_PUBLISHER", address(0)),
            vm.envOr("SECRET_RESERVER", address(0)),
            vm.envOr("PAUSER", address(0)),
            vm.envOr("TREASURY", address(0))
        );
    }

    /// @notice The grants, with their inputs as arguments rather than the
    /// process-wide environment.
    function grant(
        RewardsDistributor distributor,
        SecretStockVault vault,
        address publisher,
        address reserver,
        address pauser,
        address treasury
    ) public {
        vm.startBroadcast();
        if (publisher != address(0)) {
            distributor.grantRole(distributor.DISTRIBUTION_PUBLISHER_ROLE(), publisher);
        }
        if (reserver != address(0)) {
            vault.grantRole(vault.RESERVER_ROLE(), reserver);
        }
        if (pauser != address(0)) {
            distributor.grantRole(distributor.PAUSER_ROLE(), pauser);
            vault.grantRole(vault.PAUSER_ROLE(), pauser);
        }
        if (treasury != address(0)) {
            distributor.grantRole(distributor.TREASURY_ROLE(), treasury);
            vault.grantRole(vault.TREASURY_ROLE(), treasury);
        }
        vm.stopBroadcast();
    }
}
