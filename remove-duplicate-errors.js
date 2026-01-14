const fs = require('fs');
const path = require('path');

const errorDir = path.join(__dirname, 'test_results', '_error');
const rootDir = path.join(__dirname, 'test_results');

// 讀取 _error 目錄下的所有檔案
const errorFiles = fs.readdirSync(errorDir).filter(file => file.endsWith('.error.json'));

let removedCount = 0;
let keptCount = 0;

console.log(`找到 ${errorFiles.length} 個錯誤檔案，開始檢查...\n`);

errorFiles.forEach(errorFile => {
  // 將 xxx.error.json 轉換為 xxx.json
  const correspondingFile = errorFile.replace('.error.json', '.json');
  const correspondingPath = path.join(rootDir, correspondingFile);
  const errorPath = path.join(errorDir, errorFile);

  // 檢查根目錄是否有對應的檔案
  if (fs.existsSync(correspondingPath)) {
    // 移除 _error 目錄下的檔案
    fs.unlinkSync(errorPath);
    console.log(`✓ 已移除: ${errorFile} (根目錄存在 ${correspondingFile})`);
    removedCount++;
  } else {
    console.log(`- 保留: ${errorFile} (根目錄不存在 ${correspondingFile})`);
    keptCount++;
  }
});

console.log(`\n完成！`);
console.log(`已移除: ${removedCount} 個檔案`);
console.log(`已保留: ${keptCount} 個檔案`);

