archived from https://g0v.hackmd.io/@irvin/when-fiber-goes-dark
please check the online slide at above link. 

---

# 海纜斷光會怎樣？

@Hakuna Matata 9 

2025/4/20

g0v.hackmd.io/@irvin/when-fiber-goes-dark

[![CC0 Public Domain](https://hackmd.io/_uploads/SJTgCKZhkg.svg)](https://creativecommons.org/publicdomain/zero/1.0/)

---

## Irvin Chen

- 台灣維基媒體協會 Common Voice 專案執行 
- MozTW / Mozilla 志工、OCF 技術顧問

Note:

自我介紹一下，Mozilla 志工、Firefox 的推廣者、摩茲工寮社群場地 hackerspace 顧門的志工、開放文化基金會顧問

---

## 海纜

https://www.submarinecablemap.com/country/taiwan

![](https://g0v.hackmd.io/_uploads/r1Tc88ZJge.png)

note: 扣除直接與對岸相連的三條海纜，總共有8條海纜將台灣連接到全球的網際網路。另外有6條海纜連接台灣本島與離島。光在今年，臺馬2號，臺彭3號就兩次被中國權宜船「意外」破壞。其中臺彭3號就發生在 rightscon 期間，也是我國第一次抓到當事船

---

## 破壞臺彭三號的「宏泰輪」航跡

![](https://g0v.hackmd.io/_uploads/H1DghIWJxe.png)

(報導者) https://www.youtube.com/watch?v=NXroXYzXLX0

note: Z字型漂流兩天之後，在
海纜「事故」後，才加速要離開

---

## 一月時的「順興39」航跡

![](https://g0v.hackmd.io/_uploads/rJltAYLW1lx.png)

(Finantial Times) https://www.ft.com/content/be994bfb-7299-4334-829d-230dddbc7e25

note: 從12/5一路晃到1/3，後來得手後逃到釜山

---

## 當破壞海纜成為攻擊武器

- 2023/2 馬祖兩條海纜一週內損壞，斷網50天
- 2023/10/8 芬蘭與愛沙尼亞間的天然氣管線與電纜
- 2024/11/15-19 瑞典-立陶宛；德國-芬蘭
- 2024/12/25 芬蘭-愛沙尼亞

note: 中國貨輪從現場離開到聖彼得堡，並在事發地點遺留一個船錨，超過一百公裡的拖痕；過去170年，從未有人想過海纜會被蓄意破壞，作為戰爭與灰色侵擾手段

---

## 海纜很貴，破壞很便宜

- 海纜維修船只有 50 艘，台灣有合作的只有 6 艘
- 海纜斷掉的維修費用，中華電信自付 1~2 千萬
- 新建臺馬四號海纜，前瞻建設預算補助 1.4 億

note: 海纜維修船只有 50 艘，台灣有合作的只有 6 艘；破壞海纜只需要一艘破船一隻錨

---

## 基礎建設只能備援再備援

- 低軌衛星：實用化需要數百至數千顆衛星
- 同步軌道衛星：頻寬低、延遲高
- 新海纜：億起跳
- 海纜站

數發部編列 5.3 億預算，被砍了 3 億

note: OneWeb 650, Telesat 300, starlink 7000
SES 中軌道&同步軌道 70顆，下行90Mbps/上行45Mbps，目前的軍事指揮備援

---

## 封鎖的有效手段

- 能源
- 經濟
- 通訊

破壞海纜、海纜站是低成本一兼兩顧的事情

災難情境分級：https://g0v.hackmd.io/@irvin/digital-disaster-level

note: 戰爭來臨前，可以預期海纜絕對會斷光；台海戰爭時世界再也看不到賴給清德的最後影片或共軍上岸的直播

---

## 如何增加韌性

除了自己發射衛星、買現有低軌衛星、建設更多海纜與海纜站、建設更多微波系統以外，還有什麼辦法能提升網路韌性？
讓大家在海纜斷光時，能繼續維持日常生活？

note: 數量問題、預算問題；網路本應是具有韌性的


---

只要「海纜斷掉時，重要網站都還會動」，就可以將資訊封鎖的衝擊降到最小

note: 與國際上發生的 internet blackout 的不同；為什麼要確保對外斷線時，國內服務正常？ -如果戰時要用小七作為物資站，結果小七運作完全崩潰 -如果 gmail & google doc / office 365 無法使用，

---

## g0v 韌性松專案： 


民生數位服務韌性檢測

- https://github.com/irvin/digital-service-resilience

**海纜斷掉時，______會動嗎？**

eg., [海纜斷掉時，MoMo 會動嗎？](https://irvin.github.io/web-resilience-test-result/?url=https://www.momoshop.com.tw/category/LgrpCategory.jsp?l_code=2180000000)

---

_後面簡報做不完了，直接看 repo_

http://github.com/irvin/digital-service-resilience

note: 網站對境外資源的 dependency、網站本身的 hosting loc、雲端平台在對外斷線時的可用狀態⋯⋯

---

## 下一步

- 完善檢測的執行邏輯（處理 CDN / multi-cast... 問題）
- 收集更多更完整的現況數據
- 理解雲端平台對國際斷網的耐受狀態
- 提醒各單位、公司、工程師
    - 需要強化自己網站的韌性
    - 建立國內備援與回復計畫
- 擬定政府如何著手的政策建議

---

## 目前進度

**～努力找預算來做上述的事情**

有相關管道或建議合作單位，請與我 / OCF 聯絡： 
- t.me/irvin
- irvinㄟmoztw.org
- OCF: hi@ocf.tw

---

## 延伸閱讀

- [海底電纜斷裂危機下，台灣維繫「數位生命線」的應變挑戰 | 報導者](https://www.twreporter.org/a/damaged-undersea-cables-raises-alarm-in-taiwan)
- [動態模擬「宏泰輪」詭跡：台、歐斷纜危機的中國陰影｜報導者YT ](https://www.youtube.com/watch?v=NXroXYzXLX0)
- 
- [簡評SHUNXIN-39海底電纜事件之水下安全意涵 | 國防安全研究院](https://indsr.org.tw/focus?typeid=0&uid=11&pid=2758)
- [海纜 (107篇報導) | 中央社](https://www.cna.com.tw/tag/12261/)
