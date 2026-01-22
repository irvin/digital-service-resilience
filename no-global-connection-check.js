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
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// 建立 ipinfo client
// const ipinfo = new IPinfoWrapper(process.env.IPINFO_TOKEN || undefined);

// 可忽略的域名列表（手動維護的）
const MANUAL_IGNORABLE_DOMAINS = [
    'fonts.gstatic.com'
    // 'static.hotjar.com',
    // '*.clarity.ms'
];

const DEFAULT_ADBLOCK_LISTS = [
    'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_15_DnsFilter/filter.txt'
];

const CLOUD_PROVIDERS_DATA_PATH = path.join(
    __dirname,
    'top-traffic-list-taiwan',
    'cloud_providers_tw.json'
);
let CLOUD_PROVIDER_INDEX = null;

// 需要進一步判斷的雲端服務商 ASN 列表
const TARGET_CLOUD_ASNS = [
    'AS15169',   // Google LLC
    'AS396982',  // Google LLC
    'AS19527',   // Google LLC
    'AS13335',   // Cloudflare, Inc.
    'AS209242',  // Cloudflare, Inc.
    'AS16509',   // Amazon.com, Inc.
    'AS14618',   // Amazon.com, Inc.
    'AS54113',   // Fastly, Inc.
    'AS16625',   // Akamai Technologies, Inc.
    'AS20940',   // Akamai Technologies, Inc.
    'AS32787',   // Akamai Technologies, Inc.
    'AS8075'    // Microsoft Azure
];

// 需要檢查的 response headers
const CLOUD_HEADERS = ['cf-ray', 'x-amz-cf-pop', 'x-served-by'];

// RTT 測試閾值（毫秒）
const RTT_THRESHOLD = 15;

async function loadcloudProviderInfo() {
    if (CLOUD_PROVIDER_INDEX) {
        return CLOUD_PROVIDER_INDEX;
    }

    try {
        const rawData = await fs.readFile(CLOUD_PROVIDERS_DATA_PATH, 'utf-8');
        const data = JSON.parse(rawData);
        const groupKeys = [
            'providers_intl',
            'providers_intl_without_known_taiwan_region/pop',
            'providers_local'
        ];
        const providers = groupKeys.flatMap(key => Array.isArray(data[key]) ? data[key] : []);
        const orgKeywordMap = new Map();
        const asnMap = new Map();

        for (const provider of providers) {
            const name = provider?.name || 'Unknown';
            const identifiers = provider?.identifiers || {};
            for (const asn of identifiers.asn || []) {
                if (asn) {
                    asnMap.set(asn.toUpperCase(), name);
                }
            }
            for (const keyword of identifiers.org_keywords || []) {
                if (keyword) {
                    orgKeywordMap.set(keyword.toUpperCase(), name);
                }
            }
        }

        CLOUD_PROVIDER_INDEX = { orgKeywordMap, asnMap };
        return CLOUD_PROVIDER_INDEX;
    } catch (error) {
        console.warn(`無法載入雲端服務清單: ${error.message}`);
        CLOUD_PROVIDER_INDEX = {
            orgKeywordMap: new Map(),
            asnMap: new Map()
        };
        return CLOUD_PROVIDER_INDEX;
    }
}

function getCloudProviderMatch(orgValue, cloudProviderInfo) {
    if (!orgValue || !cloudProviderInfo) {
        return null;
    }

    const orgUpper = orgValue.toUpperCase();
    const asnMatch = orgUpper.match(/AS\d+/);
    if (asnMatch) {
        const asn = asnMatch[0];
        if (cloudProviderInfo.asnMap.has(asn)) {
            return {
                name: cloudProviderInfo.asnMap.get(asn),
                matchType: 'asn',
                matchValue: asn
            };
        }
    }

    return null;
}


// 動態載入的 adblock 清單域名（會在初始化時載入）
let ADBLOCK_DOMAINS = new Set();

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

    const urls = listUrls.length > 0 ? listUrls : DEFAULT_ADBLOCK_LISTS;
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

function getAdblockUrlsForResult(options = {}) {
    const list = Array.isArray(options.adblockUrls) ? options.adblockUrls : [];
    return list.length > 0 ? list : DEFAULT_ADBLOCK_LISTS;
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
            console.log(`已載入 ${ADBLOCK_DOMAINS.size} 個 adblock 域名規則`);
        } catch (error) {
            console.warn('載入 adblock 清單失敗，使用預設清單:', error.message);
        }
    }
}

