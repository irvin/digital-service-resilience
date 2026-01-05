# 計畫
- 規劃雲端判斷維護策略：移除程式內建的 `CLOUD_PROVIDERS`，讀取 top-traffic-list-taiwan/cloud_providers_tw.json 作為資料來源
- 更新結果結構（境內 / 境外 x 雲端 / 非雲端）。
  
    "test_results": {
      "domestic": {
        "clouds": 1,
        "others": 1
      }
      "foreign": {
        "clouds": 1,
        "others": 1
    }

- 更新 `calculateResilience`，計算新的矩陣並保留每個網域的細節。

TODO:
- 決定相容策略：保留舊的 `O/?/X` 欄位或提供轉換映射給下游。
- 更新結果輸出結構（`test_results`、`domainDetails`）與相依讀取結果的地方。
- 以既有測試結果驗證（含 Cloudflare / 全被過濾等特殊情況），必要時同步調整說明文件。
- 從外國節點再執行一次測試，統計 multi-cast 跟海內外雲端的不同狀態