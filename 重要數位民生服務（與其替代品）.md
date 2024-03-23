---
tags: digital-resilience, resilience, internet-shutdown, digiresi, civil-defense, 民防, 數位韌性松, DigiResiTh0n, hackathon, civil defense, 
---

# 重要數位民生服務（與其替代品）

### 搜尋引擎

|||
|---|---|
| Google | google.com |
| Yahoo奇摩 | yahoo.com |
| Bing | bing.com |


### 新聞

|||
|---|---|
| 中央社 | cna.com.tw |
| 公視 | pts.org.tw |
| 警廣（線上直播） | https://www.pbs.npa.gov.tw/ch/app/programList/list?module=programlist&id=18112 |
| 華視 | cts.com.tw |

<!-- 
|Youtube|youtube.com| 
在災難狀態下，我認為大量耗費流量的線上影音，不太適合列入必要服務 [name=Irvin]
-->

### 流通

|||
|---|---|
| MoMo | www.momoshop.com.tw |
| 蝦皮 | shopee.tw |
| PChome 24 | 24h.pchome.com.tw |

### 生活

|||
|---|---|
| Google Maps (app / web) | maps.google.com |

### 通訊與社群

| Service | Link | Notes |
|-|-|-|
| Line | | （需想辦法檢測其啟動、訊息收發時會運用到的 API）|
| Telegram | tg.me | (同上) |
| Gmail      | mail.google.com | |
| Yahoo Mail | mail.yahoo.com | |
| Ptt | ptt.cc | ssh, web access, api | 


<!-- 本專案納入的範圍為「平常就被大量使用，而災難時希望能維持運作的民生服務」，以下適合災難環境下使用的服務移到:
https://g0v.hackmd.io/_HFiW7HDT9S2lwf02hTJNA?view

| Briar      | briarproject.org | 不需要網際網路，僅靠藍芽即可傳送文字訊息的通訊軟體。初次設定仍需網際網路。 |
| Bridgefy   | bridgefy.me | （同上，但沒開源。） |
-->



### 官方與避難資訊

||| 備註 |
|-|-|-|
| 總統府 | www.president.gov.tw ||
| 國防部 | www.mnd.gov.tw ||
| 內政部 警政署 防空避難專區 | https://adr.npa.gov.tw |  (Website, Google Map) |


### 政府 APP / 金流 / 發票

> 烏克蘭曾經用一些健保APP來推播戰爭資訊，所以可能也能盤點台灣很普及的政府APP  [name=Ronny]

| APP | 主管機關 / link |
| --- | --- | 
| 健保快易通 | 衛服部 | 
| 集保e手掌握 | 臺灣集中保管結算所 | 
| 統一發票兌獎 | 財政部 |
| 發票存摺 | https://apps.apple.com/tw/app/id1276986959 |
| 雲端發票 | https://apps.apple.com/tw/app/id512920023 |
| 臺北市行動防災 | https://www.gov.taipei/News_Content.aspx?n=E913E3AE42428718&sms=5E1F5CB2AD837CAE&s=A96715627B83D676 |
| 消防防災e點通 | https://play.google.com/store/apps/details?id=com.nfa.report&hl=zh_TW&gl=US <br/> https://apps.apple.com/tw/app/%E6%B6%88%E9%98%B2%E9%98%B2%E7%81%BDe%E9%BB%9E%E9%80%9A/id1500403641 |


### 銀行

| 銀行名稱 | 官方下載頁面 |
| --- | --- |
| 國泰世華 | https://www.cathaybk.com.tw/cathaybk/promo/event/ebanking/product/appdownload/index.html |
| 富邦     | https://www.fubon.com/banking/personal/mobile/index.htm                                  |
| 聯邦     | https://play.google.com/store/apps/details?id=wbank.ubot.com.tw&hl=en_US                 |
| 中國信託 | https://play.google.com/store/apps/details?id=com.chinatrust.mobilebank                  |
| 玉山     | https://play.google.com/store/apps/details?id=com.esunbank&hl=zh_TW&gl=US                |
|台銀 |https://play.google.com/store/apps/details?id=com.bot.ibank&hl=zh_TW&gl=US   |
| 台新     | https://play.google.com/store/apps/details?id=tw.com.taishinbank.mobile&hl=zh_TW&gl=US   |
|郵局 |https://play.google.com/store/apps/details?id=tw.gov.post.mpost&hl=zh_TW&gl=US |
|合作金庫|https://www.tcb-bank.com.tw/personal-banking/digital-finance/services/app|
|||
|||
|||
|||
|||

### 對外溝通與宣傳

|||
|-|-|
| X | x.com |
| Facebook | facebook.com |
| Telegram | |
| IG | |
|dcard||
|ptt||