async function collectHARAndCanonical(url, options = {}) {
    const timeout = options.timeout || 120000; // 預設 120 秒
    const debug = options.debug || false;
    // 如果明確指定 headless，使用指定值；否則預設為 true（headless 模式）
    const headless = options.headless !== undefined ? options.headless : true;

    const browser = await chromium.launch({
        headless: headless
    });

    const context = await browser.newContext({
        bypassCSP: true,
        ignoreHTTPSErrors: true,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // 收集所有請求（包含主頁面請求）
    const allRequests = [];

    // 收集 response headers
    const responseHeadersMap = new Map();

    // 監聽所有請求
    page.on('request', request => {
        allRequests.push({
            url: request.url(),
            type: request.resourceType()
        });

        if (debug) {
            console.log(`[DEBUG] → 請求: ${request.method()} ${request.url()}`);
        }
    });

    // 監聽回應並收集 headers（不僅限於 debug 模式）
    page.on('response', async (response) => {
        const url = response.url();
        try {
            const headers = response.headers();
            responseHeadersMap.set(url, headers);
        } catch (error) {
            // 忽略無法取得 headers 的情況
        }

        // 保留原有的 debug 輸出
        if (debug) {
            const status = response.status();
            const statusText = status >= 400 ? '❌' : '✓';
            console.log(`[DEBUG] ${statusText} 回應: ${status} ${response.url()}`);
        }
    });

    // 如果啟用 debug，監聽各種事件
    if (debug) {
        console.log(`[DEBUG] 開始載入頁面: ${url}`);

        // 監聽請求失敗
        page.on('requestfailed', request => {
            console.log(`[DEBUG] ✗ 請求失敗: ${request.method()} ${request.url()} - ${request.failure()?.errorText || 'Unknown'}`);
        });

        // 監聽載入狀態變化
        page.on('load', () => {
            console.log(`[DEBUG] ✓ 頁面載入完成 (load)`);
        });

        page.on('domcontentloaded', () => {
            console.log(`[DEBUG] ✓ DOM 內容載入完成 (domcontentloaded)`);
        });

        // 監聽 console 訊息
        page.on('console', msg => {
            const type = msg.type();
            const text = msg.text();
            if (type === 'error' || type === 'warning') {
                console.log(`[DEBUG] Console ${type}: ${text}`);
            }
        });

        // 監聽頁面錯誤
        page.on('pageerror', error => {
            console.log(`[DEBUG] ✗ 頁面錯誤: ${error.message}`);
        });
    }

    try {
        // 開始收集 HAR
        await context.tracing.start({ snapshots: true, screenshots: true });

        if (debug) {
            console.log(`[DEBUG] 正在導航到: ${url}`);
        }

        // 訪問頁面並檢查響應狀態碼
        const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: timeout
        });

        if (debug) {
            console.log(`[DEBUG] ✓ 導航完成，狀態碼: ${response ? response.status() : 'N/A'}`);
        }

        // 取得 HTTP 狀態碼
        const httpStatus = response ? response.status() : null;

        // 檢查是否為 4xx 錯誤
        if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
            const statusText = response.statusText();
            throw new Error(`HTTP ${httpStatus} ${statusText}`);
        }

        if (debug) {
            console.log(`[DEBUG] 等待頁面載入狀態: load`);
        }

        await page.waitForLoadState('load', { timeout: timeout });

        if (debug) {
            console.log(`[DEBUG] ✓ 頁面載入狀態: load 完成`);
        }

        // 嘗試獲取 canonical URL
        let canonical = url; // 預設使用原始 URL
        try {
            canonical = await page.evaluate((originalURL) => {
                // 優先使用 canonical 標籤
                const canonicalLink = document.querySelector('link[rel="canonical"]');
                if (canonicalLink) {
                    return canonicalLink.href;
                }
                // 如果沒有 canonical 標籤，使用原始 URL
                return originalURL;
            }, url);
        } catch (evaluateError) {
            // 如果 evaluate 失敗（例如頁面導航導致執行上下文被破壞），使用原始 URL
            if (debug) {
                console.log(`[DEBUG] 無法取得 canonical URL: ${evaluateError.message}，使用原始 URL`);
            }
            canonical = url;
        }

        if (debug) {
            console.log(`[DEBUG] Canonical URL: ${canonical}`);
        }

        // 使用 Playwright 請求監聽器收集的請求數據
        // 這樣可以包含主頁面請求，而不只是資源請求
        const requests = allRequests.map(req => ({
            url: req.url,
            type: req.type
        }));

        if (debug) {
            console.log(`[DEBUG] 收集到 ${requests.length} 個請求`);
        }

        return { requests, canonical, httpStatus, responseHeaders: responseHeadersMap };
    } finally {
        await browser.close();
        if (debug) {
            console.log(`[DEBUG] 瀏覽器已關閉`);
        }
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

    // 檢查手動維護的清單，支援一般字串與萬用字元（例如 *.example.com）
    const matchedManualDomain = MANUAL_IGNORABLE_DOMAINS.find(domainPattern => {
        if (!domainPattern) return false;

        // 萬用字元前綴：*.example.com → 匹配 example.com 以及任何其子網域
        if (domainPattern.startsWith('*.')) {
            const base = domainPattern.slice(2); // 去掉 "*."
            return hostname === base || hostname.endsWith(`.${base}`);
        }

        // 一般情況維持原本的 includes 行為
        return hostname.includes(domainPattern);
    });
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

    // 檢查手動維護的清單（支援萬用字元）
    const matchedManualDomain = MANUAL_IGNORABLE_DOMAINS.find(domainPattern => {
        if (!domainPattern) return false;

        if (domainPattern.startsWith('*.')) {
            const base = domainPattern.slice(2);
            return hostname === base || hostname.endsWith(`.${base}`);
        }

        return hostname.includes(domainPattern);
    });
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
                            source: 'ipinfo json api (cached)',
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
            source: 'ipinfo json api (direct)',
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
                            source: 'ipinfo json api (expired cache)',
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
            source: 'ipinfo json api (error)',
            domain,
            error: true,
            message: error.message
        };
    }
}

