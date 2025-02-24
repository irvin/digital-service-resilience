/*
    1) checkWebsiteResilience('https://24h.pchome.com.tw/prod/DCAYAD-A900BIAMV')
        .then(result => console.log('檢測完成'))
        .catch(error => console.error('檢測失敗:', error));

    2) node no-global-connection-check.js https://24h.pchome.com.tw/prod/DCAYAD-A900BIAMV
*/

require('dotenv').config();
const { chromium } = require('playwright');
const axios = require('axios');
// const { IPinfoWrapper } = require('node-ipinfo');
const dns = require('dns').promises;
const { Resolver } = require('dns').promises;
const fs = require('fs').promises;
const path = require('path');

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

// 將網址轉換為對應的 JSON 檔名
function urlToFilename(url) {
    // 移除協議前綴（http:// 或 https://）
    const urlObj = new URL('https://' + url.replace(/^https?:\/\//, ''));
    let filename = `${urlObj.hostname}${urlObj.pathname.replace(/\//g, '_')}${
        urlObj.search ? '_' + urlObj.search.replace(/[?&=]/g, '_') : ''
    }`.replace(/_+$/, '');
    
    // 如果檔名太長，直接截斷到 95 字元
    if (filename.length > 95) {
        filename = filename.slice(0, 95);
    }
    
    return filename + '.json';
}

async function collectHARAndCanonical(url) {
    const browser = await chromium.launch({
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--window-size=1920,1080'
        ]
    });
    
    const context = await browser.newContext({
        bypassCSP: true,
        ignoreHTTPSErrors: true,
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        deviceScaleFactor: 1,
        hasTouch: false,
        locale: 'zh-TW',
        timezoneId: 'Asia/Taipei',
        permissions: ['geolocation'],
        geolocation: { latitude: 25.105497, longitude: 121.597366 },
    });
    
    const page = await context.newPage();
    
    try {
        // 設定額外的 headers
        await page.setExtraHTTPHeaders({
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"macOS"',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
        });

        // 開始收集 HAR
        await context.tracing.start({ snapshots: true, screenshots: true });
        
        // 訪問頁面
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        
        // 模擬人類行為
        await simulateHumanBehavior(page);
        
        // 嘗試獲取 canonical URL
        const canonical = await page.evaluate((originalURL) => {
            const canonicalLink = document.querySelector('link[rel="canonical"]');
            return canonicalLink ? canonicalLink.href : originalURL;
        }, url);
        
        // 獲取 connection 數據
        const requests = await page.evaluate(() => {
            return performance.getEntriesByType('resource').map(entry => ({
                url: entry.name,
                type: entry.initiatorType
            }));
        });
        
        return { requests, canonical };
    } finally {
        await browser.close();
    }
}

// 模擬人類行為的輔助函數
async function simulateHumanBehavior(page) {
    // 隨機延遲函數
    const randomDelay = () => new Promise(resolve => 
        setTimeout(resolve, Math.floor(Math.random() * 1000) + 500)
    );

    try {
        // 模擬滑鼠移動
        await page.mouse.move(
            Math.random() * 1000,
            Math.random() * 800,
            { steps: 10 }
        );
        await randomDelay();

        // 模擬滾動
        await page.evaluate(() => {
            window.scrollTo({
                top: Math.random() * document.body.scrollHeight,
                behavior: 'smooth'
            });
        });
        await randomDelay();

        // 模擬更多滑鼠移動
        for (let i = 0; i < 3; i++) {
            await page.mouse.move(
                Math.random() * 1000,
                Math.random() * 800,
                { steps: 5 }
            );
            await randomDelay();
        }
    } catch (error) {
        console.warn('模擬人類行為時發生錯誤:', error.message);
    }
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

async function checkIPLocationWithAPI(domain, options = {}) {
    try {
        const ip = await getDomainIP(domain, options.customDNS);
        if (!ip) {
            throw new Error(`無法獲取 ${domain} 的 IP 地址`);
        }

        // 優先使用命令列參數的 token，其次使用環境變數
        const token = options.token || process.env.IPINFO_TOKEN;
        const url = token 
            ? `https://ipinfo.io/${ip}/json?token=${token}`
            : `https://ipinfo.io/${ip}/json`;

        const response = await axios.get(url, {
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
    const apiResult = await checkIPLocationWithAPI(domain, { customDNS });    
    return apiResult;
}

function calculateResilience(ipInfoResults) {
    const scores = {
        domestic: 0,    // O: 台灣境內
        cloud: 0,       // ?: 使用有台灣節點的雲端服務
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
            score = '?';
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

async function getLocalIPInfo(options = {}) {
    try {
        // 優先使用命令列參數的 token，其次使用環境變數
        const token = options.token || process.env.IPINFO_TOKEN;
        const url = token 
            ? 'https://ipinfo.io/json?token=' + token
            : 'https://ipinfo.io/json';

        const response = await axios.get(url, {
            headers: {
                'Accept': 'application/json'
            }
        });
        return {
            ...response.data,
            source: 'json api'
        };
    } catch (error) {
        console.error('無法取得測試環境資訊:', error.message);
        return {
            error: true,
            message: error.message
        };
    }
}

function formatDomainDetail(result, cleanedData, resilience) {
    const originalRequest = Object.values(cleanedData).find(
        req => new URL(req.url).hostname === result.domain
    );
    
    return {
        originalUrl: originalRequest?.url,
        type: originalRequest?.type,
        ipinfo: {
            domain: result.domain,
            ip: result.ip,
            hostname: result.hostname,
            city: result.city,
            region: result.region,
            country: result.country,
            loc: result.loc,
            org: result.org,
            timezone: result.timezone
        },
        score: resilience.details.find(d => d.domain === result.domain)?.score
    };
}

// 共用的檢測邏輯
async function analyzeConnections(requests, options = {}) {
    // 使用環境變數中的 DNS（如果有指定的話）
    const envDNS = process.env.DEFAULT_DNS;
    const customDNS = options.customDNS || envDNS;

    // 取得測試環境資訊
    const localIPInfo = await getLocalIPInfo(options);
    if (!localIPInfo.error) {
        console.log('\n測試環境資訊:');
        console.log('-------------------');
        console.log(localIPInfo);
    }

    if (customDNS) {
        console.log('\n使用自訂 DNS 伺服器:', customDNS);
    } else {
        console.log('\n使用本機 DNS 伺服器:', dns.getServers());
    }

    // 2. 清理資料
    const cleanedData = cleanHARData(requests);
    const domains = Object.values(cleanedData).map(req => new URL(req.url).hostname);
    console.log(`清理後剩餘 ${domains.length} 個唯一域名`);

    // 3. 檢查每個域名
    const locationResults = await Promise.all(
        domains.map(domain => checkIPLocation(domain, customDNS))
    );

    // 4. 計算韌性分數
    const resilience = calculateResilience(locationResults);

    return {
        localIPInfo,
        cleanedData,
        domains,
        locationResults,
        resilience,
        customDNS
    };
}

// 準備結果資料
function prepareResult(analysis, metadata) {
    return {
        url: metadata.url,
        canonicalURL: metadata.canonicalURL,
        timestamp: new Date().toISOString(),
        testingEnvironment: {
            ip: analysis.localIPInfo.ip,
            ...analysis.localIPInfo,
            dnsServers: {
                type: analysis.customDNS ? 'custom' : 'system',
                servers: analysis.customDNS ? [analysis.customDNS] : dns.getServers()
            }
        },
        requestCount: metadata.requestCount,
        uniqueDomains: analysis.domains.length,
        test_results: {
            domestic: analysis.resilience.domestic,
            cloud_w_domestic_node: analysis.resilience.cloud,
            foreign: analysis.resilience.foreign
        },
        domainDetails: analysis.locationResults.map(result => 
            formatDomainDetail(result, analysis.cleanedData, analysis.resilience)
        )
    };
}

// 儲存結果到檔案
async function saveResult(result, options = {}) {
    if (!options.save) return;

    await fs.mkdir('test_results', { recursive: true });
    const outputPath = path.resolve(`test_results/${urlToFilename(result.url)}`);
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
    console.log(`\n結果已儲存至: ${outputPath}`);
}

// 處理檢測結果
async function processResult(analysis, metadata, options = {}) {
    // 準備結果資料
    const result = prepareResult(analysis, metadata);

    // 顯示結果摘要
    console.log('\n檢測結果:');
    console.log('-------------------');
    console.log(`境內服務 (O): ${result.test_results.domestic}`);
    console.log(`有國內節點的雲端服務 (?): ${result.test_results.cloud_w_domestic_node}`);
    console.log(`境外服務 (X): ${result.test_results.foreign}`);

    // 顯示詳細資訊
    console.log('\n詳細資訊:');
    console.log('-------------------');
    analysis.locationResults.forEach(result => {
        console.log(`\n${result.domain}:`);
        console.log(formatDomainDetail(result, analysis.cleanedData, analysis.resilience));
    });

    // 儲存結果
    await saveResult(result, options);
    return result;
}

// 從 HAR 檔案讀取請求資訊
async function checkWebsiteResilienceFromHAR(harFilePath, options = {}) {
    try {
        console.log(`開始從 HAR 檔案分析網站: ${harFilePath}`);
        
        const harContent = await fs.readFile(harFilePath, 'utf-8');
        const harData = JSON.parse(harContent);
        
        // 從 HAR 檔案提取測試環境資訊
        const testingEnvironment = {
            timestamp: harData.log.pages?.[0]?.startedDateTime,
            browser: harData.log.browser,
            creator: harData.log.creator,
            // 從第一個請求中取得 IP 資訊
            serverIP: harData.log.entries[0]?.serverIPAddress,
            // 如果有 _initiator 資訊也可以加入
            initiator: harData.log.entries[0]?._initiator
        };

        console.log('\n測試環境資訊 (從 HAR 檔案):');
        console.log('-------------------');
        console.log(testingEnvironment);
        
        const mainUrl = harData.log.pages?.[0]?.title || 
                       harData.log.entries[0]?.request.url;
        
        const requests = harData.log.entries.map(entry => ({
            url: entry.request.url,
            type: entry.request._resourceType || entry.response.content.mimeType
        }));

        console.log(`\n從 HAR 檔案中收集到 ${requests.length} 個請求`);

        const analysis = await analyzeConnections(requests, options);
        return processResult(analysis, {
            url: mainUrl,
            requestCount: requests.length,
            testingEnvironment  // 加入測試環境資訊
        }, options);
    } catch (error) {
        console.error('分析過程發生錯誤:', error);
        throw error;
    }
}

// 從網站直接收集資料
async function checkWebsiteResilience(url, options = {}) {
    try {
        const inputURL = url;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }

        console.log(`開始檢測網站: ${url}`);
        
        const { requests, canonical: canonicalURL } = await collectHARAndCanonical(url);
        
        if (canonicalURL !== url) {
            console.log(`檢測到 canonical URL: ${canonicalURL}`);
        }

        console.log(`收集到 ${requests.length} 個請求`);

        const analysis = await analyzeConnections(requests, options);
        return processResult(analysis, {
            url: inputURL,
            canonicalURL,
            requestCount: requests.length
        }, options);
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
    let save = false;
    let token = null;
    let harFile = null;

    // 解析命令列參數
    const dnsIndex = args.indexOf('--dns');
    if (dnsIndex !== -1 && args[dnsIndex + 1]) {
        customDNS = args[dnsIndex + 1];
    }

    const tokenIndex = args.indexOf('--ipinfo-token');
    if (tokenIndex !== -1 && args[tokenIndex + 1]) {
        token = args[tokenIndex + 1];
    }

    const harIndex = args.indexOf('--har');
    if (harIndex !== -1 && args[harIndex + 1]) {
        harFile = args[harIndex + 1];
        url = null;
    }

    save = args.includes('--save');

    // 檢查輸入參數的有效性
    if (harFile && !harFile.endsWith('.har')) {
        console.error('HAR 檔案必須是 .har 格式');
        process.exit(1);
    }
    
    if (!harFile && !url) {
        console.error('請提供要檢測的網址或 HAR 檔案');
        console.error('使用方式:');
        console.error('  npm run check [--dns 8.8.8.8] [--ipinfo-token your-token] [--save] https://example.com');
        console.error('  npm run check [--dns 8.8.8.8] [--save] --har path/to/file.har');
        process.exit(1);
    }

    // 執行檢測
    const options = { customDNS, token, save };
    const promise = harFile 
        ? checkWebsiteResilienceFromHAR(harFile, options)
        : checkWebsiteResilience(url, options);

    promise
        .then(() => console.log('檢測完成'))
        .catch(error => {
            console.error('檢測失敗:', error);
            process.exit(1);
        });
}

module.exports = {
    checkWebsiteResilience,
    checkWebsiteResilienceFromHAR
}; 