# RTT 門檻設定與分析

## 概述

本專案使用 **RTT (Round Trip Time，往返延遲時間)** 作為判斷網路資源是否位於台灣境內的輔助方法之一。當無法透過 HTTP headers（如 `cf-ray`、`x-amz-cf-pop` 等）判斷時，會進行 RTT 測試來推測資源的地理位置。

## RTT 門檻設定

### 目前設定值

**門檻值：15 毫秒 (ms)**

定義位置：`no-global-connection-check.js` 第 63 行

```javascript
const RTT_THRESHOLD = 15;
```

### 判斷邏輯

在 `no-global-connection-check.js` 中的實作邏輯如下：

1. **優先檢查 HTTP headers**：如果從 headers 中發現包含台灣節點的標記（如 `cf-ray` 包含 `TPE`），則直接標記為 `country: 'tw'`，`detection_method: 'header'`。

2. **如果沒有找到 header 標記，進行 RTT 測試**：
   - **RTT < 15ms**：判斷為台灣境內
     - 設定 `cloud_provider.country = 'tw'`
     - 設定 `cloud_provider.detection_method = 'rtt'`
     - 記錄 `cloud_provider.rtt` 數值
   
   - **RTT ≥ 15ms**：不標記為境內
     - 不設定 `cloud_provider.country`
     - 設定 `cloud_provider.detection_method = 'rtt'`
     - 記錄 `cloud_provider.rtt` 數值（供後續分析使用）

3. **如果 RTT 測試失敗**：不記錄 `cloud_provider` 資訊。

## 使用 15ms 作為門檻的選擇依據

RTT 是網路封包從發送端到接收端再返回所需的時間。我們對測試數據中的共 2245 筆 RTT 數值資料進行統計，結果如下：

### 統計資料

平均值	46.96230869ms
中位數	6.066ms
最大值	417.717ms

分群計數
ms	count
<2ms	0
2~4ms	72
4~6	1041
6~8	106
8~10	14
12		2
14		0
16		2
18		2
20		4
25		4
30		6
35		68
40		152
45		58
50		67
60		63
70		28
80		1
90		6
100	4
110	4
120	1
130	29
140	329
150	111
160	14
170	3
180	5
190	5
200	14
220	16
240	3
260	1
280	4
300	5
350	0
400	0
<450ms	1

百分位	數值
p10	4.2894
p15	4.4616
p20	4.603
p25	4.75675
p30	4.8813
p35	5.02735
p40	5.2126
p45	5.4673
p50	6.057
p55	9.279
p60	35.315
p65	38.3235
p70	49.3116
p75	65.93
p80	134.1582
p85	135.85385
p90	137.2175
p95	142.74965

### 分析

根據以下散布圖及上述統計資料，可以發現有三個集中群，分別是： 2~10ms、30~70ms、120~160ms

![RTT 散佈圖](./images/rtt-distribution.png)

第一區間的數值明顯為境內資源，因此我們呈現雙峰分布的谷底中點 15ms 作為研判資源是否來自雲端服務境內節點的門檻值。

## 潛在限制

1. **測試環境依賴**：此數值依賴當地的網路環境結構，如果無法適用於台灣以外的國家或地區。
2. **邊緣情況**：對於雙峰谷底的 10~30ms 區間，共有 20 個資料點，這些連線的境內境外判定則可能有誤。

## 後續改進方向

### 1. 收集已知地理位置的節點的 RTT 值進行統計，以建立更精確的門檻值

### 2. 分層判讀

對於難以分類的 10~30ms 區間，採用信心度作為更細緻的分層：
- **RTT < 15ms**：幾乎肯定在台灣（高信心）
- **15ms ≤ RTT < 25ms**：可能在台灣（中信心）
- **RTT ≥ 25ms**：傾向國外（低信心）

## 相關工具與檔案

### 分析工具

1. **`export-rtt-csv.js`**
   - 用途：匯出所有 RTT 測試結果為 CSV 格式
   - 使用方式：`node export-rtt-csv.js`
   - 輸出：`rtt.csv`，包含所有 RTT 測試的詳細資訊

### 資料檔案

1. **`rtt.csv`**
   - 格式：CSV，包含以下欄位：
     - `file`：來源 JSON 檔名
     - `originalUrl`：原始測試 URL
     - `domain`：ipinfo.domain
     - `ip`：ipinfo.ip
     - `ipinfo_country`：ipinfo.country
     - `cloud_country`：cloud_provider.country（若有，通常是 `tw`）
     - `detection_method`：檢測方法（`rtt` 或 `header`）
     - `rtt`：實際 RTT 數值（毫秒）

2. **`test-results/*.json`**
   - 每個網站的測試結果 JSON 檔案
   - 包含 `domainDetails` 陣列，每個元素可能包含 `cloud_provider.rtt` 和 `cloud_provider.detection_method`

### 相關連結

- [RTT 測試實作](no-global-connection-check.js)（第 63 行定義門檻，第 957-987 行實作邏輯）
- [RTT 數據匯出工具](export-rtt-csv.js)
- [完整 RTT 數據](rtt.csv)

---

*最後更新：2026-02-05*
