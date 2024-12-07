// swapHandler.js

const { ethers } = require('ethers');
const dexAggregatorABI = require('./abi/abi.json');
const tokenABI = require('./abi/token.json');

const provider = new ethers.providers.JsonRpcProvider('https://andromeda.metis.io/?owner=1088');
const dexAggregatorAddress = '0xF9a6d89DCCb139E26da4b9DF00796C980b5975d2';
const NATIVE_METIS = '0x75cb093E4D61d2A2e65D8e0BBb01DE8d89b53481';
const trustedTokens = ["0x75cb093E4D61d2A2e65D8e0BBb01DE8d89b53481", "0x420000000000000000000000000000000000000A", "0xEA32A96608495e54156Ae48931A7c20f0dcc1a21", "0xbB06DCA3AE6887fAbF931640f67cab3e3a16F4dC"];
const maxSteps = 2;

function initializeWalletAndDexAggregator(privateKey) {
    const wallet = new ethers.Wallet(privateKey, provider);
    const dexAggregator = new ethers.Contract(dexAggregatorAddress, dexAggregatorABI, wallet);
    return { wallet, dexAggregator };
}

async function findBestRoute(amountIn, tokenIn, tokenOut, dexAggregator) {
    try {
        const bestPath = await dexAggregator.findBestPath(amountIn, tokenIn, tokenOut, trustedTokens, maxSteps);
        return bestPath;
    } catch (error) {
        // console.log(error);
    }
}

async function checkAndApproveToken(tokenAddress, amount, wallet) {
    const tokenContract = new ethers.Contract(tokenAddress, tokenABI, wallet);
    const allowance = await tokenContract.allowance(wallet.address, dexAggregatorAddress);
    
    if (allowance.lt(amount)) {
        const options = {
            gasLimit: ethers.utils.hexlify(100000),
            gasPrice: await provider.getGasPrice()
        };
        const approveTx = await tokenContract.approve(dexAggregatorAddress, amount, options);
        await approveTx.wait();
        return true;
    }
    return false;
}

async function executeSwap(amountIn, tokenIn, tokenOut, recipient, slippageTolerance, wallet, dexAggregator) {
    const balance = await provider.getBalance(wallet.address);
    const gasPrice = await provider.getGasPrice();

    if (tokenIn !== NATIVE_METIS) {
        await checkAndApproveToken(tokenIn, amountIn, wallet);
    }

    const bestPath = await findBestRoute(amountIn, tokenIn, tokenOut, dexAggregator);
    
    if (!bestPath || !bestPath[0] || !bestPath[0].length) {
        throw new Error('Invalid path returned from findBestRoute');
    }

    const [amounts, adapters, path, recipients] = bestPath;
    const lastAmount = amounts[amounts.length - 1];
    const slippageMultiplier = 1 - slippageTolerance;
    const amountOutMin = ethers.BigNumber.from(lastAmount)
        .mul(Math.floor(slippageMultiplier * 1000))
        .div(1000);

    const fee = 0;
    const toAddress = recipient;
    const options = {
        gasLimit: ethers.utils.hexlify(1000000),
        gasPrice: gasPrice
    };

    if (tokenIn === NATIVE_METIS) {
        options.value = amountIn;
    }

    let tx;
    if (tokenOut === NATIVE_METIS) {
        tx = await dexAggregator.swapNoSplitToETH({
            amountIn,
            amountOut: amountOutMin,
            path,
            adapters,
            recipients
        }, fee, toAddress, options);
    } else if (tokenIn === NATIVE_METIS) {
        tx = await dexAggregator.swapNoSplitFromETH({
            amountIn,
            amountOut: amountOutMin,
            path,
            adapters,
            recipients
        }, fee, toAddress, options);
    } else {
        tx = await dexAggregator.swapNoSplit({
            amountIn,
            amountOut: amountOutMin,
            path,
            adapters,
            recipients
        }, fee, toAddress, options);
    }

    return await tx.wait();
}

async function initializeAndExecute(privateKey, amountIn, tokenIn, tokenOut, recipient, slippageTolerance) {
    const { wallet, dexAggregator } = initializeWalletAndDexAggregator(privateKey);
    
    try {
        const receipt = await executeSwap(amountIn, tokenIn, tokenOut, recipient, slippageTolerance, wallet, dexAggregator);
        return receipt;
    } catch (error) {
        // console.error('Error executing swap:', error);
        throw error;
    }
}

module.exports = { initializeAndExecute };
