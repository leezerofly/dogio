require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const fetch = require('node-fetch');
const { getAddressTokenBalances, getSpecificTokenBalance, getLPTokenMaxSupply, calculateUserPoolDOGHoldings } = require('./balance-utils');

// DOG代币合约地址
const DOG_CONTRACT = '0x903358faf7c6304afbd560e9e29b12ab1b8fddc5';

// 池子地址（LP代币合约地址）
const POOL_ADDRESS = '0x41027D3CaCc14F35Abd387B7350c05247e9Ac646';

// OKX API配置
const OKX_CONFIG = {
    apiKey: process.env.OKX_API_KEY,
    apiSecret: process.env.OKX_API_SECRET,
    apiPassphrase: process.env.OKX_API_PASSPHRASE,
    chainIndex: '501' // XLayer链
};

// 检查API配置
if (!OKX_CONFIG.apiKey || !OKX_CONFIG.apiSecret || !OKX_CONFIG.apiPassphrase) {
    console.error('请在.env文件中配置OKX API凭证');
    process.exit(1);
}

// 加载用户数据
const users = require('./users.json');

// 创建OKX API签名
function createSignature(method, requestPath, body = '') {
    const timestamp = new Date().toISOString().slice(0, -5) + 'Z';
    const message = timestamp + method + requestPath + body;
    const hmac = crypto.createHmac('sha256', OKX_CONFIG.apiSecret);
    hmac.update(message);
    const signature = hmac.digest('base64');
    return { signature, timestamp };
}

