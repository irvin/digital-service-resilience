const fs = require('fs');
const path = require('path');

// 目標 ASN 列表（只統計國際公有雲）
const TARGET_ASNS = {
  'AS15169': 'Google LLC',
  'AS396982': 'Google LLC',
  'AS13335': 'Cloudflare, Inc.',
  'AS16509': 'Amazon.com, Inc.',
  'AS54113': 'Fastly, Inc.',
  'AS16625': 'Akamai Technologies, Inc.',
  'AS20940': 'Akamai Technologies, Inc.',
  'AS8075': 'Microsoft Corporation',
};

// 國際公有雲（排除台灣本地 ISP）
const PUBLIC_CLOUD_COMPANIES = new Set([
  'Google LLC',
  'Cloudflare, Inc.',
  'Amazon.com, Inc.',
  'Fastly, Inc.',
  'Akamai Technologies, Inc.',
  'Microsoft Corporation',
]);

// 從 org 欄位中提取 ASN
function extractASN(org) {
  if (!org || typeof org !== 'string') return null;
  const match = org.match(/^(AS\d+)\s+/i);
  return match ? match[1].toUpperCase() : null;
}

// 從檔案名稱或 URL 提取網站域名
// 從 URL 提取 hostname（移除 www. 前綴，與 statistic.tsv 對齊）
function extractHostname(url) {
  if (!url) return '';
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname.toLowerCase();
    // 移除 www. 前綴
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }
    return hostname;
  } catch {
    // 如果 URL 解析失敗，嘗試手動提取
    let normalized = url
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '') // 移除路徑
      .toLowerCase();
    if (normalized.startsWith('www.')) {
      normalized = normalized.substring(4);
    }
    return normalized;
  }
}

function extractWebsiteDomain(fileName, data) {
  // 優先使用 canonicalURL，其次使用 url，最後使用檔案名稱
  const url = data.canonicalURL || data.url;
  if (url) {
    return extractHostname(url);
  }
  // 從檔案名稱提取（移除 .json 後綴）
  return fileName.replace(/\.json$/i, '').toLowerCase();
}

