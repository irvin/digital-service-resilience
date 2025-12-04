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

// 可忽略的域名列表（手動維護的）
const MANUAL_IGNORABLE_DOMAINS = [
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


// 動態載入的 adblock 清單域名（會在初始化時載入）
let ADBLOCK_DOMAINS = new Set();
let IGNORABLE_DOMAINS = [...MANUAL_IGNORABLE_DOMAINS];

/**
 * 解析 adblock 規則，提取域名
 * 支援格式：
 * - ||domain.com^
 * - ||domain.com^$third-party
 * - domain.com
 * - /ads/
 */
function parseAdblockRules(rulesText) {
    const domains = new Set();
    const lines = rulesText.split('\n');

    for (const line of lines) {
        // 跳過註解和空行
        if (!line.trim() || line.trim().startsWith('!') || line.trim().startsWith('[')) {
            continue;
        }

        // 解析 ||domain.com^ 格式
        const domainMatch = line.match(/^\|\|([^\/\^$]+)/);
        if (domainMatch) {
            const domain = domainMatch[1].trim();
            if (domain && !domain.includes('*') && !domain.includes(' ')) {
                domains.add(domain);
            }
            continue;
        }

        // 解析簡單的域名規則（不包含特殊符號）
        if (!line.includes('*') && !line.includes('/') && !line.includes('^') &&
            !line.includes('$') && !line.includes('|') && line.includes('.')) {
            const domain = line.trim();
            if (domain && domain.length > 3 && domain.length < 100) {
                domains.add(domain);
            }
        }
    }

    return domains;
}

/**
 * 從線上載入 adblock 清單
 * @param {Array<string>} listUrls - adblock 清單的 URL 陣列
 * @returns {Promise<Set<string>>} 解析後的域名集合
 */
async function loadAdblockLists(listUrls = []) {
    const defaultLists = [
        'https://easylist.to/easylist/easylist.txt',
        'https://easylist.to/easylist/easyprivacy.txt'
    ];

    const urls = listUrls.length > 0 ? listUrls : defaultLists;
    const allDomains = new Set();

    for (const url of urls) {
        try {
            console.log(`正在載入 adblock 清單: ${url}`);
            const response = await axios.get(url, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; AdblockListLoader/1.0)'
                }
            });

            const domains = parseAdblockRules(response.data);
            for (const domain of domains) {
                allDomains.add(domain);
            }
            console.log(`  已載入 ${domains.size} 個域名規則`);
        } catch (error) {
            console.warn(`無法載入清單 ${url}: ${error.message}`);
        }
    }

    return allDomains;
}

/**
 * 初始化可忽略的域名列表
 * @param {Object} options - 選項
 * @param {Array<string>} options.adblockUrls - 自訂 adblock 清單 URL
 * @param {boolean} options.useAdblock - 是否使用 adblock 清單（預設 true）
 */
async function initializeIgnorableDomains(options = {}) {
    const { adblockUrls = [], useAdblock = true } = options;

    // 重置為手動維護的清單
    IGNORABLE_DOMAINS = [...MANUAL_IGNORABLE_DOMAINS];

    if (useAdblock) {
        try {
            ADBLOCK_DOMAINS = await loadAdblockLists(adblockUrls);
            // 將 adblock 域名加入可忽略列表
            IGNORABLE_DOMAINS.push(...Array.from(ADBLOCK_DOMAINS));
            console.log(`已載入 ${ADBLOCK_DOMAINS.size} 個 adblock 域名規則`);
        } catch (error) {
            console.warn('載入 adblock 清單失敗，使用預設清單:', error.message);
        }
    }
}