// 获取地址的所有代币余额（包括DOG和LP代币）
async function getAddressBalances(address, retryCount = 0) {
    const maxRetries = 3;

    try {
        // 使用新的API接口获取所有代币余额
        const allBalances = await getAddressTokenBalances(address, 0); // 已经在balance-utils中有重试

        // 检查API调用是否失败（balance-utils返回null表示失败）
        if (allBalances === null) {
            if (retryCount < maxRetries) {
                console.warn(`⚠️ 地址 ${address} API调用失败，重试 (${retryCount + 1}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return getAddressBalances(address, retryCount + 1);
            } else {
                console.error(`❌ 地址 ${address} 获取代币余额失败，已达到最大重试次数`);
                return {
                    dogBalance: 0,
                    lpBalance: 0,
                    allBalances: [],
                    error: 'API调用失败'
                };
            }
        }

        // 检查是否成功获取到数据
        if (!allBalances || allBalances.length === 0) {
            console.warn(`⚠️ 地址 ${address} 未持有任何代币`);
            return {
                dogBalance: 0,
                lpBalance: 0,
                allBalances: [],
                tokenCount: 0
            };
        }

        // 提取DOG代币余额
        const dogBalance = getSpecificTokenBalance(allBalances, DOG_CONTRACT);

        // 提取LP代币余额
        const lpBalance = getSpecificTokenBalance(allBalances, POOL_ADDRESS);

        // 验证是否至少找到了DOG代币（作为成功获取数据的标志）
        if (dogBalance.balance === 0 && allBalances.length > 0) {
            console.warn(`⚠️ 地址 ${address} 未找到DOG代币，可能数据不完整`);
        }

        return {
            dogBalance: dogBalance.balance,
            lpBalance: lpBalance.balance,
            allBalances: allBalances,
            tokenCount: allBalances.length
        };

    } catch (error) {
        console.error(`❌ 获取地址 ${address} 余额失败 (重试 ${retryCount}/${maxRetries}):`, error.message);

        if (retryCount < maxRetries) {
            console.log(`⏳ 等待2秒后重试...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return getAddressBalances(address, retryCount + 1);
        }

        return {
            dogBalance: 0,
            lpBalance: 0,
            allBalances: [],
            error: error.message
        };
    }
}

// 获取池子基本信息（一次性获取，避免重复请求）
let poolInfo = null;
async function getPoolInfo() {
    if (poolInfo) return poolInfo;

    console.log('正在获取池子基本信息...');

    // 获取LP代币总供应量
    const lpTokenInfo = await getLPTokenMaxSupply(POOL_ADDRESS);
    if (!lpTokenInfo || lpTokenInfo.maxSupply === 0) {
        console.error('无法获取LP代币总供应量');
        return null;
    }

    // 获取池子DOG储备量
    const poolBalances = await getAddressBalances(POOL_ADDRESS);
    const poolDOGReserve = poolBalances.dogBalance;

    poolInfo = {
        lpTokenInfo: lpTokenInfo,
        poolDOGReserve: poolDOGReserve
    };

    console.log(`LP代币总供应量: ${lpTokenInfo.maxSupply.toLocaleString()} ${lpTokenInfo.symbol}`);
    console.log(`池子DOG储备量: ${poolDOGReserve.toLocaleString()} DOG`);

    return poolInfo;
}

// 更新所有余额数据
async function updateAllBalances() {
    console.log('开始更新所有余额数据...');
    const startTime = Date.now();

    // 先获取池子信息
    const poolData = await getPoolInfo();
    if (!poolData) {
        console.error('无法获取池子信息，退出');
        return null;
    }

    const updatedUsers = [];
    let totalPoolDOGHoldings = 0;
    let usersWithPoolHoldings = 0;

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        let totalDOGBalance = 0;
        let totalLPBalance = 0;
        let userPoolDOGHoldings = 0;
        const addressBalances = [];
        const addressLPBalances = [];

        // 为每个用户的公开地址获取余额（用于显示和统计）
        for (let j = 0; j < (user.addresses || []).length; j++) {
            const address = user.addresses[j];
            console.log(`正在获取 ${user.nickname} (${address.slice(0, 6)}...${address.slice(-4)}) 的余额...`);

            const balanceData = await getAddressBalances(address);
            const dogBalance = balanceData.dogBalance || 0;
            const lpBalance = balanceData.lpBalance || 0;

            totalDOGBalance += dogBalance;
            totalLPBalance += lpBalance;
            addressBalances.push(dogBalance);
            addressLPBalances.push(lpBalance);

            // 计算该地址在池子中的DOG持有量
            if (lpBalance > 0) {
                const addressPoolHoldings = (lpBalance / poolData.lpTokenInfo.maxSupply) * poolData.poolDOGReserve;
                userPoolDOGHoldings += addressPoolHoldings;
            }

            // 请求结束后等待1秒再开始下一个请求
            if (j < user.addresses.length - 1 || i < users.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // 为私有地址获取余额（只用于池子统计，不计入显示余额）
        for (let j = 0; j < (user.privateAddresses || []).length; j++) {
            const address = user.privateAddresses[j];
            console.log(`正在获取 ${user.nickname} 私有地址 (${address.slice(0, 6)}...${address.slice(-4)}) 的余额...`);

            const balanceData = await getAddressBalances(address);
            const dogBalance = balanceData.dogBalance || 0;
            const lpBalance = balanceData.lpBalance || 0;

            // 私有地址的DOG余额不计入显示总和，只用于池子计算
            // totalDOGBalance += dogBalance;  // 注释掉，不计入显示总和
            totalLPBalance += lpBalance;

            // 计算该地址在池子中的DOG持有量
            if (lpBalance > 0) {
                const addressPoolHoldings = (lpBalance / poolData.lpTokenInfo.maxSupply) * poolData.poolDOGReserve;
                userPoolDOGHoldings += addressPoolHoldings;
            }

            // 请求结束后等待1秒再开始下一个请求（除了最后一个私有地址）
            if (j < user.privateAddresses.length - 1 || i < users.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // 更新用户数据
        const updatedUser = {
            ...user,
            currentBalances: addressBalances,
            totalBalance: totalDOGBalance,
            percentage: user.initialBalanceTotal > 0 ? ((totalDOGBalance + userPoolDOGHoldings - user.initialBalanceTotal) / user.initialBalanceTotal) * 100 : 0,
            // 新增池子持有量相关字段
            lpBalances: addressLPBalances,
            totalLPBalance: totalLPBalance,
            poolDOGHoldings: userPoolDOGHoldings
        };

        updatedUsers.push(updatedUser);

        if (userPoolDOGHoldings > 0) {
            totalPoolDOGHoldings += userPoolDOGHoldings;
            usersWithPoolHoldings++;
        }

        const balanceText = totalDOGBalance > 0 ?
            `${totalDOGBalance.toLocaleString()}` :
            `0 (⚠️ 该地址当前无DOG余额)`;

        console.log(`${user.nickname} DOG余额: ${balanceText}, 池子持有量: ${userPoolDOGHoldings.toFixed(6)}, 百分比: ${updatedUser.percentage.toFixed(2)}%`);

        // 如果初始余额很大但当前余额为0，给出警告
        if (user.initialBalanceTotal > 100000 && totalDOGBalance === 0 && userPoolDOGHoldings === 0) {
            console.log(`   💡 注意: ${user.nickname} 初始持有 ${user.initialBalanceTotal.toLocaleString()} DOG，但当前余额为0，可能已转移到其他地址`);
        }
    }

    const lastUpdateTime = new Date().toISOString();
    const totalAddresses = updatedUsers.reduce((sum, user) => sum + ((user.addresses || []).length + (user.privateAddresses || []).length), 0);

    // 计算未分配的DOG量
    const unallocatedDOG = poolData.poolDOGReserve - totalPoolDOGHoldings;

    // 生成输出数据
    const outputData = {
        success: true,
        data: {
            users: updatedUsers,
            lastUpdate: lastUpdateTime,
            totalUsers: updatedUsers.length,
            totalAddresses: totalAddresses,
            // 新增池子持有量统计
            poolStats: {
                poolAddress: POOL_ADDRESS,
                poolDOGReserve: poolData.poolDOGReserve,
                lpTokenSupply: poolData.lpTokenInfo.maxSupply,
                lpTokenSymbol: poolData.lpTokenInfo.symbol,
                totalPoolDOGHoldings: totalPoolDOGHoldings,
                usersWithPoolHoldings: usersWithPoolHoldings,
                unallocatedDOG: unallocatedDOG,
                unallocatedPercent: poolData.poolDOGReserve > 0 ? (unallocatedDOG / poolData.poolDOGReserve) * 100 : 0
            }
        }
    };

    // 保存到文件
    const outputFile = path.join(__dirname, 'balance-data.json');
    fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2), 'utf8');
    console.log(`\n✅ 数据已保存到: ${outputFile}`);

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n=== 池子持有量统计 ===`);
    console.log(`池子DOG储备量: ${poolData.poolDOGReserve.toLocaleString()} DOG`);
    console.log(`LP代币总供应量: ${poolData.lpTokenInfo.maxSupply.toLocaleString()} ${poolData.lpTokenInfo.symbol}`);
    console.log(`用户池子DOG持有总量: ${totalPoolDOGHoldings.toFixed(6)} DOG`);
    console.log(`持有LP代币的用户数: ${usersWithPoolHoldings} 个`);
    console.log(`未分配DOG量: ${unallocatedDOG.toFixed(6)} DOG (${outputData.data.poolStats.unallocatedPercent.toFixed(2)}%)`);

    console.log(`\n余额数据更新完成，耗时 ${duration} 秒，共处理 ${updatedUsers.length} 个用户，${totalAddresses} 个地址`);

    return outputFile;
}

// 主函数
async function main() {
    try {
        // 更新余额数据
        const outputFile = await updateAllBalances();
        
    } catch (error) {
        console.error('❌ 执行失败:', error);
        process.exit(1);
    }
}

// 如果直接运行此脚本
if (require.main === module) {
    main();
}

module.exports = { updateAllBalances };