async function main() {
  const DIR = path.resolve(__dirname, 'test_results');
  const OUTPUT = path.join(DIR, 'asn_taiwan_ratio.tsv');

  // 統計每個 ASN 的請求數和網站數
  const stats = {};
  Object.keys(TARGET_ASNS).forEach(asn => {
    stats[asn] = {
      name: TARGET_ASNS[asn],
      total: 0,
      taiwan: 0,
      nonTaiwan: 0,
      websites: new Set(), // 所有有請求的網站
      taiwanWebsites: new Set(), // 有台灣請求的網站
      nonTaiwanWebsites: new Set(), // 有非台灣請求的網站
    };
  });

  // 讀取所有 JSON 檔案
  const entries = await fs.promises.readdir(DIR, { withFileTypes: true });
  const jsonFiles = entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.toLowerCase().endsWith('.json') &&
        !e.name.startsWith('.')
    )
    .map((e) => e.name);

  console.log(`正在處理 ${jsonFiles.length} 個檔案...`);

  // 統計 resilience=1 網站使用公有雲的情況
  const resilientCloudStats = {};
  for (const company of PUBLIC_CLOUD_COMPANIES) {
    resilientCloudStats[company] = new Set();
  }
  const allResilientWebsites = new Set();
  const resilientWebsitesUsingPublicCloud = new Set();

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

    // 提取網站域名（用於去重）
    const websiteDomain = extractWebsiteDomain(file, data);
    // 從檔案名稱提取 hostname（用於與 statistic.tsv 對應，移除 www. 前綴）
    let fileHostname = file.replace(/\.json$/i, '').toLowerCase();
    if (fileHostname.startsWith('www.')) {
      fileHostname = fileHostname.substring(4);
    }

    // 從 JSON 檔案計算 resilience 值
    const testResults = data.test_results || { domestic: { cloud: 0, direct: 0 }, foreign: { cloud: 0, direct: 0 } };
    const domesticTotal = (testResults.domestic?.cloud || 0) + (testResults.domestic?.direct || 0);
    const foreignTotal = (testResults.foreign?.cloud || 0) + (testResults.foreign?.direct || 0);
    const isResilient = domesticTotal > 0 && foreignTotal === 0;

    if (isResilient) {
      // 使用 fileHostname 來確保與 statistic.tsv 一致
      allResilientWebsites.add(fileHostname);
    }

    // 處理 domainDetails
    if (!data.domainDetails || !Array.isArray(data.domainDetails)) {
      continue;
    }

    for (const detail of data.domainDetails) {
      if (!detail.ipinfo || !detail.ipinfo.org) {
        continue;
      }

      const asn = extractASN(detail.ipinfo.org);
      if (!asn || !TARGET_ASNS[asn]) {
        continue;
      }

      const companyName = TARGET_ASNS[asn];
      const isDomestic = detail.category?.startsWith('domestic/');

      stats[asn].total++;
      stats[asn].websites.add(websiteDomain);

      if (isDomestic) {
        stats[asn].taiwan++;
        stats[asn].taiwanWebsites.add(websiteDomain);
      } else {
        stats[asn].nonTaiwan++;
        stats[asn].nonTaiwanWebsites.add(websiteDomain);
      }

      // 統計 resilience=1 網站使用公有雲台灣節點的情況
      if (isResilient && detail.category === 'domestic/cloud' && PUBLIC_CLOUD_COMPANIES.has(companyName)) {
        resilientCloudStats[companyName].add(fileHostname);
        resilientWebsitesUsingPublicCloud.add(fileHostname);
      }
    }
  }

  // 產生輸出
  const lines = [];
  lines.push(['ASN', 'Company Name', 'Total Requests', 'Taiwan Requests', 'Non-Taiwan Requests', 'Taiwan Ratio (%)', 'Total Websites', 'Websites (domestic node)', 'Websites (foreign node)'].join('\t'));

  // 按公司名稱分組統計
  const companyStats = {};
  Object.entries(stats).forEach(([asn, data]) => {
    const companyName = data.name;
    if (!companyStats[companyName]) {
      companyStats[companyName] = {
        asns: [],
        total: 0,
        taiwan: 0,
        nonTaiwan: 0,
        websites: new Set(),
        taiwanWebsites: new Set(),
        nonTaiwanWebsites: new Set(),
        resilientWebsites: resilientCloudStats[companyName] || new Set(),
      };
    }
    companyStats[companyName].asns.push(asn);
    companyStats[companyName].total += data.total;
    companyStats[companyName].taiwan += data.taiwan;
    companyStats[companyName].nonTaiwan += data.nonTaiwan;
    // 合併網站集合
    for (const site of data.websites) {
      companyStats[companyName].websites.add(site);
    }
    for (const site of data.taiwanWebsites) {
      companyStats[companyName].taiwanWebsites.add(site);
    }
    for (const site of data.nonTaiwanWebsites) {
      companyStats[companyName].nonTaiwanWebsites.add(site);
    }
  });

  // 先輸出各 ASN 的詳細統計
  console.log('\n=== 各 ASN 詳細統計 ===');
  Object.entries(stats)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([asn, data]) => {
      const ratio = data.total > 0 ? ((data.taiwan / data.total) * 100).toFixed(2) : '0.00';
      const line = [
        asn,
        data.name,
        data.total,
        data.taiwan,
        data.nonTaiwan,
        ratio,
        data.websites.size,
        data.taiwanWebsites.size,
        data.nonTaiwanWebsites.size,
      ].join('\t');
      lines.push(line);
      console.log(`${asn.padEnd(10)} ${data.name.padEnd(40)} 總計: ${String(data.total).padStart(6)}  台灣: ${String(data.taiwan).padStart(6)} (${ratio}%)  網站數: 總計${data.websites.size}  台灣${data.taiwanWebsites.size}  非台灣${data.nonTaiwanWebsites.size}`);
    });

  // 輸出公司合計統計
  lines.push('');
  lines.push(['=== 公司合計統計 ==='].join('\t'));
  lines.push(['Company Name', 'ASNs', 'Total Requests', 'Taiwan Requests', 'Non-Taiwan Requests', 'Taiwan Ratio (%)', 'Total Websites', 'Websites (domestic node)', 'Websites (foreign node)', 'Websites (consider resilience)'].join('\t'));

  console.log('\n=== 公司合計統計 ===');
  Object.entries(companyStats)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([companyName, data]) => {
      const ratio = data.total > 0 ? ((data.taiwan / data.total) * 100).toFixed(2) : '0.00';
      const resilientCount = data.resilientWebsites ? data.resilientWebsites.size : 0;
      const line = [
        companyName,
        data.asns.join(', '),
        data.total,
        data.taiwan,
        data.nonTaiwan,
        ratio,
        data.websites.size,
        data.taiwanWebsites.size,
        data.nonTaiwanWebsites.size,
        resilientCount,
      ].join('\t');
      lines.push(line);
      console.log(`${companyName.padEnd(50)} ASN: ${data.asns.join(', ').padEnd(20)} 總計: ${String(data.total).padStart(6)}  台灣: ${String(data.taiwan).padStart(6)} (${ratio}%)  網站數: 總計${data.websites.size}  台灣${data.taiwanWebsites.size}  非台灣${data.nonTaiwanWebsites.size}  Resilience=${resilientCount}`);
    });

  // 輸出 Resilience=1 網站公有雲使用總結
  lines.push('');
  lines.push(['=== Resilience=1 網站公有雲使用總結 ==='].join('\t'));

  const totalResilient = allResilientWebsites.size;
  const totalUsingCloud = resilientWebsitesUsingPublicCloud.size;
  const cloudRatio = totalResilient > 0 ? ((totalUsingCloud / totalResilient) * 100).toFixed(2) : '0.00';

  console.log('\n=== Resilience=1 網站公有雲使用總結 ===');
  console.log(`Resilience=1 網站總數: ${totalResilient}`);
  console.log(`使用公有雲台灣節點的 Resilience=1 網站: ${totalUsingCloud} 個 (${cloudRatio}%)`);

  lines.push(`Resilience=1 網站總數\t${totalResilient}`);
  lines.push(`使用公有雲台灣節點的網站數\t${totalUsingCloud}\t${cloudRatio}%`);

  console.log('\n各公有雲使用情況:');
  lines.push('');
  lines.push('各公有雲使用情況:');

  const sortedCloudStats = Array.from(PUBLIC_CLOUD_COMPANIES)
    .map(company => ({ company, count: resilientCloudStats[company].size }))
    .sort((a, b) => b.count - a.count);

  for (const { company, count } of sortedCloudStats) {
    console.log(`  ${company}: ${count} 個網站`);
    lines.push(`${company}\t${count}`);
  }

  // 寫入檔案
  await fs.promises.writeFile(OUTPUT, lines.join('\n'), 'utf8');
  console.log(`\n結果已寫入：${OUTPUT}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('執行失敗：', err);
    process.exit(1);
  });
}

module.exports = { main };