/**
 * 從 org 欄位中提取 ASN
 * @param {string} org - org 字串，例如 "AS13335 Cloudflare, Inc."
 * @returns {string|null} ASN 字串，例如 "AS13335"，如果無法提取則返回 null
 */
function extractASN(org) {
    if (!org || typeof org !== 'string') return null;
    const match = org.match(/^(AS\d+)\s+/i);
    return match ? match[1].toUpperCase() : null;
}

/**
 * 檢查 response headers 是否包含 TPE（台灣節點標記）
 * @param {Object} headers - response headers 物件
 * @returns {Object} 包含 found, hasTPE, values 的物件
 */
function checkCloudProviderHeaders(headers) {
    if (!headers || typeof headers !== 'object') {
        return { found: false, hasTPE: false, values: {} };
    }

    const values = {};
    let found = false;
    let hasTPE = false;

    for (const headerName of CLOUD_HEADERS) {
        const headerValue = headers[headerName] || headers[headerName.toLowerCase()];
        if (headerValue) {
            found = true;
            values[headerName] = headerValue;
            // 檢查是否包含 TPE（不區分大小寫）
            if (headerValue.toUpperCase().includes('TPE')) {
                hasTPE = true;
            }
        }
    }

    return { found, hasTPE, values };
}

/**
 * 對指定 IP 進行 RTT 測試
 * @param {string} ip - IP 地址
 * @returns {Promise<number|null>} 最小延遲時間（毫秒），如果測試失敗則返回 null
 */
async function performRTTTest(ip) {
    const isWindows = process.platform === 'win32';
    const command = isWindows
        ? `ping -n 5 -i 0.2 ${ip}`
        : `ping -c 5 -i 0.2 ${ip}`;

    try {
        const { stdout } = await execAsync(command, { timeout: 10000 });

        // 解析 ping 輸出提取時間
        // Windows 格式: time=14.516ms 或 time<1ms
        // Unix/Mac 格式: time=14.516 ms
        const timePattern = isWindows
            ? /time[=<](\d+\.?\d*)\s*ms/gi
            : /time=(\d+\.?\d*)\s*ms/gi;

        const matches = stdout.match(timePattern);
        if (matches && matches.length > 0) {
            const times = matches.map(match => {
                const timeMatch = match.match(/(\d+\.?\d*)/);
                return timeMatch ? parseFloat(timeMatch[1]) : Infinity;
            });
            const minTime = Math.min(...times.filter(t => t !== Infinity));
            return minTime !== Infinity ? minTime : null;
        }
    } catch (error) {
        // RTT 測試失敗，返回 null
        return null;
    }

    return null;
}

