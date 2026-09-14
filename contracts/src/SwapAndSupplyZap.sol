// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
}

interface IWETH is IERC20 {
    function deposit() external payable;
}

/// @title SwapAndSupplyZap
/// @notice Stateless helper for the "tail calls" of a sponsored Tornado withdrawal:
///         swap the withdrawn ETH on Uniswap V3 and supply the proceeds to Aave V3 on
///         behalf of the user, all inside the same userOp as the withdraw.
///
///         The ephemeral 4337 sender calls this with `value = denomination - fee`. Because
///         the swap output is only known at execution time, doing swap -> approve -> supply
///         in one contract call is what lets the user's tail calls stay amount-agnostic.
///         aTokens are minted straight to `onBehalfOf`; the zap never holds funds between
///         transactions.
contract SwapAndSupplyZap {
    using SafeERC20 for IERC20;

    IWETH public immutable WETH;
    ISwapRouter02 public immutable SWAP_ROUTER;
    IAavePool public immutable AAVE_POOL;

    event SwappedAndSupplied(
        address indexed onBehalfOf, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );
    event Supplied(address indexed onBehalfOf, uint256 amount);

    error ZeroValue();

    constructor(IWETH weth, ISwapRouter02 swapRouter, IAavePool aavePool) {
        WETH = weth;
        SWAP_ROUTER = swapRouter;
        AAVE_POOL = aavePool;
    }

    /// @notice Swap all `msg.value` of ETH into `tokenOut` and supply it to Aave for `onBehalfOf`.
    /// @param tokenOut  ERC-20 to receive and supply (must be an Aave reserve).
    /// @param poolFee   Uniswap V3 fee tier of the WETH/tokenOut pool.
    /// @param minOut    Slippage floor for the swap.
    /// @param onBehalfOf Address that receives the aTokens.
    function swapEthAndSupply(address tokenOut, uint24 poolFee, uint256 minOut, address onBehalfOf)
        external
        payable
        returns (uint256 amountOut)
    {
        if (msg.value == 0) revert ZeroValue();

        // SwapRouter02 wraps ETH itself when tokenIn == WETH and msg.value is supplied.
        amountOut = SWAP_ROUTER.exactInputSingle{value: msg.value}(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(WETH),
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: address(this),
                amountIn: msg.value,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(tokenOut).forceApprove(address(AAVE_POOL), amountOut);
        AAVE_POOL.supply(tokenOut, amountOut, onBehalfOf, 0);

        emit SwappedAndSupplied(onBehalfOf, tokenOut, msg.value, amountOut);
    }

    /// @notice Wrap all `msg.value` and supply WETH to Aave for `onBehalfOf` (no swap).
    function wrapEthAndSupply(address onBehalfOf) external payable {
        if (msg.value == 0) revert ZeroValue();
        WETH.deposit{value: msg.value}();
        IERC20(address(WETH)).forceApprove(address(AAVE_POOL), msg.value);
        AAVE_POOL.supply(address(WETH), msg.value, onBehalfOf, 0);
        emit Supplied(onBehalfOf, msg.value);
    }
}
