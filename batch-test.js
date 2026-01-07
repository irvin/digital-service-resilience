#!/usr/bin/env node

/**
 * 批量測試腳本
 * 讀取指定的網站清單 JSON 檔案
 * 並針對前 N 個網站進行韌性檢測
 */

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { checkWebsiteResilience } = require('./no-global-connection-check');
const { main: generateStatistic } = require('./generate_statistic');

// 預設參數
const DEFAULT_DELAY = 1000; // 每個請求之間的延遲（毫秒）
const DEFAULT_CONCURRENCY = 4; // 預設並行度

function formatCommandLineDisplay(argv) {
    if (!Array.isArray(argv) || argv.length === 0) {
        return '';
    }

    const nodeBinary = path.basename(argv[0] || '');
    const displayNode = nodeBinary === 'node' || nodeBinary === 'node.exe' ? 'node' : argv[0];

    let scriptPath = argv[1] || '';
    if (scriptPath) {
        const relativePath = path.relative(process.cwd(), scriptPath);
        if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
            scriptPath = relativePath;
        }
    }

    const displayArgs = [displayNode, scriptPath, ...argv.slice(2)].filter(Boolean);

    // 格式化命令列參數
    return displayArgs.map((arg) => {
        if (/^[A-Za-z0-9_/.\-=:]+$/.test(arg)) {
            return arg;
        }
        return `'${arg.replace(/'/g, `'\\''`)}'`;
    }).join(' ');
}

/**
 * 讀取網站清單
 * 支援兩種格式：
 * 1. 普通網站清單：直接是陣列格式
 * 2. 錯誤 log 檔案：包含 errorSites 欄位的物件
 */
async function loadWebsiteList(testListPath) {
    const filePath = path.isAbsolute(testListPath)
        ? testListPath
        : path.join(__dirname, testListPath);
    const data = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data);

    // 檢查是否為錯誤 log 格式（包含 errorSites 欄位）
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.errorSites) {
        console.log(`偵測到錯誤 log 格式，將重新測試 ${parsed.errorSites.length} 個錯誤網站`);
        return parsed.errorSites;
    }

    // 普通清單格式（陣列）
    if (Array.isArray(parsed)) {
        return parsed;
    }

    // 如果都不符合，拋出錯誤
    throw new Error('無法識別的檔案格式：必須是網站清單陣列或包含 errorSites 的錯誤 log 物件');
}

/**
 * 延遲函數
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 批量測試網站
 */
async function batchTest(options = {}) {
    const {
        limit = undefined,
        delayMs = DEFAULT_DELAY,
        startFrom = 0,
        concurrency = DEFAULT_CONCURRENCY,
        save = true,
        customDNS = null,
        token = null,
        useAdblock = true,
        adblockUrls = [],
        useCache = true,
        headless = undefined,
        testListPath,
        debug = false,
        timeout = 120000,
        argument = null
    } = options;

    if (!testListPath) {
        throw new Error('必須提供測試清單檔案路徑');
    }

    console.log('='.repeat(60));
    console.log('批量韌性檢測開始');
    console.log('='.repeat(60));
    console.log(`測試清單: ${testListPath}`);
    console.log(`測試數量: ${limit !== undefined ? limit : '全部'}`);
    console.log(`並行度: ${concurrency}`);
    console.log(`起始位置: ${startFrom}`);
    console.log(`請求延遲: ${delayMs}ms`);
    console.log('='.repeat(60));
    console.log('');

    // 讀取網站清單
    console.log('正在讀取網站清單...');
    const websites = await loadWebsiteList(testListPath);
    console.log(`共找到 ${websites.length} 個網站\n`);

    // 取得要測試的網站（從 startFrom 開始，如果 limit 有指定則取 limit 個，否則測試全部）
    const testTargets = limit !== undefined
        ? websites.slice(startFrom, startFrom + limit)
        : websites.slice(startFrom);
    console.log(`將測試 ${testTargets.length} 個網站\n`);

    // 統計資訊
    const stats = {
        total: testTargets.length,
        success: 0,
        failed: 0,
        skipped: 0,
        errorSites: [],
        results: []
    };

    // 3. 以限制並行度的方式開始測試
    const workerCount = Math.max(1, Math.min(concurrency, testTargets.length || 1));
    console.log(`實際並行度: ${workerCount}`);

    let currentIndex = 0;

    async function runWorker(workerId) {
        while (true) {
            const i = currentIndex++;
            if (i >= testTargets.length) break;

            const website = testTargets[i];
            const globalIndex = startFrom + i + 1;
            const progress = `[${globalIndex}/${startFrom + testTargets.length}]`;

            console.log('\n' + '-'.repeat(60));
            console.log(`${progress} (Worker ${workerId}) 測試: ${website.website}`);
            console.log(`URL: ${website.url}`);
            console.log(`排名:`, website.rank);
            console.log('-'.repeat(60));

            try {
                // 執行檢測，直接使用 checkWebsiteResilience 的儲存功能
                const result = await checkWebsiteResilience(website.url, {
                    customDNS,
                    token,
                    save: save,
                    useAdblock,
                    adblockUrls,
                    useCache,
                    headless,
                    debug,
                    timeout
                });

                // 記錄統計
                stats.success++;
                const testResults = result.test_results || {
                    domestic: { cloud: 0, direct: 0 },
                    foreign: { cloud: 0, direct: 0 }
                };
                stats.results.push({
                    website: website.website,
                    url: website.url,
                    rank: website.rank,
                    status: 'success',
                    result: testResults
                });

                const domestic = testResults.domestic || { cloud: 0, direct: 0 };
                const foreign = testResults.foreign || { cloud: 0, direct: 0 };
                console.log(`✓ 測試完成 (Worker ${workerId}): 境內/雲端=${domestic.cloud}, 境內/直連=${domestic.direct}, 境外/雲端=${foreign.cloud}, 境外/直連=${foreign.direct}`);
            } catch (error) {
                // 只要有 errorReason，就視為「測試錯誤」，其餘視為一般失敗
                const errResult = error.result || error;
                if (errResult?.errorReason) {
                    console.log(`⚠ 測試錯誤 (Worker ${workerId}): ${errResult.errorReason}`);
                    stats.errorSites.push({
                        website: website.website,
                        url: website.url,
                        rank: website.rank,
                        errorReason: errResult.errorReason,
                        errorDetails: errResult.errorDetails
                    });
                    stats.results.push({
                        website: website.website,
                        url: website.url,
                        rank: website.rank,
                        status: 'error',
                        errorReason: errResult.errorReason,
                        errorDetails: errResult.errorDetails
                    });
                } else {
                    console.error(`✗ 測試失敗 (Worker ${workerId}): ${error.message}`);
                    stats.failed++;
                    stats.results.push({
                        website: website.website,
                        url: website.url,
                        rank: website.rank,
                        status: 'failed',
                        error: error.message
                    });
                }
            }

            // 在每個 worker 的任務之間加入延遲（如果需要）
            if (delayMs > 0 && i < testTargets.length - 1) {
                console.log(`Worker ${workerId} 等待 ${delayMs}ms 後繼續...`);
                await delay(delayMs);
            }
        }
    }

    const workers = [];
    for (let w = 0; w < workerCount; w++) {
        workers.push(runWorker(w + 1));
    }

    await Promise.all(workers);

    // 輸出總結報告
    console.log('\n' + '='.repeat(60));
    console.log('批量檢測完成');
    console.log('='.repeat(60));
    console.log(`總數: ${stats.total}`);
    console.log(`成功: ${stats.success}`);
    console.log(`失敗: ${stats.failed}`);
    console.log(`測試錯誤: ${stats.errorSites.length}`);
    console.log(`跳過: ${stats.skipped}`);
    console.log('='.repeat(60));

    // 儲存總結報告
    if (save) {
        const timestamp = Date.now();

        // 確保 test_results/_logs 目錄存在
        const logsDir = path.join('test_results', '_logs');
        await fs.mkdir(logsDir, { recursive: true });

        const summaryPath = path.join(logsDir, `batch_summary_${timestamp}.json`);
        const summary = {
            timestamp: new Date().toISOString(),
            argument: argument || formatCommandLineDisplay(process.argv),
            options: {
                testListPath,
                limit,
                startFrom,
                delayMs,
                concurrency,
                customDNS,
                useAdblock,
                adblockUrls,
                useCache,
                headless,
                timeout
            },
            statistics: {
                total: stats.total,
                success: stats.success,
                failed: stats.failed,
                testErrors: stats.errorSites.length,
                skipped: stats.skipped
            },
            results: stats.results,
            errorSites: stats.errorSites
        };

        await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
        console.log(`\n總結報告已儲存: ${summaryPath}`);

        // 如果有錯誤網站，輸出獨立的錯誤網站清單
        if (stats.errorSites.length > 0) {
            const errorListPath = path.join(logsDir, `batch_errors_${timestamp}.json`);
            const errorList = {
                timestamp: new Date().toISOString(),
                totalErrors: stats.errorSites.length,
                errorSites: stats.errorSites
            };

            await fs.writeFile(errorListPath, JSON.stringify(errorList, null, 2));
            console.log(`錯誤網站清單已儲存: ${errorListPath}`);
        }

        // 自動生成統計資料
        try {
            console.log('\n正在生成統計資料...');
            await generateStatistic();
        } catch (statError) {
            console.warn('生成統計資料失敗:', statError.message);
            // 不影響主流程，只顯示警告
        }
    }

    return stats;
}

// 如果直接執行此檔案
if (require.main === module) {
    const args = process.argv.slice(2);

    // 解析命令列參數
    let limit;
    let startFrom = 0;
    let delayMs = DEFAULT_DELAY;
    let concurrency = DEFAULT_CONCURRENCY;
    let customDNS = null;
    let token = null;
    let useAdblock = true;
    let adblockUrls = [];
    let useCache = true;
    let headless = undefined;
    let debug = false;
    let timeout = 120000; // 預設 120 秒

    // 解析 --limit
    const limitIndex = args.indexOf('--limit');
    if (limitIndex !== -1 && args[limitIndex + 1]) {
        limit = parseInt(args[limitIndex + 1], 10);
    }

    // 解析 --start-from
    const startIndex = args.indexOf('--start-from');
    if (startIndex !== -1 && args[startIndex + 1]) {
        startFrom = parseInt(args[startIndex + 1], 10);
    }

    // 解析 --delay
    const delayIndex = args.indexOf('--delay');
    if (delayIndex !== -1 && args[delayIndex + 1]) {
        delayMs = parseInt(args[delayIndex + 1], 10);
    }

    // 解析 --concurrency
    const concurrencyIndex = args.indexOf('--concurrency');
    if (concurrencyIndex !== -1 && args[concurrencyIndex + 1]) {
        concurrency = parseInt(args[concurrencyIndex + 1], 10);
    }

    // 解析 --dns
    const dnsIndex = args.indexOf('--dns');
    if (dnsIndex !== -1 && args[dnsIndex + 1]) {
        customDNS = args[dnsIndex + 1];
    }

    // 解析 --ipinfo-token
    const tokenIndex = args.indexOf('--ipinfo-token');
    if (tokenIndex !== -1 && args[tokenIndex + 1]) {
        token = args[tokenIndex + 1];
    }

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

    // 解析 --adblock-url
    const adblockUrlIndex = args.indexOf('--adblock-url');
    if (adblockUrlIndex !== -1 && args[adblockUrlIndex + 1]) {
        adblockUrls = args[adblockUrlIndex + 1].split(',').map(u => u.trim());
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

    // 解析 --debug
    debug = args.includes('--debug');

    // 解析 --timeout
    const timeoutIndex = args.indexOf('--timeout');
    if (timeoutIndex !== -1 && args[timeoutIndex + 1]) {
        timeout = parseInt(args[timeoutIndex + 1], 10) * 1000; // 轉換為毫秒
    }

    // 驗證參數：檢查是否有無效的參數
    const validOptions = [
        '--limit', '--start-from', '--delay', '--concurrency',
        '--dns', '--ipinfo-token', '--adblock', '--adblock-url',
        '--cache', '--headless', '--debug', '--timeout', '--help', '-h'
    ];
    const optionsWithValue = [
        '--limit', '--start-from', '--delay', '--concurrency',
        '--dns', '--ipinfo-token', '--adblock', '--adblock-url',
        '--cache', '--headless', '--timeout'
    ];

    const invalidArgs = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        // 檢查是否是以 - 開頭的參數
        if (arg.startsWith('-')) {
            // 如果是有效參數，且需要值，則跳過下一個參數（值）
            if (validOptions.includes(arg)) {
                if (optionsWithValue.includes(arg)) {
                    i++; // 跳過下一個參數（值）
                }
            } else {
                // 無效參數
                invalidArgs.push(arg);
            }
        }
    }

    // 如果有無效參數，顯示錯誤並退出
    if (invalidArgs.length > 0) {
        console.error('錯誤: 發現無效的參數:');
        for (const arg of invalidArgs) {
            console.error(`  ${arg}`);
        }
        console.error('');
        console.error('使用方式: node batch-test.js [選項] <測試清單檔案路徑>');
        console.error('使用 --help 或 -h 查看詳細說明');
        process.exit(1);
    }

    // 從最後一個參數讀取測試清單路徑（必須不是以 -- 開頭的選項）
    let testListPath = null;
    for (let i = args.length - 1; i >= 0; i--) {
        if (!args[i].startsWith('--')) {
            testListPath = args[i];
            break;
        }
    }

    // 顯示使用說明
    if (args.includes('--help') || args.includes('-h')) {
        console.log('批量測試腳本使用方式:');
        console.log('');
        console.log('node batch-test.js [選項] <測試清單檔案路徑>');
        console.log('');
        console.log('選項:');
        console.log('  --limit N              測試 N 個網站（預設: 全部）');
        console.log('  --start-from N         從第 N 個網站開始（預設: 0）');
        console.log('  --delay N              每個請求之間的延遲，單位毫秒（預設: 1000）');
        console.log('  --concurrency N        同時進行的最大測試數（預設: 4）');
        console.log('  --dns IP               使用自訂 DNS 伺服器');
        console.log('  --ipinfo-token TOKEN   指定 IPinfo API token');
        console.log('  --adblock false        不使用 adblock 清單（預設為使用）');
        console.log('  --adblock-url URL      使用自訂 adblock 清單 URL（可用逗號分隔多個）');
        console.log('  --cache false          不使用快取，強制重新下載 adblock 清單與 ipinfo 資料（預設 true）');
        console.log('  --headless false       取消 headless 模式，顯示瀏覽器視窗（預設為 headless 模式 true）');
        console.log('  --debug                開啟 debug 模式，顯示詳細資訊');
        console.log('  --timeout N            設定頁面載入 timeout（秒，預設 120）');
        console.log('  --help, -h             顯示此說明');
        console.log('');
        console.log('範例:');
        console.log('  node batch-test.js --limit 10 top-traffic-list-taiwan/merged_lists_tw.json');
        console.log('  node batch-test.js --limit 50 --start-from 10 --delay 3000 top-traffic-list-taiwan/merged_lists_tw.json');
        console.log('  node batch-test.js --limit 100 --dns 8.8.8.8 --ipinfo-token your_token top-traffic-list-taiwan/merged_lists_tw.json');
        console.log('  node batch-test.js --debug --adblock-url https://filter.futa.gg/hosts_abp.txt --limit 10 top-traffic-list-taiwan/merged_lists_tw.json');
        process.exit(0);
    }

    // 檢查是否提供了測試清單路徑
    if (!testListPath) {
        console.error('錯誤: 必須提供測試清單檔案路徑');
        console.error('');
        console.error('使用方式: node batch-test.js [選項] <測試清單檔案路徑>');
        console.error('使用 --help 或 -h 查看詳細說明');
        process.exit(1);
    }

    // 執行批量測試
    batchTest({
        limit,
        startFrom,
        delayMs,
        concurrency,
        customDNS,
        token,
        useAdblock,
        adblockUrls,
        useCache,
        headless,
        testListPath,
        debug,
        timeout,
        argument: formatCommandLineDisplay(process.argv)
    }).catch(error => {
        console.error('批量測試失敗:', error);
        if (debug) {
            console.error('錯誤堆疊:', error.stack);
        }
        process.exit(1);
    });
}

module.exports = { batchTest };