async function checkIPLocation(domain, customDNS = null, options = {}) {
    const apiResult = await checkIPLocationWithAPI(domain, {
        customDNS,
        useCache: options.useCache !== false,
        token: options.token,
        debug: options.debug
    });

    // 如果查詢失敗，直接返回
    if (apiResult.error) {
        return apiResult;
    }

    // 如果 country 是 TW，不需要進一步判斷
    if (apiResult.country === 'TW') {
        return {
            ...apiResult,
            cloud_provider: null
        };
    }

    // 提取 ASN
    const asn = extractASN(apiResult.org);
    if (!asn || !TARGET_CLOUD_ASNS.includes(asn)) {
        // 不在目標 ASN 列表中，不需要進一步判斷
        return {
            ...apiResult,
            cloud_provider: null
        };
    }

    // 取得該 domain 對應的 response headers
    const responseHeaders = options.responseHeaders || null;
    const domainUrl = options.domainUrl || null;
    let domainHeaders = null;
    let foundTPE = false;
    let headerValues = {};

    if (responseHeaders) {
        // 先嘗試使用指定的 URL（第一個請求）
        if (domainUrl) {
            domainHeaders = responseHeaders.get(domainUrl);
            if (domainHeaders) {
                const check = checkCloudProviderHeaders(domainHeaders);
                if (check.hasTPE) {
                    foundTPE = true;
                    headerValues = check.values;
                }
            }
        }

        // 如果指定的 URL 沒有找到 TPE，檢查該 domain 的所有相關 URL
        if (!foundTPE) {
            for (const [url, headers] of responseHeaders.entries()) {
                try {
                    const urlObj = new URL(url);
                    if (urlObj.hostname === domain) {
                        const check = checkCloudProviderHeaders(headers);
                        if (check.hasTPE) {
                            foundTPE = true;
                            headerValues = check.values;
                            domainHeaders = headers;
                            break; // 找到一個包含 TPE 的就夠了
                        }
                    }
                } catch {
                    // 忽略 URL 解析錯誤
                }
            }
        }
    }

    // 檢查 headers
    if (foundTPE) {
        return {
            ...apiResult,
            cloud_provider: {
                country: 'tw',
                ...headerValues,
                detection_method: 'header'
            }
        };
    }

    // 如果沒有找到包含 TPE 的 header，進行 RTT 測試
    const rtt = await performRTTTest(apiResult.ip);
    if (rtt !== null) {
        if (rtt < RTT_THRESHOLD) {
            // RTT < 15ms，判斷為台灣
            return {
                ...apiResult,
                cloud_provider: {
                    country: 'tw',
                    rtt: rtt,
                    detection_method: 'rtt'
                }
            };
        } else {
            // RTT >= 15ms，不在台灣，但記錄 RTT 資訊（不包含 country）
            return {
                ...apiResult,
                cloud_provider: {
                    rtt: rtt,
                    detection_method: 'rtt'
                }
            };
        }
    }

    // 如果 RTT 測試失敗或沒有進行測試，不記錄 cloud_provider
    return {
        ...apiResult,
        cloud_provider: null
    };
}

function checkLocally(ipInfoResults, cloudProviderInfo) {
    const summary = {
        domestic: { cloud: 0, direct: 0 },
        foreign: { cloud: 0, direct: 0 }
    };
    const details = [];

    for (const result of ipInfoResults) {
        if (result.error) continue;

        // 優先使用 cloud_provider.country 判斷
        let isDomestic;
        if (result.cloud_provider && result.cloud_provider.country === 'tw') {
            // 經過 header 或 RTT 測試確認在台灣
            isDomestic = true;
        } else if (result.country === 'TW') {
            // 直接從 ipinfo 判斷在台灣
            isDomestic = true;
        } else {
            isDomestic = false;
        }

        const providerMatch = getCloudProviderMatch(result.org, cloudProviderInfo);
        const isCloud = !!providerMatch;
        const regionKey = isDomestic ? 'domestic' : 'foreign';
        const categoryKey = isCloud ? 'cloud' : 'direct';
        const category = `${regionKey}/${categoryKey}`;

        summary[regionKey][categoryKey]++;
        details.push({
            domain: result.domain,
            category,
            isDomestic,
            isCloud,
            region: regionKey,
            provider: providerMatch,
            source: result.source,
            location: `${result.country} (${result.org || 'Unknown'})`,
            cloudProvider: result.cloud_provider
        });
    }

    return {
        summary,
        details,
        comparisons: []
    };
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
            source: 'ipinfo json api (direct)'
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

    const detail = {
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
        category: resilience.details.find(d => d.domain === result.domain)?.category
    };

    // 只有在 cloud_provider 不為 null 時才加入
    if (result.cloud_provider) {
        detail.cloud_provider = result.cloud_provider;
    }

    return detail;
}

