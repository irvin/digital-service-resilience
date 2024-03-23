---
tags: digital-resilience, resilience, internet-shutdown, digiresi, civil-defense, 民防, 數位韌性松, DigiResiTh0n, hackathon, civil defense, 
---

# 重要數位服務韌性檢測

```
在天災人禍導致「台灣對外斷網」時，希望能盡量維持正常運作的重要網路服務。
```

**情境：** 2023年初，馬祖的對外海纜被中國的拖網漁船/挖沙船「意外」挖斷，因而斷網長達數個月。假設此一情境發生在台灣，台灣對外網路骨幹海纜斷了八九成（甚至完全中斷），有哪些服務，是維持*基本生活品質*必要的服務，應在「只有島內網路」的狀態下維持正常運作？

**範疇：** 國民第一線會使用的「網路服務」、「手機 APP」。

> 不納入實體離線服務如 7-11 店面與捷運⋯⋯等。也不列入各消費端服務的上游相關設施（如 EC 網站的物流，我們期待該網站能與其供應鏈上下游協作，推行進一步的韌性計畫）

**目標：** 對列舉的重要民生服務進行檢測，確認其相對台灣對外斷網時的韌性狀態

**倡議：** 民生必需的服務，應備有對外網路嚴重障礙的應變計劃，並且定期進行相關的演練。

---

## a) 重要數位民生服務（與其替代品）

-> [重要民生網站與數位服務](/lmNxS58KQOm5Rf-H4SbvSw)

---

## b) 服務韌性關鍵因素

- 網站 hosting 主機 
    - 所在地 & API 所在地
        - 位置：國內 / 國外
        - 是否是 anycast，且提供國內節點
- 網站頁面 & API 是否通過 CDN
    - CDN 是否是已知有落地的單位
        - cloudflare (TPE)
        - Akamai
- 網站使用的 library (jquery, anguler, vue... etc)
    - 是否使用公共的 CDN
        - 是否已知有落地
        - cdnjs (over cloudflare)
        - jsdelivr?
    - 是否與網站一起 serve


## c) 韌性檢測步驟

以 Pchome 產品頁 `https://24h.pchome.com.tw/prod/DCAYAD-A900BIAMV` 為例（[檢測過程紀錄](/5siiuEN1RAuFAI2H7l-phQ)）

1. 先打開 adblock / adguard，把不必要的元素都預先擋掉
2. 打開瀏覽器開發工具，停用快取，載入頁面
3. 切到 network，用 HAR 檔存下完整的 request 紀錄 
    - 完整 request 紀錄: https://gist.github.com/irvin/8d7527636528fcb64ce2dc6b63679da3
4. 資料整理
    > - vscode 搜索 HAR `"url": "(.*)"` 抓出所有的 requests
    > - 按照 hostname 排序，同一個 sub-domain 只留一條 
    - 可直接丟掉的 requests 們
        - analytics:
            - `analytics.google.com`
            - `play.google.com/log`
            - `www.google-analytics.com`
        - fb: 
            - `connect.facebook.net`
            - `www.facebook.com`
        - 字體:
            - `fonts.gstatic.com`
        - ad:
            - `*.doubleclick.net`
            - `www.google.com.tw/ads`
        - 其他:
            - `www.youtube.com/embed/*`
5. 檢視 HAR entries 下的每一個 request 項目是否有境內可用性，以[第一項](https://gist.github.com/irvin/8d7527636528fcb64ce2dc6b63679da3#file-24h-pchome-com-tw_archive-24-02-24-15-39-25-har-L29) `https://24h.pchome.com.tw/prod/DCAYAD-A900BIAMV` 為例

    a. 確認資源 IP
        
            ➜  ping 24h.pchome.com.tw
            PING shopping.gs1.pchome.com.tw (34.149.253.14): 56 data bytes
            64 bytes from 34.149.253.14: icmp_seq=0 ttl=61 time=20.640 ms
            
    b. 確認該 IP 資訊 https://ipinfo.io/34.149.253.14 

        ➜  ~ ipinfo 34.149.253.14
        Core
        - IP           34.149.253.14
        - Anycast      true
        - Hostname     14.253.149.34.bc.googleusercontent.com
        - City         Kansas City
        - Region       Missouri
        - Country      United States (US)
        - Currency     USD ($)
        - Location     39.0997,-94.5786
        - Organization AS396982 Google LLC
        - Postal       64106
        - Timezone     America/Chicago
            
    c. 檢視 Anycast / 地理位置狀態
        c-1. 假設無 Anycast，則參考該 ip 的地理位置，紀錄到表格上。如位置在島內，則在「是否可及」內打 O，在島外則打 X。
        c-2. 假設有 Anycast，如果該地理位置不在島內，可檢查「該服務是否是已知有台灣節點者」，如上述範例 hostname 為GCP，對照 [#雲端平台--IaaS--SaaS](https://g0v.hackmd.io/x4cR0BtxTf6eLw_6vaPY3A?both#雲端平台--IaaS--SaaS) 確認其有台灣節點，則在「是否可及」內紀錄 `O`
        
    d. 最終以 `X` 與 `?` 的數字評估該網頁的耐受度。以上頁 pchome 產品頁為例，共 2 個 `X` 可評估改善。



## d) 服務韌性檢測結果


| 服務 | 斷網耐受性 | 檢測紀錄 |
| -------- | -------- | -------- |
| Pchome 24 產品頁     | failure     | [檢測紀錄](/5siiuEN1RAuFAI2H7l-phQ)
| | |
