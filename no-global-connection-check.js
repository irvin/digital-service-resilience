/*
    1) checkWebsiteResilience('https://24h.pchome.com.tw/prod/DCAYAD-A900BIAMV')
        .then(result => console.log('檢測完成'))
        .catch(error => console.error('檢測失敗:', error));

    2) node no-global-connection-check.js https://24h.pchome.com.tw/prod/DCAYAD-A900BIAMV
*/

const { chromium } = require('playwright');
const axios = require('axios');
// const { IPinfoWrapper } = require('node-ipinfo');
const dns = require('dns').promises;
const { Resolver } = require('dns').promises;

// 建立 ipinfo client
// const ipinfo = new IPinfoWrapper(process.env.IPINFO_TOKEN || undefined);

// 可忽略的域名列表
const IGNORABLE_DOMAINS = [
    'analytics.google.com',
    'www.google-analytics.com',
    'connect.facebook.net',
    'fonts.gstatic.com',
    'www.facebook.com',
    'www.youtube.com',
    'doubleclick.net',
    'www.google.com.tw/ads',
    'jscdn.appier.net'
];

// 台灣 ASN 列表 - 暫時不使用
/* const TAIWAN_ASN = [
    'AS4780', // 中華電信
    'AS3462', // 中華電信
    'AS9924', // 台灣固網
    'AS4782', // 中華電信國際
    'AS18182' // 中華電信數據
]; */

// 已知有台灣節點的雲端服務
const CLOUD_PROVIDERS = [
    'GOOGLE',
    'AMAZON',
    'MICROSOFT',
    'CLOUDFLARE',
    'AKAMAI'
];

async function collectHAR(url) {
    const browser = await chromium.launch();
    const context = await browser.newContext({
        bypassCSP: true,
        ignoreHTTPSErrors: true
    });
    
    const page = await context.newPage();
    
    // 開始收集 HAR
    await context.tracing.start({ snapshots: true, screenshots: true });
    
    // 訪問頁面
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    
    // 獲取 HAR 數據
    const requests = await page.evaluate(() => {
        return performance.getEntriesByType('resource').map(entry => ({
            url: entry.name,
            type: entry.initiatorType
        }));
    });
    
    await browser.close();
    return requests;
}

function cleanHARData(requests) {
    return requests.filter(request => {
        try {
            const url = new URL(request.url);
            return !IGNORABLE_DOMAINS.some(domain => url.hostname.includes(domain));
        } catch (e) {
            return false;
        }
    }).reduce((acc, current) => {
        const hostname = new URL(current.url).hostname;
        if (!acc[hostname]) {
            acc[hostname] = current;
        }
        return acc;
    }, {});
}

async function getDomainIP(domain, customDNS = null) {
    try {
        if (customDNS) {
            const resolver = new Resolver();
            resolver.setServers([customDNS]);
            return (await resolver.resolve4(domain))[0];
        }
        return (await dns.resolve4(domain))[0];
    } catch (error) {
        console.error(`無法解析域名 ${domain}:`, error.message);
        return null;
    }
}

/*
async function checkIPLocationWithSDK(domain) {
    try {
        const ip = await getDomainIP(domain);
        if (!ip) {
            throw new Error(`無法獲取 ${domain} 的 IP 地址`);
        }
        
        const response = await ipinfo.lookupIp(ip);
        return {
            source: 'sdk',
            domain,
            ip,
            ...response
        };
    } catch (error) {
        console.error(`[SDK] 檢查 ${domain} 失敗:`, error.message);
        return {
            source: 'sdk',
            domain,
            error: true,
            message: error.message
        };
    }
}
*/

async function checkIPLocationWithAPI(domain, customDNS = null) {
    try {
        const ip = await getDomainIP(domain, customDNS);
        if (!ip) {
            throw new Error(`無法獲取 ${domain} 的 IP 地址`);
        }

        const response = await axios.get(`https://ipinfo.io/${ip}/json`, {
            headers: {
                'Accept': 'application/json'
            }
        });

        return {
            source: 'json api',
            domain,
            ip,
            ...response.data
        };
    } catch (error) {
        console.error(`[API] 檢查 ${domain} 失敗:`, error.message);
        return {
            source: 'json api',
            domain,
            error: true,
            message: error.message
        };
    }
}