async function checkWebsiteResilience(url, options = {}) {
    // 在函數開始時初始化變數，以便在 catch 區塊中使用
    let inputURL = url;
    let canonicalURL = null;
    let requests = [];
    let localIPInfo = null;
    let customDNS = null;
    let httpStatus = null;

    // 檢查原始 URL 是否為頂層網域（用於決定檔名生成時是否使用 canonical）
    let isTopLevelDomain = false;
    try {
        const originalUrlObj = new URL(url.startsWith('http://') || url.startsWith('https://') ? url : 'https://' + url);
        const originalPath = originalUrlObj.pathname || '';
        isTopLevelDomain = originalPath === '' || originalPath === '/';
    } catch {
        // 若 URL 解析失敗，預設為 false
    }

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
        let harResult = null;
        let retriedWithWww = false;
        let retriedWithHeadful = false;
        // 保存原始 URL，用於 non-headless 重試時從原始版本開始
        const originalUrl = url;
        // 檢查是否需要嘗試 www 版本
        let shouldRetryWithWww = false;
        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname;
            // 如果沒有 www 前綴，則可以嘗試 www 版本
            if (!hostname.startsWith('www.')) {
                shouldRetryWithWww = true;
            }
        } catch {
            // URL 解析失敗，不重試
        }

        // 重試流程：
        // 如果指定了 headless=false，直接使用非 headless 模式
        // 否則：1. 一般版本（headless） -> 2. 一般版本 prefix www -> 3. 非 headless 版本 -> 4. 非 headless 版本 prefix www
        let lastError = null;

        if (options.headless === false) {
            // 強制使用非 headless 模式，跳過 headless 重試流程
            // 重試流程：1. non-headless non-www -> 2. non-headless www
            try {
                harResult = await collectHARAndCanonical(url, {
                    timeout: options.timeout || 120000,
                    debug: options.debug,
                    headless: false
                });
            } catch (error) {
                lastError = error;

                // 如果失敗，嘗試 non-headless www
                if (shouldRetryWithWww && !harResult) {
                    try {
                        const urlObj = new URL(url);
                        urlObj.hostname = 'www.' + urlObj.hostname;
                        const wwwUrl = urlObj.toString();

                        console.log(`發生錯誤，嘗試使用 www. 版本（非 headless 模式）: ${wwwUrl}`);
                        retriedWithWww = true;

                        harResult = await collectHARAndCanonical(wwwUrl, {
                            timeout: options.timeout || 120000,
                            debug: options.debug,
                            headless: false
                        });
                        // 如果成功，更新 url 和 inputURL
                        if (harResult) {
                            url = wwwUrl;
                            inputURL = wwwUrl;
                        }
                    } catch (finalError) {
                        throw finalError;
                    }
                } else if (!harResult) {
                    throw error;
                }
            }
        } else {
            // 預設重試流程：1. headless non-www -> 2. headless www -> 3. non-headless non-www -> 4. non-headless www
            // 如果其中一個成功即停止，如失敗則進入下一個
            // 1. 嘗試 headless non-www
            try {
                harResult = await collectHARAndCanonical(url, {
                    timeout: options.timeout || 120000,
                    debug: options.debug,
                    headless: true
                });
            } catch (error) {
                lastError = error;

                // 2. 如果失敗，嘗試 headless www
                if (shouldRetryWithWww && !harResult) {
                    try {
                        const urlObj = new URL(url);
                        urlObj.hostname = 'www.' + urlObj.hostname;
                        const wwwUrl = urlObj.toString();

                        console.log(`發生錯誤，嘗試使用 www. 版本（headless 模式）: ${wwwUrl}`);
                        retriedWithWww = true;

                        harResult = await collectHARAndCanonical(wwwUrl, {
                            timeout: options.timeout || 120000,
                            debug: options.debug,
                            headless: true
                        });
                        // 如果成功，更新 url 和 inputURL
                        if (harResult) {
                            url = wwwUrl;
                            inputURL = wwwUrl;
                        }
                    } catch (wwwError) {
                        lastError = wwwError;
                    }
                }

                // 3. 如果還是失敗，嘗試 non-headless non-www
                if (!harResult) {
                    try {
                        console.log(`發生錯誤，嘗試使用非 headless 模式重試: ${originalUrl}`);
                        retriedWithHeadful = true;

                        harResult = await collectHARAndCanonical(originalUrl, {
                            timeout: options.timeout || 120000,
                            debug: options.debug,
                            headless: false
                        });
                        // 如果成功，更新 url 和 inputURL
                        if (harResult) {
                            url = originalUrl;
                            inputURL = originalUrl;
                        }
                    } catch (headfulError) {
                        lastError = headfulError;

                        // 4. 如果還是失敗，嘗試 non-headless www
                        if (shouldRetryWithWww && !harResult) {
                            try {
                                const urlObj = new URL(originalUrl);
                                urlObj.hostname = 'www.' + urlObj.hostname;
                                const wwwUrl = urlObj.toString();

                                console.log(`發生錯誤，嘗試使用 www. 版本（非 headless 模式）: ${wwwUrl}`);
                                retriedWithWww = true;

                                harResult = await collectHARAndCanonical(wwwUrl, {
                                    timeout: options.timeout || 120000,
                                    debug: options.debug,
                                    headless: false
                                });
                                // 如果成功，更新 url 和 inputURL
                                if (harResult) {
                                    url = wwwUrl;
                                    inputURL = wwwUrl;
                                }
                            } catch (finalError) {
                                // 所有重試都失敗，拋出最後的錯誤
                                throw finalError;
                            }
                        } else if (!harResult) {
                            // 不需要嘗試 www 版本，直接拋出錯誤
                            throw headfulError;
                        }
                    }
                }

                // 如果所有重試都失敗，拋出最後的錯誤
                if (!harResult) {
                    throw lastError;
                }
            }
        }

        requests = harResult.requests || [];
        canonicalURL = harResult.canonical || null;
        httpStatus = harResult.httpStatus || null;

        if (retriedWithHeadful) {
            console.log(`成功使用非 headless 模式進行測試`);
        }
        if (retriedWithWww) {
            console.log(`成功使用 www. 版本進行測試`);
        }

        if (canonicalURL && canonicalURL !== url) {
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
        if (options.debug && !localIPInfo.error) {
            console.log('\n[DEBUG] 測試環境資訊:');
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
                    adblockUrls: getAdblockUrlsForResult(options),
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

        // 3. 建立 domain 到 URL 的映射，以便找到對應的 headers
        const domainToUrlMap = new Map();
        Object.values(cleanedData).forEach(req => {
            try {
                const urlObj = new URL(req.url);
                const hostname = urlObj.hostname;
                if (!domainToUrlMap.has(hostname)) {
                    domainToUrlMap.set(hostname, req.url);
                }
            } catch {
                // 忽略 URL 解析錯誤
            }
        });

        // 4. 檢查每個域名
        if (options.debug) {
            console.log('\n[DEBUG] 開始檢查域名 IP 位置...');
        }
        const locationResults = await Promise.all(
            domains.map(async (domain) => {
                if (options.debug) {
                    console.log(`[DEBUG] 檢查 ${domain}...`);
                }

                // 找到對應的 URL
                const domainUrl = domainToUrlMap.get(domain);

                const result = await checkIPLocation(domain, customDNS, {
                    useCache: options.useCache !== false,
                    token: options.token,
                    debug: options.debug,
                    responseHeaders: harResult.responseHeaders,
                    domainUrl: domainUrl
                });

                if (options.debug) {
                    const method = result.cloud_provider?.detection_method || 'ipinfo';
                    console.log(`[DEBUG] ${domain}: ${result.ip || 'N/A'} (${result.country || 'N/A'}) [${method}] ${result.source?.includes('cached') ? '(快取)' : ''}`);
                }
                return result;
            })
        );

        // 5. 計算韌性分數
        const cloudProviderInfo = await loadcloudProviderInfo();
        const resilience = checkLocally(locationResults, cloudProviderInfo);

        // 6. 產生報告
        console.log('\n檢測結果:');
        console.log('-------------------');
        console.log(`境內/雲端: ${resilience.summary.domestic.cloud}`);
        console.log(`境內/直連: ${resilience.summary.domestic.direct}`);
        console.log(`境外/雲端: ${resilience.summary.foreign.cloud}`);
        console.log(`境外/直連: ${resilience.summary.foreign.direct}`);

        if (options.debug) {
            console.log('\n[DEBUG] 詳細域名資訊:');
            console.log('-------------------');
            locationResults.forEach(result => {
                console.log(`\n${result.domain}:`);
                console.log(formatDomainDetail(result, cleanedData, resilience));
            });
        }

        // 準備結果資料
        const result = {
            url: inputURL,           // 使用原始輸入的 URL
            canonicalURL,            // 保存實際訪問的 URL
            httpStatus,              // HTTP 響應狀態碼
            timestamp: new Date().toISOString(),
            testParameters: {
                customDNS: customDNS || null,
                useAdblock: options.useAdblock !== false,
                adblockUrls: getAdblockUrlsForResult(options),
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
            test_results: resilience.summary,
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
            await fs.mkdir('test-results', { recursive: true });

            // 自動生成輸出檔名
            // 如果原始 URL 是頂層網域，使用原始 URL；否則使用 canonical URL（如果有的話）
            const urlForFilename = (isTopLevelDomain || !canonicalURL) ? url : canonicalURL;
            const urlObj = new URL(urlForFilename);
            let filename = `${urlObj.hostname}${urlObj.pathname.replace(/\//g, '_')}${
                urlObj.search ? '_' + urlObj.search.replace(/[?&=]/g, '_') : ''
            }`.replace(/_+$/, '');

            // 如果檔名太長，直接截斷到 95 字元
            if (filename.length > 95) {
                filename = filename.slice(0, 95);
            }

            const outputPath = path.resolve(`test-results/${filename}.json`);

            // 儲存結果
            await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
            console.log(`\n結果已儲存至: ${outputPath}`);

            // 檢查並刪除對應的錯誤檔案（如果存在）
            // 同時檢查並刪除 www 和非 www 版本的錯誤檔案
            try {
                const errorDir = path.join('test_results', '_error');
                const hostname = urlObj.hostname;

                // 生成兩個可能的檔名（www 和非 www 版本）
                const possibleFilenames = [];

                // 當前 hostname 的檔名
                possibleFilenames.push(filename);

                // 如果是 www 版本，也檢查非 www 版本
                if (hostname.startsWith('www.')) {
                    const nonWwwHostname = hostname.slice(4); // 移除 'www.'
                    let nonWwwFilename = `${nonWwwHostname}${urlObj.pathname.replace(/\//g, '_')}${
                        urlObj.search ? '_' + urlObj.search.replace(/[?&=]/g, '_') : ''
                    }`.replace(/_+$/, '');
                    if (nonWwwFilename.length > 95) {
                        nonWwwFilename = nonWwwFilename.slice(0, 95);
                    }
                    possibleFilenames.push(nonWwwFilename);
                } else {
                    // 如果是非 www 版本，也檢查 www 版本
                    const wwwHostname = 'www.' + hostname;
                    let wwwFilename = `${wwwHostname}${urlObj.pathname.replace(/\//g, '_')}${
                        urlObj.search ? '_' + urlObj.search.replace(/[?&=]/g, '_') : ''
                    }`.replace(/_+$/, '');
                    if (wwwFilename.length > 95) {
                        wwwFilename = wwwFilename.slice(0, 95);
                    }
                    possibleFilenames.push(wwwFilename);
                }

                // 嘗試刪除所有可能的錯誤檔案
                for (const possibleFilename of possibleFilenames) {
                    const errorFilePath = path.resolve(path.join(errorDir, `${possibleFilename}.error.json`));
                    try {
                        await fs.access(errorFilePath);
                        // 檔案存在，刪除它
                        await fs.unlink(errorFilePath);
                        console.log(`✓ 已刪除舊的錯誤檔案: ${possibleFilename}.error.json`);
                    } catch {
                        // 檔案不存在，不需要處理
                    }
                }
            } catch (deleteError) {
                console.warn(`無法檢查/刪除錯誤檔案: ${deleteError.message}`);
            }
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
            // 檢查是否為 HTTP 4xx 錯誤
            const isHttp4xx = error.message && /^HTTP 4\d{2}/.test(error.message);
            const httpStatusMatch = error.message?.match(/^HTTP (\d{3})/);

            // 檢查是否為 net error（如 ERR_ADDRESS_UNREACHABLE, ERR_NAME_NOT_RESOLVED 等）
            const netErrorMatch = error.message?.match(/net::(ERR_[A-Z_]+)/);
            const netErrorCode = netErrorMatch ? netErrorMatch[1] : null;

            // 如果有從錯誤訊息中提取的狀態碼，優先使用；否則使用已取得的 httpStatus
            const errorHttpStatus = httpStatusMatch ? parseInt(httpStatusMatch[1], 10) : httpStatus;

            // 確保 URL 有 protocol（用於建立檔名）
            // 如果原始 URL 是頂層網域，使用原始 URL；否則使用 canonical URL（如果有的話）
            let urlForFilename = inputURL;
            if (urlForFilename && !urlForFilename.startsWith('http://') && !urlForFilename.startsWith('https://')) {
                urlForFilename = 'https://' + urlForFilename;
            }

            // 如果不是頂層網域且有 canonical URL，使用 canonical URL 來生成檔名
            if (!isTopLevelDomain && canonicalURL) {
                urlForFilename = canonicalURL;
            }

            errorResult = {
                url: inputURL,
                canonicalURL: canonicalURL || urlForFilename,
                httpStatus: errorHttpStatus,
                timestamp: new Date().toISOString(),
                testParameters: {
                    customDNS: customDNS || null,
                    useAdblock: options.useAdblock !== false,
                    adblockUrls: getAdblockUrlsForResult(options),
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
                errorReason: isHttp4xx
                    ? `HTTP ${httpStatusMatch ? httpStatusMatch[1] : '4xx'} Error`
                    : netErrorCode
                        ? netErrorCode
                        : isTimeout
                            ? 'Timeout'
                            : `Error: ${error.name || 'Unknown'}`,
                errorDetails: {
                    message: error.message,
                    statusCode: httpStatusMatch ? httpStatusMatch[1] : null
                }
            };
        }

        console.error(`檢測到測試錯誤: ${errorResult.errorReason || error.message}`);

        // 將 result 附加到 error 物件上，讓 batch-test.js 可以讀取
        error.result = errorResult;

        // 儲存錯誤結果到 JSON 檔案
        if (options.save) {
            try {
                // 確保 test-results/_error 目錄存在
                const errorDir = path.join('test-results', '_error');
                await fs.mkdir(errorDir, { recursive: true });

                // 從錯誤結果中取得 URL 資訊
                // 如果原始 URL 是頂層網域，使用原始 URL；否則使用 canonical URL（如果有的話）
                let urlToUse = errorResult.url;
                if (!isTopLevelDomain && errorResult.canonicalURL) {
                    urlToUse = errorResult.canonicalURL;
                }
                const urlObj = new URL(urlToUse);
                let filename = `${urlObj.hostname}${urlObj.pathname.replace(/\//g, '_')}${
                    urlObj.search ? '_' + urlObj.search.replace(/[?&=]/g, '_') : ''
                }`.replace(/_+$/, '');

                // 如果檔名太長，直接截斷到 95 字元（預留 .error.json 的空間）
                if (filename.length > 95) {
                    filename = filename.slice(0, 95);
                }

                const outputPath = path.resolve(path.join(errorDir, `${filename}.error.json`));

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
    let timeout = 120000; // 預設 120 秒
    let headless = undefined; // 預設為 undefined，使用自動重試邏輯

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

    // 解析 timeout 參數
    const timeoutIndex = args.indexOf('--timeout');
    if (timeoutIndex !== -1 && args[timeoutIndex + 1]) {
        timeout = parseInt(args[timeoutIndex + 1], 10) * 1000; // 轉換為毫秒
    }

    // 檢查是否要儲存結果
    save = args.includes('--save');

    // 檢查是否要開啟 debug 模式
    debug = args.includes('--debug');

    // 解析 adblock 選項：--adblock true/false（預設為 true）
    const adblockIndex = args.indexOf('--adblock');
    if (adblockIndex !== -1 && args[adblockIndex + 1]) {
        const adblockValue = args[adblockIndex + 1].toLowerCase();
        if (adblockValue === 'false' || adblockValue === '0') {
            useAdblock = false;
        } else if (adblockValue === 'true' || adblockValue === '1') {
            useAdblock = true;
        }
    }
    // 如果未指定，保持預設值 true

    // 解析自訂 adblock 清單 URL
    const adblockUrlIndex = args.indexOf('--adblock-url');
    if (adblockUrlIndex !== -1) {
        // 支援多個 URL，用逗號分隔或多次指定
        const urlArg = args[adblockUrlIndex + 1];
        if (urlArg) {
            adblockUrls = urlArg.split(',').map(u => u.trim());
        }
    }

    // 解析快取選項：--cache true/false（預設為 true）
    const cacheIndex = args.indexOf('--cache');
    if (cacheIndex !== -1 && args[cacheIndex + 1]) {
        const cacheValue = args[cacheIndex + 1].toLowerCase();
        if (cacheValue === 'false' || cacheValue === '0') {
            useCache = false;
        } else if (cacheValue === 'true' || cacheValue === '1') {
            useCache = true;
        }
    }
    // 如果未指定，保持預設值 true

    // 解析 headless 選項：--headless true/false（預設為 true）
    const headlessIndex = args.indexOf('--headless');
    if (headlessIndex !== -1 && args[headlessIndex + 1]) {
        const headlessValue = args[headlessIndex + 1].toLowerCase();
        if (headlessValue === 'false' || headlessValue === '0') {
            headless = false;
        } else if (headlessValue === 'true' || headlessValue === '1') {
            headless = true;
        }
    } else {
        // 預設為 true（headless 模式）
        headless = true;
    }

    if (!url || url.startsWith('--')) {
        console.error('請提供要檢測的網址');
        console.error('使用方式:');
        console.error('  npm run check [--dns 8.8.8.8] [--save] https://example.com');
        console.error('  npm run check [--dns 8.8.8.8] [--ipinfo-token your-token] [--save] https://example.com');
        console.error('  npm run check [--adblock false] https://example.com  # 不使用 adblock 篩選連線紀錄（預設為使用）');
        console.error('  npm run check [--adblock-url url1,url2] https://example.com  # 使用自訂 adblock 清單');
        console.error('  npm run check [--debug] https://example.com  # debug 模式，顯示詳細資訊');
        console.error('  npm run check [--cache false] https://example.com  # 不使用快取，強制重新下載 adblock 清單與 ipinfo 資料（預設 true）');
        console.error('  npm run check [--timeout N] https://example.com  # 設定頁面載入 timeout（秒，預設 120）');
        console.error('  npm run check [--headless false] https://example.com  # 取消 headless 模式，顯示瀏覽器視窗（預設為 headless 模式）');
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
        useCache,
        timeout,
        headless
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
