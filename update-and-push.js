require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const fetch = require('node-fetch');

// DOG代币合约地址
const DOG_CONTRACT = '0x903358faf7c6304afbd560e9e29b12ab1b8fddc5';

// OKX API配置
const OKX_CONFIG = {
    apiKey: process.env.OKX_API_KEY,
    apiSecret: process.env.OKX_API_SECRET,
    apiPassphrase: process.env.OKX_API_PASSPHRASE,
    chainIndex: '196'
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

// 获取单个地址的余额
async function getTokenBalance(address, tokenContractAddress, retryCount = 0) {
    const maxRetries = 3;
    const requestBody = {
        address: address,
        tokenContractAddresses: [{
            chainIndex: OKX_CONFIG.chainIndex,
            tokenContractAddress: tokenContractAddress
        }]
    };

    try {
        const { signature, timestamp } = createSignature('POST', '/api/v6/dex/balance/token-balances-by-address', JSON.stringify(requestBody));

        const response = await fetch('https://web3.okx.com/api/v6/dex/balance/token-balances-by-address', {
            method: 'POST',
            headers: {
                'OK-ACCESS-KEY': OKX_CONFIG.apiKey,
                'OK-ACCESS-SIGN': signature,
                'OK-ACCESS-TIMESTAMP': timestamp,
                'OK-ACCESS-PASSPHRASE': OKX_CONFIG.apiPassphrase,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const result = await response.json();

        if (result.code !== '0') {
            throw new Error(`OKX API错误: ${result.msg || '未知错误'}`);
        }

        if (result.data && result.data.length > 0 && result.data[0].tokenAssets && result.data[0].tokenAssets.length > 0) {
            const tokenAsset = result.data[0].tokenAssets[0];
            return {
                balance: parseFloat(tokenAsset.balance),
                rawBalance: tokenAsset.rawBalance || '0',
                symbol: tokenAsset.symbol || 'DOG'
            };
        }

        return { balance: 0, rawBalance: '0', symbol: 'DOG' };

    } catch (error) {
        console.error(`获取地址 ${address} 余额失败 (重试 ${retryCount}/${maxRetries}):`, error.message);

        if (retryCount < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            return getTokenBalance(address, tokenContractAddress, retryCount + 1);
        }

        return { balance: 0, rawBalance: '0', symbol: 'DOG', error: error.message };
    }
}

// 更新所有余额数据
async function updateAllBalances() {
    console.log('开始更新所有余额数据...');
    const startTime = Date.now();

    const updatedUsers = [];

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        let totalBalance = 0;
        const addressBalances = [];

        // 为每个用户的每个地址获取余额
        for (let j = 0; j < user.addresses.length; j++) {
            const address = user.addresses[j];
            console.log(`正在获取 ${user.nickname} (${address.slice(0, 6)}...${address.slice(-4)}) 的余额...`);

            const balanceData = await getTokenBalance(address, DOG_CONTRACT);
            const balance = balanceData.balance || 0;
            totalBalance += balance;
            addressBalances.push(balance);

            // 每个地址请求之间等待500ms
            if (j < user.addresses.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        // 更新用户数据
        const updatedUser = {
            ...user,
            currentBalances: addressBalances,
            totalBalance: totalBalance,
            percentage: user.initialBalanceTotal > 0 ? ((totalBalance - user.initialBalanceTotal) / user.initialBalanceTotal) * 100 : 0
        };

        updatedUsers.push(updatedUser);
        console.log(`${user.nickname} 总余额: ${totalBalance.toLocaleString()}, 百分比: ${updatedUser.percentage.toFixed(2)}%`);

        // 每个用户之间等待1秒
        if (i < users.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    const lastUpdateTime = new Date().toISOString();
    const totalAddresses = updatedUsers.reduce((sum, user) => sum + user.addresses.length, 0);

    // 生成输出数据
    const outputData = {
        success: true,
        data: {
            users: updatedUsers,
            lastUpdate: lastUpdateTime,
            totalUsers: updatedUsers.length,
            totalAddresses: totalAddresses
        }
    };

    // 保存到文件
    const outputFile = path.join(__dirname, 'balance-data.json');
    fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2), 'utf8');
    console.log(`\n✅ 数据已保存到: ${outputFile}`);

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`余额数据更新完成，耗时 ${duration} 秒，共处理 ${updatedUsers.length} 个用户，${totalAddresses} 个地址`);

    return outputFile;
}

// Git推送函数
function pushToGitHub(filePath) {
    // 如果在CI环境中（如GitHub Actions），不执行push，由CI流程处理
    if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
        console.log('📝 检测到CI环境，跳过Git推送（将由GitHub Actions处理）');
        return true;
    }

    try {
        console.log('\n开始推送到GitHub...');
        
        // 检查git是否初始化
        try {
            execSync('git status', { stdio: 'ignore', cwd: __dirname });
        } catch (error) {
            console.error('❌ 当前目录不是Git仓库，请先初始化Git仓库');
            console.log('💡 提示：如果使用GitHub Actions，可以跳过此步骤');
            return false;
        }

        // 检查是否有变更
        try {
            execSync(`git add "${filePath}"`, { cwd: __dirname, stdio: 'pipe' });
            const status = execSync('git status --porcelain', { cwd: __dirname, encoding: 'utf8' });
            
            if (!status.trim()) {
                console.log('📝 没有数据变更，跳过提交');
                return true;
            }
        } catch (error) {
            console.error('❌ Git操作失败:', error.message);
            return false;
        }
        
        // 提交
        const commitMessage = `更新余额数据 - ${new Date().toLocaleString('zh-CN')}`;
        execSync(`git commit -m "${commitMessage}"`, { cwd: __dirname, stdio: 'inherit' });
        
        // 推送到GitHub
        execSync('git push', { cwd: __dirname, stdio: 'inherit' });
        
        console.log('✅ 已成功推送到GitHub');
        return true;
    } catch (error) {
        console.error('❌ Git推送失败:', error.message);
        console.log('💡 提示：如果使用GitHub Actions，可以忽略此错误');
        return false;
    }
}

// 主函数
async function main() {
    try {
        // 更新余额数据
        const outputFile = await updateAllBalances();
        
        // 推送到GitHub
        pushToGitHub(outputFile);
        
    } catch (error) {
        console.error('❌ 执行失败:', error);
        process.exit(1);
    }
}

// 如果直接运行此脚本
if (require.main === module) {
    main();
}

module.exports = { updateAllBalances, pushToGitHub };

