const fs = require('fs');
const path = require('path');

// 以目前腳本所在位置為基準，找到 test_results 目錄
const DIR = path.resolve(__dirname, 'test_results');
const OUTPUT = path.join(DIR, 'statistic.tsv');
const MERGED_LISTS_PATH = path.resolve(
  __dirname,
  'top-traffic-list-taiwan',
  'merged_lists_tw.json',
);

// 正規化 URL 以便比對（移除 protocol、trailing slash、www. 前綴、轉小寫）
function normalizeUrl(url) {
  if (!url) return '';
  let normalized = url
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '')
    .toLowerCase();

  // 移除 www. 前綴（僅當開頭是 www. 時）
  if (normalized.startsWith('www.')) {
    normalized = normalized.substring(4);
  }

  return normalized;
}

async function main() {
  // 讀取 merged_lists_tw.json 建立順序映射
  const orderMap = new Map();
  const orderedUrls = [];
  try {
    const mergedListsContent = await fs.promises.readFile(
      MERGED_LISTS_PATH,
      'utf8',
    );
    const mergedLists = JSON.parse(mergedListsContent);
    mergedLists.forEach((item, index) => {
      const url = item.url || `https://${item.website}`;
      const normalized = normalizeUrl(url);
      orderMap.set(normalized, index);
      orderedUrls.push(normalized);
    });
  } catch (err) {
    console.error(
      `無法讀取 merged_lists_tw.json：${err.message}，將使用檔案名稱排序`,
    );
  }

  const entries = await fs.promises.readdir(DIR, { withFileTypes: true });

  // 只取目錄下的 JSON 檔案（不含子目錄）
  const jsonFiles = entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.toLowerCase().endsWith('.json') &&
        !e.name.startsWith('.') // 排除 .DS_Store 等
    )
    .map((e) => e.name);

  // 收集所有資料
  const dataMap = new Map();

  for (const file of jsonFiles) {
    const fullPath = path.join(DIR, file);
    let data;

    try {
      const content = await fs.promises.readFile(fullPath, 'utf8');
      data = JSON.parse(content);
    } catch (err) {
      console.error(`無法讀取或解析 JSON：${file}`, err.message);
      continue;
    }

    const url = data.url ?? '';
    const normalizedUrl = normalizeUrl(url);
    const timestamp = data.timestamp ?? '';
    const domesticCloud = data.test_results?.domestic?.cloud ?? 0;
    const domesticDirect = data.test_results?.domestic?.direct ?? 0;
    const foreignCloud = data.test_results?.foreign?.cloud ?? 0;
    const foreignDirect = data.test_results?.foreign?.direct ?? 0;

    const totalDomestic = domesticCloud + domesticDirect;
    const totalForeign = foreignCloud + foreignDirect;
    const totalCloud = domesticCloud + foreignCloud;
    const totalDirect = domesticDirect + foreignDirect;
    const resilience =
      totalDomestic > 0 && totalForeign === 0 ? 1 : 0;

    dataMap.set(normalizedUrl, {
      url,
      timestamp,
      domesticCloud,
      domesticDirect,
      totalDomestic,
      foreignCloud,
      foreignDirect,
      totalForeign,
      totalCloud,
      totalDirect,
      resilience,
    });
  }

  // 按照 merged_lists_tw.json 的順序排序
  const sortedData = orderedUrls
    .filter((normalizedUrl) => dataMap.has(normalizedUrl))
    .map((normalizedUrl) => dataMap.get(normalizedUrl));

  // 如果 merged_lists_tw.json 中沒有，但 test_results 中有，則附加在最後
  const remainingData = Array.from(dataMap.entries())
    .filter(([normalizedUrl]) => !orderMap.has(normalizedUrl))
    .map(([, data]) => data);

  const allData = [...sortedData, ...remainingData];

  const lines = [];

  // 標題列
  lines.push(
    [
      'url',
      'timestamp',
      'results_domestic_cloud',
      'results_domestic_direct',
      'total_domestic',
      'results_foreign_cloud',
      'results_foreign_direct',
      'total_foreign',
      'total_cloud',
      'total_direct',
      'resilience',
    ].join('\t'),
  );

  // 輸出資料
  for (const data of allData) {
    lines.push(
      [
        String(data.url),
        String(data.timestamp),
        String(data.domesticCloud),
        String(data.domesticDirect),
        String(data.totalDomestic),
        String(data.foreignCloud),
        String(data.foreignDirect),
        String(data.totalForeign),
        String(data.totalCloud),
        String(data.totalDirect),
        String(data.resilience),
      ].join('\t'),
    );
  }

  await fs.promises.writeFile(OUTPUT, lines.join('\n'), 'utf8');
  console.log(`已產生 TSV：${OUTPUT}`);
  console.log(`共處理 ${allData.length} 筆資料`);
}

// 如果直接執行此檔案（不是被 require）
if (require.main === module) {
  main().catch((err) => {
    console.error('執行失敗：', err);
    process.exit(1);
  });
}

module.exports = { main };
