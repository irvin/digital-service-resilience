const fs = require('fs');
const path = require('path');

// 以目前腳本所在位置為基準，找到 test_results 目錄
const DIR = path.resolve(__dirname, 'test_results');
const OUTPUT = path.join(DIR, 'statistic.tsv');

async function main() {
  const entries = await fs.promises.readdir(DIR, { withFileTypes: true });

  // 只取目錄下的 JSON 檔案（不含子目錄）
  const jsonFiles = entries
    .filter(
      (e) =>
        e.isFile() &&
        e.name.toLowerCase().endsWith('.json') &&
        !e.name.startsWith('.') // 排除 .DS_Store 等
    )
    .map((e) => e.name)
    .sort();

  const lines = [];

  // 標題列
  lines.push(
    [
      'url',
      'timestamp',
      'results_domestic_cloud',
      'results_domestic_direct',
      'results_foreign_cloud',
      'results_foreign_direct',
      'resilience',
    ].join('\t'),
  );

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
    const timestamp = data.timestamp ?? '';
    const domesticCloud = data.test_results?.domestic?.cloud ?? 0;
    const domesticDirect = data.test_results?.domestic?.direct ?? 0;
    const foreignCloud = data.test_results?.foreign?.cloud ?? 0;
    const foreignDirect = data.test_results?.foreign?.direct ?? 0;

    const domesticTotal = domesticCloud + domesticDirect;
    const foreignTotal = foreignCloud + foreignDirect;
    const resilience =
      domesticTotal > 0 && foreignTotal === 0
        ? 1
        : 0;

    lines.push(
      [
        String(url),
        String(timestamp),
        String(domesticCloud),
        String(domesticDirect),
        String(foreignCloud),
        String(foreignDirect),
        String(resilience),
      ].join('\t'),
    );
  }

  await fs.promises.writeFile(OUTPUT, lines.join('\n'), 'utf8');
  console.log(`已產生 TSV：${OUTPUT}`);
}

main().catch((err) => {
  console.error('執行失敗：', err);
  process.exit(1);
});
