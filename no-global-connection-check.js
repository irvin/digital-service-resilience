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
const crypto = require('crypto');

// 建立 ipinfo client
// const ipinfo = new IPinfoWrapper(process.env.IPINFO_TOKEN || undefined);

// 可忽略的域名列表（手動維護的）
const MANUAL_IGNORABLE_DOMAINS = [
    'fonts.gstatic.com'
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
 * 取得 URL 的快取檔名（使用 hash）
 * @param {string} url - URL
 * @returns {string} 快取檔名
 */
function getCacheFileName(url) {
    const hash = crypto.createHash('md5').update(url).digest('hex');
    return `${hash}.json`;
}

/**
 * 取得快取檔案路徑
 * @param {string} url - URL
 * @returns {string} 快取檔案路徑
 */
function getCacheFilePath(url) {
    const cacheDir = path.join(__dirname, '.cache', 'adblock');
    const fileName = getCacheFileName(url);
    return path.join(cacheDir, fileName);
}

/**
 * 取得 IPinfo 快取檔案路徑
 * @param {string} ip - IP 地址
 * @returns {string} 快取檔案路徑
 */
function getIPinfoCacheFilePath(ip) {
    const cacheDir = path.join(__dirname, '.cache', 'ipinfo');
    const fileName = getCacheFileName(ip);
    return path.join(cacheDir, fileName);
}

/**
 * 檢查快取是否有效（預設 24 小時）
 * @param {string} cachePath - 快取檔案路徑
 * @param {number} maxAge - 最大年齡（毫秒），預設 24 小時
 * @returns {Promise<boolean>} 如果快取有效則返回 true
 */
async function isCacheValid(cachePath, maxAge = 24 * 60 * 60 * 1000) {
    try {
        const stats = await fs.stat(cachePath);
        const age = Date.now() - stats.mtime.getTime();
        return age < maxAge;
    } catch {
        return false;
    }
}

/**
 * 讀取快取
 * @param {string} cachePath - 快取檔案路徑
 * @returns {Promise<string|null>} 快取內容，如果不存在則返回 null
 */
async function readCache(cachePath) {
    try {
        const data = await fs.readFile(cachePath, 'utf-8');
        const cache = JSON.parse(data);
        return cache.content;
    } catch {
        return null;
    }
}

/**
 * 寫入快取
 * @param {string} cachePath - 快取檔案路徑
 * @param {string} content - 要快取的內容
 */
async function writeCache(cachePath, content) {
    try {
        // 確保快取目錄存在
        const cacheDir = path.dirname(cachePath);
        await fs.mkdir(cacheDir, { recursive: true });

        const cacheData = {
            content,
            timestamp: new Date().toISOString(),
            cachedAt: Date.now()
        };

        await fs.writeFile(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');
    } catch (error) {
        console.warn(`無法寫入快取 ${cachePath}: ${error.message}`);
    }
}

/**
 * 從線上載入 adblock 清單（支援快取）
 * @param {Array<string>} listUrls - adblock 清單的 URL 陣列
 * @param {Object} options - 選項
 * @param {boolean} options.useCache - 是否使用快取（預設 true）
 * @returns {Promise<Set<string>>} 解析後的域名集合
 */
async function loadAdblockLists(listUrls = [], options = {}) {
    const { useCache = true } = options;
    const cacheMaxAge = 24 * 60 * 60 * 1000; // 固定 24 小時
    const defaultLists = [
        'https://easylist.to/easylist/easylist.txt',
        'https://easylist.to/easylist/easyprivacy.txt'
    ];

    const urls = listUrls.length > 0 ? listUrls : defaultLists;
    const allDomains = new Set();

    for (const url of urls) {
        try {
            const cachePath = getCacheFilePath(url);
            let content = null;

            // 嘗試讀取快取
            if (useCache) {
                const isValid = await isCacheValid(cachePath, cacheMaxAge);
                if (isValid) {
                    content = await readCache(cachePath);
                    if (content) {
                        console.log(`使用快取載入 adblock 清單: ${url}`);
                        const domains = parseAdblockRules(content);
                        for (const domain of domains) {
                            allDomains.add(domain);
                        }
                        console.log(`  已載入 ${domains.size} 個域名規則（來自快取）`);
                        continue;
                    }
                }
            }

            // 快取無效或不存在，從網路下載
            console.log(`正在下載 adblock 清單: ${url}`);
            const response = await axios.get(url, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; AdblockListLoader/1.0)'
                }
            });

            content = response.data;

            // 儲存到快取
            if (useCache) {
                await writeCache(cachePath, content);
            }

            const domains = parseAdblockRules(content);
            for (const domain of domains) {
                allDomains.add(domain);
            }
            console.log(`  已載入 ${domains.size} 個域名規則`);
        } catch (error) {
            console.warn(`無法載入清單 ${url}: ${error.message}`);

            // 如果下載失敗，嘗試使用舊的快取（即使已過期）
            if (useCache) {
                const cachePath = getCacheFilePath(url);
                const content = await readCache(cachePath);
                if (content) {
                    console.log(`  嘗試使用過期快取...`);
                    const domains = parseAdblockRules(content);
                    for (const domain of domains) {
                        allDomains.add(domain);
                    }
                    console.log(`  已載入 ${domains.size} 個域名規則（來自過期快取）`);
                }
            }
        }
    }

    return allDomains;
}