async function collectHARAndCanonical(url) {
    const browser = await chromium.launch();
    const context = await browser.newContext({
        bypassCSP: true,
        ignoreHTTPSErrors: true
    });

    const page = await context.newPage();

    try {
        // 開始收集 HAR
        await context.tracing.start({ snapshots: true, screenshots: true });

        // 訪問頁面
        await page.goto(url);
        await page.waitForLoadState('networkidle');

        // 嘗試獲取 canonical URL
        const canonical = await page.evaluate((originalURL) => {
            // 優先使用 canonical 標籤
            const canonicalLink = document.querySelector('link[rel="canonical"]');
            if (canonicalLink) {
                return canonicalLink.href;
            }
            // 如果沒有 canonical 標籤，使用原始 URL
            return originalURL;
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

/**
 * 檢查域名是否應該被忽略
 * @param {string} hostname - 要檢查的主機名
 * @returns {boolean} 如果應該被忽略則返回 true
 */
function shouldIgnoreDomain(hostname) {
    // 使用 Set 進行快速查找
    if (ADBLOCK_DOMAINS.has(hostname)) {
        return true;
    }

    // 檢查子域名匹配（例如：ads.example.com 匹配 example.com）
    const hostnameParts = hostname.split('.');
    for (let i = 0; i < hostnameParts.length; i++) {
        const domain = hostnameParts.slice(i).join('.');
        if (ADBLOCK_DOMAINS.has(domain)) {
            return true;
        }
    }

    // 檢查手動維護的清單（使用 includes 以支援部分匹配）
    return MANUAL_IGNORABLE_DOMAINS.some(domain => hostname.includes(domain));
}

function cleanHARData(requests) {
    return requests.filter(request => {
        try {
            const url = new URL(request.url);
            return !shouldIgnoreDomain(url.hostname);
        } catch {
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

async function checkWebsiteResilience(url, options = {}) {
    try {
        // 初始化可忽略的域名列表（如果尚未初始化）
        if (ADBLOCK_DOMAINS.size === 0 && options.useAdblock !== false) {
            await initializeIgnorableDomains({
                adblockUrls: options.adblockUrls,
                useAdblock: options.useAdblock !== false
            });
        }

        // 保存原始輸入的 URL
        const inputURL = url;

        // 確保 URL 有 protocol
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }

        console.log(`開始檢測網站: ${url}`);

        // 1. 收集 connections 和 canonical URL
        const { requests, canonical: canonicalURL } = await collectHARAndCanonical(url);

        if (canonicalURL !== url) {
            console.log(`檢測到 canonical URL: ${canonicalURL}`);
        }

        console.log(`收集到 ${requests.length} 個請求`);

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

        // 5. 產生報告
        console.log('\n檢測結果:');
        console.log('-------------------');
        console.log(`境內服務 (O): ${resilience.domestic}`);
        console.log(`有國內節點的雲端服務 (?): ${resilience.cloud}`);
        console.log(`境外服務 (X): ${resilience.foreign}`);

        console.log('\n詳細資訊:');
        console.log('-------------------');
        locationResults.forEach(result => {
            console.log(`\n${result.domain}:`);
            console.log(formatDomainDetail(result, cleanedData, resilience));
        });

        // 準備結果資料
        const result = {
            url: inputURL,           // 使用原始輸入的 URL
            canonicalURL,            // 保存實際訪問的 URL
            timestamp: new Date().toISOString(),
            testingEnvironment: {
                ip: localIPInfo.ip,
                ...localIPInfo,
                dnsServers: {
                    type: customDNS ? 'custom' : 'system',
                    servers: customDNS ? [customDNS] : dns.getServers()
                }
            },
            requestCount: requests.length,
            uniqueDomains: domains.length,
            test_results: {
                domestic: resilience.domestic,
                cloud_w_domestic_node: resilience.cloud,
                foreign: resilience.foreign
            },
            domainDetails: locationResults.map(result =>
                formatDomainDetail(result, cleanedData, resilience)
            )
        };

        // 如果指定要儲存結果
        if (options.save) {
            // 確保目錄存在
            await fs.mkdir('test_results', { recursive: true });

            // 自動生成輸出檔名 - 使用 canonical URL
            const urlObj = new URL(canonicalURL);
            let filename = `${urlObj.hostname}${urlObj.pathname.replace(/\//g, '_')}${
                urlObj.search ? '_' + urlObj.search.replace(/[?&=]/g, '_') : ''
            }`.replace(/_+$/, '');

            // 如果檔名太長，直接截斷到 95 字元
            if (filename.length > 95) {
                filename = filename.slice(0, 95);
            }

            const outputPath = path.resolve(`test_results/${filename}.json`);

            // 儲存結果
            await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
            console.log(`\n結果已儲存至: ${outputPath}`);
        }

        return result;
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
    let useAdblock = true;
    let adblockUrls = [];

    // 確保 URL 有 protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }

    // 解析命令列參數
    const dnsIndex = args.indexOf('--dns');
    if (dnsIndex !== -1 && args[dnsIndex + 1]) {
        customDNS = args[dnsIndex + 1];
    }

    const tokenIndex = args.indexOf('--ipinfo-token');
    if (tokenIndex !== -1 && args[tokenIndex + 1]) {
        token = args[tokenIndex + 1];
    }

    // 檢查是否要儲存結果
    save = args.includes('--save');

    // 檢查是否要使用 adblock 清單
    if (args.includes('--no-adblock')) {
        useAdblock = false;
    }

    // 解析自訂 adblock 清單 URL
    const adblockUrlIndex = args.indexOf('--adblock-url');
    if (adblockUrlIndex !== -1) {
        // 支援多個 URL，用逗號分隔或多次指定
        const urlArg = args[adblockUrlIndex + 1];
        if (urlArg) {
            adblockUrls = urlArg.split(',').map(u => u.trim());
        }
    }

    if (!url || url.startsWith('--')) {
        console.error('請提供要檢測的網址');
        console.error('使用方式:');
        console.error('  npm run check [--dns 8.8.8.8] [--save] https://example.com');
        console.error('  npm run check [--dns 8.8.8.8] [--ipinfo-token your-token] [--save] https://example.com');
        console.error('  npm run check [--no-adblock] https://example.com  # 不使用 adblock 清單');
        console.error('  npm run check [--adblock-url url1,url2] https://example.com  # 使用自訂 adblock 清單');
        process.exit(1);
    }

    // 執行檢測
    checkWebsiteResilience(url, { customDNS, token, save, useAdblock, adblockUrls })
        .then(() => {
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