### 工作

| | | |
|-|-|-|
| Google Workspace | | 許多企業運作必須 |
| Microsoft 365 | | 同上 |


---

## 數位服務的基礎建設

> 列入基準：大量民生服務運用的資訊基礎建設與服務。
> 先行調查這些服務是否有落地節點，構成檢測上方民生服務的韌性所需的重要資訊


### 作業系統相關基礎服務

|| notes |
|-|-|
| iCloud | |
| Ubuntu apt mirrors ||
| Firebase | 手機上的 push notification |
|||

> iPhone / mac 運作時會存取（depend）超多 icloud 下的服務（與 api），android / windows 有什麼相對的服務?[name=irvin]

### Cert

如果對外網路中斷時，cert 的機制會有影響嗎？

| 廠商 | 台灣節點 | 備註 | |
|-|-|-|-|
| Digicert | | 憑證驗證商<br> 在檢視 DNS log 時，發現 iPhone / Mac 都對這個憑證商有大量存取，如果無法使用，是否會造成 https 連鎖信任問題？ [name=Irvin] |

### DNS

| | IP | 台灣節點 |
|-|-|-|-|
| Google Public DNS | 8.8.8.8 | ? |
| Hinet DNS | 168.95.1.1 / 168.95.192.1 | Y |


### 雲端平台 / IaaS

| 供應商 | 台灣有節點 | 備註 |
| --- | --- | --- |
| AWS | [Y](https://aws.amazon.com/tw/about-aws/global-infrastructure/localzones/locations/) |
| Azure Edge | [Coming Soon](https://azure.microsoft.com/zh-tw/explore/global-infrastructure/geographies/#geographies) |
| Azure CDN | [Y](https://learn.microsoft.com/zh-tw/azure/cdn/microsoft-pop-abbreviations) |
| Google Cloud Edge | [Y](https://cloud.google.com/about/locations?hl=zh-tw#lightbox-edgepoint-map) |
| Google Cloud CDN | [Y](https://cloud.google.com/about/locations?hl=zh-tw#lightbox-cdn-map) |
| Google App Engine | [?](https://cloud.google.com/appengine/docs/standard/locations) | App Engine 有地區性，Google 的 redundancy 似乎只有在區域內，因此使用者似乎無法確定是否在本地可用 |
| Cloudflare | [Y](https://www.cloudflare.com/zh-tw/network/) |
| Akamai | [Y](https://www.akamai.com/legal/compliance/privacy-trust-center/list-of-countries-with-server-points-of-presence) | | |
| GitHub | ? ([ref](https://github.com/orgs/community/discussions/42169#discussioncomment-4454218)) | 許多軟體資源都在上面，少了它可能有很多緊急建置需求無法達成 |

### SaaS



| 名稱 | 功能 | 替代品 |
| -------- | -------- | -------- |
| Notion | 關連式資料庫、資料庫可以切很多 view | [AppFlowy](https://www.appflowy.io/) is an open-source alternative to Notion. You are in charge of your data and customizations. |
Google Calendar
Amie Calendar App


### 被許多廣泛使用的 framework / service

需要找一些前端 lib 市場數據的資料

https://gist.github.com/tkrotoff/b1caa4c3a185629299ec234d2314e190

https://tsh.io/state-of-frontend/
https://2022.stateofjs.com/en-US/libraries/front-end-frameworks/


| framework | 服務提供的預設網址 | 是否有國內節點 | 備註 |
|---|---|---|---|
| jQuery | code.jquery.com | Fastly / 香港 | |
| React | | |
| Angular | | |
| Vue | | |
| Google Tag Manager | www.googletagmanager.com | ? (Google) | |
| fontawesome | kit.fontawesome.com | Y (Cloudflare) | |
| Adobe (Typekit) | use.typekit.net | | 死掉可能沒差 |
| Google Font | | | 死掉可能沒差 |
| cdnjs | | |
| jsdelivr | | |
| googleapis | ajax.googleapis.com | | [ref](https://developers.google.com/speed/libraries?hl=zh-tw) |
| 已知的 library CND | | |

<!-- 需離線可得或整理與分流的防災資訊移到：https://g0v.hackmd.io/oyNRfe4lTuaZ5RbcPSS7TQ?both#防災知識庫
### 生存

| Service | Line |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Survival Manual (Offline App)                      | [F-Droid](https://f-droid.org/packages/org.ligi.survivalmanual/), <br />[Google Play Store](https://play.google.com/store/apps/details?id=org.ligi.survivalmanual), <br />[Amazon appstore](https://www.amazon.com/ligi-Survival-Manual/dp/B06WW43R3T). |
-->