async function checkIPLocation(domain, customDNS = null) {
    const apiResult = await checkIPLocationWithAPI(domain, customDNS);    
    return apiResult;
}

function calculateResilience(ipInfoResults) {
    const scores = {
        domestic: 0,    // O: 台灣境內
        cloud: 0,       // -: 使用有台灣節點的雲端服務
        foreign: 0,     // X: 境外服務
        details: [],
        comparisons: [] // 新增比較結果
    };

    for (const result of ipInfoResults) {
        if (result.error) continue;

        let score;
        // if (result.country === 'TW' || TAIWAN_ASN.some(asn => result.org?.includes(asn))) {
        // 只使用 country 判斷是否為台灣境內服務
        if (result.country === 'TW') {
            score = 'O';
            scores.domestic++;
        } else if (CLOUD_PROVIDERS.some(provider => result.org?.toUpperCase().includes(provider))) {
            score = '-';
            scores.cloud++;
        } else {
            score = 'X';
            scores.foreign++;
        }

        scores.details.push({
            domain: result.domain,
            score,
            source: result.source,
            location: `${result.country} (${result.org || 'Unknown'})`
        });
    }

    return scores;
}

async function checkWebsiteResilience(url, options = {}) {
    try {
        console.log(`開始檢測網站: ${url}`);
        if (options.customDNS) {
            console.log('使用自訂 DNS 伺服器:', options.customDNS);
        } else {
            console.log('使用本機 DNS 伺服器:', dns.getServers());
        }

        // 1. 收集 HAR
        const requests = await collectHAR(url);
        console.log(`收集到 ${requests.length} 個請求`);

        // 2. 清理資料
        const cleanedData = cleanHARData(requests);
        const domains = Object.values(cleanedData).map(req => new URL(req.url).hostname);
        console.log(`清理後剩餘 ${domains.length} 個唯一域名`);

        // 3. 檢查每個域名
        const locationResults = await Promise.all(
            domains.map(domain => checkIPLocation(domain, options.customDNS))
        );

        // 4. 計算韌性分數
        const resilience = calculateResilience(locationResults);

        // 5. 產生報告
        console.log('\n檢測結果:');
        console.log('-------------------');
        console.log(`境內服務 (O): ${resilience.domestic}`);
        console.log(`雲端服務 (-): ${resilience.cloud}`);
        console.log(`境外服務 (X): ${resilience.foreign}`);
        
        console.log('\n詳細資訊:');
        console.log('-------------------');
        locationResults.forEach(result => {
            console.log(`\n${result.domain}:`);
            console.log(result);
        });

        return resilience;
    } catch (error) {
        console.error('檢測過程發生錯誤:', error);
        throw error;
    }
}

// 如果直接執行此檔案（不是被 require）
if (require.main === module) {
    const args = process.argv.slice(2);
    let url = args[args.length - 1];
    let customDNS = null;

    // 解析命令列參數
    const dnsIndex = args.indexOf('--dns');
    if (dnsIndex !== -1 && args[dnsIndex + 1]) {
        customDNS = args[dnsIndex + 1];
    }

    if (!url || url.startsWith('--')) {
        console.error('請提供要檢測的網址');
        console.error('  npm run check [--dns 8.8.8.8] https://example.com');
        console.error('  node no-global-connection-check.js [--dns 8.8.8.8] https://example.com');
        process.exit(1);
    }

    // 執行檢測
    checkWebsiteResilience(url, { customDNS })
        .then(result => {
            console.log('檢測完成');
        })
        .catch(error => {
            console.error('檢測失敗:', error);
            process.exit(1);
        });
}

module.exports = {
    checkWebsiteResilience
}; 