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
///         swap the withdrawn asset on Uniswap V3 and supply the proceeds to Aave V3 on
///         behalf of the user, all inside the same userOp as the withdraw.
///
///         The ephemeral 4337 sender calls this with the withdrawn amount (ETH as
///         `value`, tokens via an approval). Because the swap output is only known at
///         execution time, doing swap -> approve -> supply in one contract call is what
///         lets the user's tail calls stay amount-agnostic. aTokens are minted straight
///         to `onBehalfOf`; the zap never holds funds between transactions.
contract SwapAndSupplyZap {
    using SafeERC20 for IERC20;

    IWETH public immutable WETH;
    ISwapRouter02 public immutable SWAP_ROUTER;
    IAavePool public immutable AAVE_POOL;

    event SwappedAndSupplied(
        address indexed onBehalfOf, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );
    event Supplied(address indexed onBehalfOf, address indexed token, uint256 amount);

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

        _supply(tokenOut, amountOut, onBehalfOf);
        emit SwappedAndSupplied(onBehalfOf, address(WETH), tokenOut, msg.value, amountOut);
    }

    /// @notice Pull `amountIn` of `tokenIn` (caller must have approved this contract), swap it into
    ///         `tokenOut` and supply the proceeds to Aave for `onBehalfOf`.
    function swapTokenAndSupply(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint24 poolFee,
        uint256 minOut,
        address onBehalfOf
    ) external returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroValue();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(SWAP_ROUTER), amountIn);

        amountOut = SWAP_ROUTER.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        _supply(tokenOut, amountOut, onBehalfOf);
        emit SwappedAndSupplied(onBehalfOf, tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Wrap all `msg.value` and supply WETH to Aave for `onBehalfOf` (no swap).
    function wrapEthAndSupply(address onBehalfOf) external payable {
        if (msg.value == 0) revert ZeroValue();
        WETH.deposit{value: msg.value}();
        _supply(address(WETH), msg.value, onBehalfOf);
    }

    /// @notice Pull `amount` of `token` (caller must have approved this contract) and supply it to Aave.
    function supplyToken(address token, uint256 amount, address onBehalfOf) external {
        if (amount == 0) revert ZeroValue();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _supply(token, amount, onBehalfOf);
    }

    function _supply(address token, uint256 amount, address onBehalfOf) internal {
        IERC20(token).forceApprove(address(AAVE_POOL), amount);
        AAVE_POOL.supply(token, amount, onBehalfOf, 0);
        emit Supplied(onBehalfOf, token, amount);
    }
}