/**
 * 初始化可忽略的域名列表
 * @param {Object} options - 選項
 * @param {Array<string>} options.adblockUrls - 自訂 adblock 清單 URL
 * @param {boolean} options.useAdblock - 是否使用 adblock 清單（預設 true）
 * @param {boolean} options.useCache - 是否使用快取（預設 true）
 */
async function initializeIgnorableDomains(options = {}) {
    const {
        adblockUrls = [],
        useAdblock = true,
        useCache = true
    } = options;

    // 重置為手動維護的清單
    IGNORABLE_DOMAINS = [...MANUAL_IGNORABLE_DOMAINS];

    if (useAdblock) {
        try {
            ADBLOCK_DOMAINS = await loadAdblockLists(adblockUrls, { useCache });
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
 * 檢查兩個域名是否相關（一個是另一個的子域名或相同）
 * @param {string} hostname1 - 第一個域名
 * @param {string} hostname2 - 第二個域名
 * @returns {boolean} 如果相關則返回 true
 */
function isRelatedDomain(hostname1, hostname2) {
    if (hostname1 === hostname2) {
        return true;
    }
    // 檢查 hostname1 是否是 hostname2 的子域名
    if (hostname1.endsWith('.' + hostname2)) {
        return true;
    }
    // 檢查 hostname2 是否是 hostname1 的子域名
    if (hostname2.endsWith('.' + hostname1)) {
        return true;
    }
    return false;
}

/**
 * 檢查域名是否應該被忽略
 * @param {string} hostname - 要檢查的主機名
 * @param {string|null} targetHostname - 目標網址的主機名，如果是目標網址本身或其子域名則不忽略
 * @returns {boolean} 如果應該被忽略則返回 true
 */
function shouldIgnoreDomain(hostname, targetHostname = null) {
    // 如果是目標網址本身或其相關域名（子域名），則不忽略
    if (targetHostname && isRelatedDomain(hostname, targetHostname)) {
        return false;
    }

    // 使用 Set 進行快速查找
    if (ADBLOCK_DOMAINS.has(hostname)) {
        return true;
    }

    // 檢查子域名匹配（例如：ads.example.com 匹配 example.com）
    const hostnameParts = hostname.split('.');
    for (let i = 0; i < hostnameParts.length; i++) {
        const domain = hostnameParts.slice(i).join('.');
        if (ADBLOCK_DOMAINS.has(domain)) {
            // 如果匹配的域名是目標網址或其相關域名，則不忽略
            if (targetHostname && isRelatedDomain(domain, targetHostname)) {
                return false;
            }
            return true;
        }
    }

    // 檢查手動維護的清單（使用 includes 以支援部分匹配）
    const matchedManualDomain = MANUAL_IGNORABLE_DOMAINS.find(domain => hostname.includes(domain));
    if (matchedManualDomain) {
        return true;
    }

    return false;
}

/**
 * 獲取域名被忽略的原因
 * @param {string} hostname - 要檢查的主機名
 * @param {string|null} targetHostname - 目標網址的主機名
 * @returns {string|null} 忽略原因，如果沒有被忽略則返回 null
 */
function getIgnoreReason(hostname, targetHostname = null) {
    // 如果是目標網址本身或其相關域名，則不忽略
    if (targetHostname && isRelatedDomain(hostname, targetHostname)) {
        return null;
    }

    // 檢查是否在 adblock 清單中（完全匹配）
    if (ADBLOCK_DOMAINS.has(hostname)) {
        return `Adblock 清單（完全匹配）`;
    }

    // 檢查子域名匹配
    const hostnameParts = hostname.split('.');
    for (let i = 0; i < hostnameParts.length; i++) {
        const domain = hostnameParts.slice(i).join('.');
        if (ADBLOCK_DOMAINS.has(domain)) {
            // 如果匹配的域名是目標網址或其相關域名，則不忽略
            if (targetHostname && isRelatedDomain(domain, targetHostname)) {
                return null;
            }
            return `Adblock 清單（子域名匹配: ${domain}）`;
        }
    }

    // 檢查手動維護的清單
    const matchedManualDomain = MANUAL_IGNORABLE_DOMAINS.find(domain => hostname.includes(domain));
    if (matchedManualDomain) {
        return `手動維護清單（匹配: ${matchedManualDomain}）`;
    }

    return null;
}

function cleanHARData(requests, targetHostname = null) {
    return requests.filter(request => {
        try {
            const url = new URL(request.url);
            return !shouldIgnoreDomain(url.hostname, targetHostname);
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

        // 檢查快取選項
        const useCache = options.useCache !== false;
        const cacheMaxAge = 24 * 60 * 60 * 1000; // 固定 24 小時
        const cachePath = getIPinfoCacheFilePath(ip);

        // 嘗試讀取快取
        if (useCache) {
            const isValid = await isCacheValid(cachePath, cacheMaxAge);
            if (isValid) {
                const cachedData = await readCache(cachePath);
                if (cachedData) {
                    try {
                        const cachedResult = JSON.parse(cachedData);
                        if (options.debug) {
                            console.log(`[DEBUG] 使用快取 IPinfo 結果: ${ip}`);
                        }
                        return {
                            source: 'json api (cached)',
                            domain,
                            ip,
                            ...cachedResult
                        };
                    } catch {
                        // 快取格式錯誤，繼續查詢
                        if (options.debug) {
                            console.log(`[DEBUG] 快取格式錯誤，重新查詢: ${ip}`);
                        }
                    }
                }
            }
        }

        // 快取無效或不存在，從 API 查詢
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

        const result = {
            source: 'json api',
            domain,
            ip,
            ...response.data
        };

        // 儲存到快取
        if (useCache) {
            await writeCache(cachePath, JSON.stringify(response.data, null, 2));
        }

        return result;
    } catch (error) {
        console.error(`[API] 檢查 ${domain} 失敗:`, error.message);

        // 如果查詢失敗，嘗試使用過期快取作為備用
        if (options.useCache !== false) {
            const ip = await getDomainIP(domain, options.customDNS);
            if (ip) {
                const cachePath = getIPinfoCacheFilePath(ip);
                const cachedData = await readCache(cachePath);
                if (cachedData) {
                    try {
                        const cachedResult = JSON.parse(cachedData);
                        if (options.debug) {
                            console.log(`[DEBUG] 使用過期快取 IPinfo 結果: ${ip}`);
                        }
                        return {
                            source: 'json api (expired cache)',
                            domain,
                            ip,
                            ...cachedResult
                        };
                    } catch {
                        // 忽略快取解析錯誤
                    }
                }
            }
        }

        return {
            source: 'json api',
            domain,
            error: true,
            message: error.message
        };
    }
}

async function checkIPLocation(domain, customDNS = null, options = {}) {
    const apiResult = await checkIPLocationWithAPI(domain, {
        customDNS,
        useCache: options.useCache !== false,
        token: options.token,
        debug: options.debug
    });
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

/**
 * Cloudflare Challenge 錯誤類別
 */
class CloudflareChallengeError extends Error {
    constructor(result) {
        super('Cloudflare Challenge detected');
        this.name = 'CloudflareChallengeError';
        this.result = result;
    }
}

/**
 * 零請求錯誤類別
 */
class ZeroRequestError extends Error {
    constructor(result) {
        super('No domains after filtering');
        this.name = 'ZeroRequestError';
        this.result = result;
    }
}

/**
 * 檢測是否遇到 Cloudflare challenge
 * @param {Array} domainDetails - 域名詳細資訊陣列
 * @returns {Object|null} 如果檢測到 Cloudflare challenge 則返回錯誤資訊，否則返回 null
 */
function detectCloudflareChallenge(domainDetails) {
    if (!domainDetails || domainDetails.length === 0) {
        return null;
    }

    // 檢查是否有 Cloudflare challenge 的跡象
    const challengeIndicators = domainDetails.filter(detail => {
        // 檢查 originalUrl 是否包含 challenge-platform 或域名是 challenges.cloudflare.com
        return detail.originalUrl && (
            detail.originalUrl.includes('cdn-cgi/challenge-platform') ||
            detail.originalUrl.includes('challenges.cloudflare.com')
        );
    });

    if (challengeIndicators.length > 0) {
        return {
            testError: true,
            errorReason: 'Cloudflare Challenge',
            errorDetails: challengeIndicators
        };
    }

    return null;
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
    // 在函數開始時初始化變數，以便在 catch 區塊中使用
    let inputURL = url;
    let canonicalURL = null;
    let requests = [];
    let localIPInfo = null;
    let customDNS = null;

    try {
        // 初始化可忽略的域名列表（如果尚未初始化）
        if (ADBLOCK_DOMAINS.size === 0 && options.useAdblock !== false) {
            if (options.debug) {
                console.log('[DEBUG] 正在載入 adblock 清單...');
            }
            await initializeIgnorableDomains({
                adblockUrls: options.adblockUrls,
                useAdblock: options.useAdblock !== false,
                useCache: options.useCache !== false
            });
            if (options.debug) {
                console.log(`[DEBUG] 已載入 ${ADBLOCK_DOMAINS.size} 個 adblock 域名規則`);
            }
        }

        // 保存原始輸入的 URL
        inputURL = url;

        // 確保 URL 有 protocol
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }

        console.log(`開始檢測網站: ${url}`);

        // 1. 收集 connections 和 canonical URL
        const harResult = await collectHARAndCanonical(url);
        requests = harResult.requests || [];
        canonicalURL = harResult.canonical || null;

        if (canonicalURL !== url) {
            console.log(`檢測到 canonical URL: ${canonicalURL}`);
        }

        console.log(`收集到 ${requests.length} 個請求`);

        // Debug: 顯示所有請求
        if (options.debug) {
            console.log('\n[DEBUG] 所有請求列表:');
            console.log('-------------------');
            requests.forEach((req, idx) => {
                console.log(`[${idx + 1}] ${req.url} (${req.type})`);
            });
        }

        // 使用環境變數中的 DNS（如果有指定的話）
        const envDNS = process.env.DEFAULT_DNS;
        customDNS = options.customDNS || envDNS;

        // 取得測試環境資訊
        localIPInfo = await getLocalIPInfo(options);
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

        // 取得目標網址的主機名（用於判斷是否為目標網址本身）
        const targetURL = new URL(canonicalURL || url);
        const targetHostname = targetURL.hostname;

        // 2. 清理資料
        const cleanedData = cleanHARData(requests, targetHostname);
        const domains = Object.values(cleanedData).map(req => new URL(req.url).hostname);
        console.log(`清理後剩餘 ${domains.length} 個唯一域名`);

        // 檢查是否為零域名（篩選後沒有剩餘域名）
        if (domains.length === 0) {
            // 建立錯誤結果物件
            const errorResult = {
                url: inputURL,
                canonicalURL: canonicalURL || url,
                timestamp: new Date().toISOString(),
                testParameters: {
                    customDNS: customDNS || null,
                    useAdblock: options.useAdblock !== false,
                    adblockUrls: options.adblockUrls || [],
                    useCache: options.useCache !== false,
                    hasIPinfoToken: !!(options.token || process.env.IPINFO_TOKEN)
                },
                testingEnvironment: {
                    ip: localIPInfo.ip,
                    ...localIPInfo,
                    dnsServer: customDNS || (dns.getServers().length > 0 ? dns.getServers()[0] : null)
                },
                requestCount: requests.length,
                uniqueDomains: 0,
                testError: true,
                errorReason: 'No domains after filtering',
                errorDetails: {
                    message: '所有域名都被 adblock 清單過濾掉了',
                    totalRequests: requests.length,
                    filteredDomains: 0
                }
            };
            throw new ZeroRequestError(errorResult);
        }

        // Debug: 顯示清理後的域名列表
        if (options.debug) {
            console.log('\n[DEBUG] 清理後的域名列表:');
            console.log('-------------------');
            domains.forEach((domain, idx) => {
                console.log(`[${idx + 1}] ${domain}`);
            });

            // 顯示被忽略的域名及其原因
            const ignoredDomainsWithReasons = requests
                .map(req => {
                    try {
                        const hostname = new URL(req.url).hostname;
                        const reason = getIgnoreReason(hostname, targetHostname);
                        return reason ? { hostname, reason } : null;
                    } catch {
                        return null;
                    }
                })
                .filter(item => item !== null)
                .filter((item, idx, self) => {
                    // 去重，只保留第一次出現的
                    return self.findIndex(x => x.hostname === item.hostname) === idx;
                })
                .filter(item => !domains.includes(item.hostname)); // 確保不在清理後的域名列表中

            if (ignoredDomainsWithReasons.length > 0) {
                console.log('\n[DEBUG] 被忽略的域名:');
                console.log('-------------------');
                ignoredDomainsWithReasons.forEach((item, idx) => {
                    console.log(`[${idx + 1}] ${item.hostname}`);
                    console.log(`     原因: ${item.reason}`);
                });
            }
        }

        // 3. 檢查每個域名
        if (options.debug) {
            console.log('\n[DEBUG] 開始檢查域名 IP 位置...');
        }
        const locationResults = await Promise.all(
            domains.map(async (domain) => {
                if (options.debug) {
                    console.log(`[DEBUG] 檢查 ${domain}...`);
                }
                const result = await checkIPLocation(domain, customDNS, {
                    useCache: options.useCache !== false,
                    token: options.token,
                    debug: options.debug
                });
                if (options.debug) {
                    console.log(`[DEBUG] ${domain}: ${result.ip || 'N/A'} (${result.country || 'N/A'}) ${result.source?.includes('cached') ? '(快取)' : ''}`);
                }
                return result;
            })
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
            testParameters: {
                customDNS: customDNS || null,
                useAdblock: options.useAdblock !== false,
                adblockUrls: options.adblockUrls || [],
                useCache: options.useCache !== false,
                hasIPinfoToken: !!(options.token || process.env.IPINFO_TOKEN)
            },
            testingEnvironment: {
                ip: localIPInfo.ip,
                ...localIPInfo,
                dnsServer: customDNS || (dns.getServers().length > 0 ? dns.getServers()[0] : null)
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

        // 檢測 Cloudflare challenge
        const cloudflareChallenge = detectCloudflareChallenge(result.domainDetails);
        if (cloudflareChallenge) {
            // 將錯誤資訊加入到結果中
            Object.assign(result, cloudflareChallenge);
            // 拋出錯誤，讓 catch 區塊處理
            throw new CloudflareChallengeError(result);
        }

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
        // 統一把所有錯誤視為測試錯誤，建立包含 errorReason 的結果物件
        let errorResult = null;

        // 如果錯誤已經有 result（CloudflareChallengeError 或 ZeroRequestError），直接使用
        if ((error instanceof CloudflareChallengeError || error instanceof ZeroRequestError) && error.result) {
            errorResult = error.result;
        } else {
            // 為其他錯誤建立結果物件
            const isTimeout = error.name === 'TimeoutError';

            // 確保 URL 有 protocol（用於建立檔名）
            let urlForFilename = inputURL;
            if (urlForFilename && !urlForFilename.startsWith('http://') && !urlForFilename.startsWith('https://')) {
                urlForFilename = 'https://' + urlForFilename;
            }

            errorResult = {
                url: inputURL,
                canonicalURL: canonicalURL || urlForFilename,
                timestamp: new Date().toISOString(),
                testParameters: {
                    customDNS: customDNS || null,
                    useAdblock: options.useAdblock !== false,
                    adblockUrls: options.adblockUrls || [],
                    useCache: options.useCache !== false,
                    hasIPinfoToken: !!(options.token || process.env.IPINFO_TOKEN)
                },
                testingEnvironment: localIPInfo && !localIPInfo.error ? {
                    ip: localIPInfo.ip,
                    ...localIPInfo,
                    dnsServer: customDNS || (dns.getServers().length > 0 ? dns.getServers()[0] : null)
                } : null,
                requestCount: requests ? requests.length : 0,
                uniqueDomains: 0,
                testError: true,
                errorReason: isTimeout ? 'Timeout' : `Error: ${error.name || 'Unknown'}`,
                errorDetails: {
                    message: error.message,
                    name: error.name,
                    stack: error.stack
                }
            };
        }

        console.error(`檢測到測試錯誤: ${errorResult.errorReason || error.message}`);

        // 將 result 附加到 error 物件上，讓 batch-test.js 可以讀取
        error.result = errorResult;

        // 儲存錯誤結果到 JSON 檔案
        if (options.save) {
            try {
                // 確保目錄存在
                await fs.mkdir('test_results', { recursive: true });

                // 從錯誤結果中取得 URL 資訊
                const urlToUse = errorResult.canonicalURL || errorResult.url;
                const urlObj = new URL(urlToUse);
                let filename = `${urlObj.hostname}${urlObj.pathname.replace(/\//g, '_')}${
                    urlObj.search ? '_' + urlObj.search.replace(/[?&=]/g, '_') : ''
                }`.replace(/_+$/, '');

                // 如果檔名太長，直接截斷到 95 字元（預留 .error.json 的空間）
                if (filename.length > 95) {
                    filename = filename.slice(0, 95);
                }

                const outputPath = path.resolve(`test_results/${filename}.error.json`);

                // 儲存包含錯誤資訊的結果
                await fs.writeFile(outputPath, JSON.stringify(errorResult, null, 2));
                console.log(`\n錯誤結果已儲存至: ${outputPath}`);
            } catch (saveError) {
                console.error('無法儲存錯誤結果:', saveError.message);
            }
        }

        // 重新拋出錯誤，讓上層處理
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
    let debug = false;
    let useCache = true;

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

    // 檢查是否要開啟 debug 模式
    debug = args.includes('--debug');

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

    // 解析快取選項
    if (args.includes('--no-cache')) {
        useCache = false;
    }

    if (!url || url.startsWith('--')) {
        console.error('請提供要檢測的網址');
        console.error('使用方式:');
        console.error('  npm run check [--dns 8.8.8.8] [--save] https://example.com');
        console.error('  npm run check [--dns 8.8.8.8] [--ipinfo-token your-token] [--save] https://example.com');
        console.error('  npm run check [--no-adblock] https://example.com  # 不使用 adblock 清單');
        console.error('  npm run check [--adblock-url url1,url2] https://example.com  # 使用自訂 adblock 清單');
        console.error('  npm run check [--debug] https://example.com  # 開啟 debug 模式，顯示詳細資訊');
        console.error('  npm run check [--no-cache] https://example.com  # 不使用快取，強制重新下載');
        process.exit(1);
    }

    // 執行檢測
    checkWebsiteResilience(url, {
        customDNS,
        token,
        save,
        useAdblock,
        adblockUrls,
        debug,
        useCache
    })
        .then(() => {
            console.log('檢測完成');
        })
        .catch(error => {
            console.error('檢測失敗:', error);
            if (debug) {
                console.error('錯誤堆疊:', error.stack);
            }
            process.exit(1);
        });
}

module.exports = {
    checkWebsiteResilience
};