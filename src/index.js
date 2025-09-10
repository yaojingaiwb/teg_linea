import 'dotenv/config';
import { ethers } from 'ethers';

const CLAIM_CONTRACT = '0x87bAa1694381aE3eCaE2660d97fe60404080Eb64';
const CLAIM_ABI = [{ inputs: [], name: 'claim', outputs: [], stateMutability: 'nonpayable', type: 'function' }];

const TOKEN_CONTRACT = '0x1789e0043623282D5DCc7F213d703C6D8BAfBB04';
const TOKEN_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)'
];

const RECEIVER = '0x94f9ae4c07d32d0ad9f21f8f20f4551523e77169';

const REQUIRED_ENVS = ['RPC_URL', 'PRIVATE_KEY'];

function assertEnv() {
    const missing = REQUIRED_ENVS.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
    if (missing.length > 0) {
        throw new Error(`缺少环境变量: ${missing.join(', ')}。请在 .env 中配置`);
    }
}

function validateAndNormalizeAddress(address, label) {
    if (!ethers.isAddress(address)) {
        throw new Error(`${label} 地址无效: ${address}`);
    }
    const checksum = ethers.getAddress(address);
    if (checksum !== address) {
        console.log(`${label} 地址已标准化为校验和格式:`, checksum);
    }
    return checksum;
}

async function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithDynamicGas(txFunc, description) {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const feeData = await provider.getFeeData();

    const overrides = {};
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        const adjMaxFee = (feeData.maxFeePerGas * 120n) / 100n;
        const adjMaxPriority = (feeData.maxPriorityFeePerGas * 120n) / 100n;
        overrides.maxFeePerGas = adjMaxFee;
        overrides.maxPriorityFeePerGas = adjMaxPriority;
    } else if (feeData.gasPrice) {
        const adjGasPrice = (feeData.gasPrice * 120n) / 100n;
        overrides.gasPrice = adjGasPrice;
    }

    const tx = await txFunc(overrides);
    console.log(`${description} 发送交易:`, tx.hash);
    const receipt = await tx.wait();
    console.log(`${description} 确认:`, receipt.transactionHash, 'status:', receipt.status);
    if (receipt.status !== 1) throw new Error(`${description} 失败`);
    return receipt;
}

async function claimTokens(signer) {
    const claim = new ethers.Contract(CLAIM_CONTRACT, CLAIM_ABI, signer);
    return sendWithDynamicGas((ov) => claim.claim(ov), '领取claim');
}

async function getTokenBalance(provider, owner, tokenAddress) {
    const erc20 = new ethers.Contract(tokenAddress, TOKEN_ABI, provider);
    return erc20.balanceOf(owner);
}

async function transferAllToken(signer, to, tokenAddress) {
    const erc20 = new ethers.Contract(tokenAddress, TOKEN_ABI, signer);
    const [decimals, symbol] = await Promise.all([erc20.decimals(), erc20.symbol()]);
    const owner = await signer.getAddress();
    const bal = await erc20.balanceOf(owner);
    if (bal === 0n) {
        console.log(`无${symbol}可转移`);
        return null;
    }
    console.log(`准备转移 ${symbol} 数量:`, ethers.formatUnits(bal, decimals));
    return sendWithDynamicGas((ov) => erc20.transfer(to, bal, ov), `转移${symbol}`);
}

async function transferAllNativeMinusGas(signer, to) {
    const provider = signer.provider;
    const address = await signer.getAddress();
    const [balance, feeData] = await Promise.all([
        provider.getBalance(address),
        provider.getFeeData(),
    ]);

    if (balance === 0n) {
        console.log('无原生币可转移');
        return null;
    }

    let gasLimit;
    try {
        gasLimit = await provider.estimateGas({ to, from: address, value: 1n });
    } catch {
        gasLimit = 21000n;
    }

    let fee;
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        // 以太坊 EIP-1559 模式，使用 maxFeePerGas 估算上限
        const adjMaxFee = (feeData.maxFeePerGas * 120n) / 100n;
        fee = gasLimit * adjMaxFee;
    } else if (feeData.gasPrice) {
        const adjGasPrice = (feeData.gasPrice * 120n) / 100n;
        fee = gasLimit * adjGasPrice;
    } else {
        throw new Error('无法获取gas价格');
    }

    if (balance <= fee) {
        console.log('原生币余额不足以支付gas');
        return null;
    }

    const value = balance - fee;
    const txReq = { to, value };
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        const adjMaxFee = (feeData.maxFeePerGas * 120n) / 100n;
        const adjMaxPriority = (feeData.maxPriorityFeePerGas * 120n) / 100n;
        txReq.maxFeePerGas = adjMaxFee;
        txReq.maxPriorityFeePerGas = adjMaxPriority;
        txReq.type = 2;
    } else if (feeData.gasPrice) {
        const adjGasPrice = (feeData.gasPrice * 120n) / 100n;
        txReq.gasPrice = adjGasPrice;
    }

    const tx = await signer.sendTransaction(txReq);
    console.log('转移原生币 发送交易:', tx.hash);
    const receipt = await tx.wait();
    console.log('转移原生币 确认:', receipt.transactionHash, 'status:', receipt.status);
    if (receipt.status !== 1) throw new Error('转移原生币失败');
    return receipt;
}

async function main() {
    assertEnv();
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const address = await wallet.getAddress();

    console.log('使用地址:', address);
    console.log('开始循环监控与领取...');

    // 校验合约地址
    const claimAddr = validateAndNormalizeAddress(CLAIM_CONTRACT, 'CLAIM合约');
    const tokenAddr = validateAndNormalizeAddress(TOKEN_CONTRACT, '代币合约');
    // 这里仅校验地址有效性；后续仍使用常量，不影响合约调用
    console.log('CLAIM合约:', claimAddr, '代币合约:', tokenAddr);

    // 第一阶段：不断尝试 claim，成功则退出循环
    while (true) {
        try {
            await claimTokens(wallet);
            console.log('claim 成功，退出claim循环');
            break;
        } catch (e) {
            console.log('claim 当前不可用或失败，等待5秒后继续...');
            await wait(5000);
        }

        // 在未成功claim之前，若已存在代币余额，也执行转移
        try {
            const tokenBal = await getTokenBalance(provider, address, TOKEN_CONTRACT);
            if (tokenBal && tokenBal > 0n) {
                console.log('检测到代币余额 > 0，开始转移，余额:', tokenBal.toString());
                await transferAllToken(wallet, RECEIVER, TOKEN_CONTRACT);
                await transferAllNativeMinusGas(wallet, RECEIVER);
                console.log('已转移现有余额，继续尝试claim...');
            }
        } catch (err) {
            console.error('检查或转移现有余额时出错，忽略继续：', err);
        }
    }

    // 第二阶段：claim 已成功，仅监控到账并转移一次后结束
    console.log('进入到账监控阶段（已成功claim）...');
    while (true) {
        try {
            const tokenBal = await getTokenBalance(provider, address, TOKEN_CONTRACT);
            if (tokenBal && tokenBal > 0n) {
                console.log('到账检测到代币余额 > 0，开始转移，余额:', tokenBal.toString());
                await transferAllToken(wallet, RECEIVER, TOKEN_CONTRACT);
                await transferAllNativeMinusGas(wallet, RECEIVER);
                console.log('到账后的代币与原生币转移完成，脚本结束。');
                break;
            }
        } catch (err) {
            console.error('到账检测或转移时出错，忽略继续：', err);
        }
    }
}

main().catch((err) => {
    console.error('执行出错:', err);
    process.exit(1);
});


