# cloud strategy

1. 如果 ipinfo 回傳的 country 不是 .tw，則進行以下進一步判斷

2. 針對來自以下 ASN 的雲端（Google / Cloudflare / Amazon / Fastly / Akamai），需進入下一步進一步判斷

AS15169
AS396982
AS19527
AS13335
AS16509
AS54113
AS16625
AS20940
AS63949
AS32787

3. 檢查以下 header 是否存在，內容包含 TPE
cf-ray
x-amz-cf-pop
x-served-by

如果包含 TPE，則判斷為 tw

log 在 ipinfo 後方加入 "cloud_provider": {
  country: "tw",
  cf-ray: <cf-ray>,
  x-amz-cf-pop: <x-amz-cf-pop>,
  x-served-by: <x-served-by>
}

4. 如沒有找到以上 header，則進行 RTR 延遲測試

ping -n -c 5 -i 0.2 142.250.66.74
PING 142.250.66.74 (142.250.66.74): 56 data bytes
64 bytes from 142.250.66.74: icmp_seq=0 ttl=117 time=65.203 ms
64 bytes from 142.250.66.74: icmp_seq=1 ttl=117 time=14.516 ms
64 bytes from 142.250.66.74: icmp_seq=2 ttl=117 time=128.233 ms
64 bytes from 142.250.66.74: icmp_seq=3 ttl=117 time=99.095 ms
64 bytes from 142.250.66.74: icmp_seq=4 ttl=117 time=72.510 ms

如 min time < 15ms，則判斷為 tw
log 在 ipinfo 後方加入 "cloud_provider": {
  country: "tw",
  rtt: <min time>
}
