// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal ERC-20 stand-in for SPY in tests.
/// @dev Decimals are a constructor argument, not the default 18. SPY decimals
/// are OPEN (`docs/OPEN_PARAMETERS.md`) and nothing in this codebase may assume
/// 18 — the tests exercise 6 as well, so a hidden assumption would fail here.
contract MockERC20 is ERC20 {
    uint8 private immutable _DECIMALS;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _DECIMALS = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _DECIMALS;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
