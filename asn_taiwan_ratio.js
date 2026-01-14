const fs = require('fs');
const path = require('path');

// 目標 ASN 列表
const TARGET_ASNS = {
  'AS15169': 'Google LLC',
  'AS396982': 'Google LLC',
  'AS13335': 'Cloudflare, Inc.',
  'AS16509': 'Amazon.com, Inc.',
  'AS3462': 'Data Communication Business Group',
  'AS4782': 'Data Communication Business Group',
  'AS54113': 'Fastly, Inc.',
  'AS16625': 'Akamai Technologies, Inc.',
  'AS20940': 'Akamai Technologies, Inc.',
  'AS8075': 'Microsoft Corporation',
  'AS9919': 'New Century InfoComm Tech Co., Ltd.',
  'AS9924': 'Taiwan Fixed Network',
};

// 從 org 欄位中提取 ASN
function extractASN(org) {
  if (!org || typeof org !== 'string') return null;
  const match = org.match(/^(AS\d+)\s+/i);
  return match ? match[1].toUpperCase() : null;
}

async function main() {
  const DIR = path.resolve(__dirname, 'test_results');
  const OUTPUT = path.join(DIR, 'asn_taiwan_ratio.tsv');

  // 統計每個 ASN 的請求數
  const stats = {};
  Object.keys(TARGET_ASNS).forEach(asn => {
    stats[asn] = {
      name: TARGET_ASNS[asn],
      total: 0,
      taiwan: 0,
      nonTaiwan: 0,
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

      const country = detail.ipinfo.country;
      stats[asn].total++;

      if (country === 'TW') {
        stats[asn].taiwan++;
      } else {
        stats[asn].nonTaiwan++;
      }
    }
  }

  // 產生輸出
  const lines = [];
  lines.push(['ASN', 'Company Name', 'Total Requests', 'Taiwan Requests', 'Non-Taiwan Requests', 'Taiwan Ratio (%)'].join('\t'));

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
      };
    }
    companyStats[companyName].asns.push(asn);
    companyStats[companyName].total += data.total;
    companyStats[companyName].taiwan += data.taiwan;
    companyStats[companyName].nonTaiwan += data.nonTaiwan;
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
      ].join('\t');
      lines.push(line);
      console.log(`${asn.padEnd(10)} ${data.name.padEnd(40)} 總計: ${String(data.total).padStart(6)}  台灣: ${String(data.taiwan).padStart(6)} (${ratio}%)`);
    });

  // 輸出公司合計統計
  lines.push('');
  lines.push(['=== 公司合計統計 ==='].join('\t'));
  lines.push(['Company Name', 'ASNs', 'Total Requests', 'Taiwan Requests', 'Non-Taiwan Requests', 'Taiwan Ratio (%)'].join('\t'));

  console.log('\n=== 公司合計統計 ===');
  Object.entries(companyStats)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([companyName, data]) => {
      const ratio = data.total > 0 ? ((data.taiwan / data.total) * 100).toFixed(2) : '0.00';
      const line = [
        companyName,
        data.asns.join(', '),
        data.total,
        data.taiwan,
        data.nonTaiwan,
        ratio,
      ].join('\t');
      lines.push(line);
      console.log(`${companyName.padEnd(50)} ASN: ${data.asns.join(', ').padEnd(20)} 總計: ${String(data.total).padStart(6)}  台灣: ${String(data.taiwan).padStart(6)} (${ratio}%)`);
    });

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
