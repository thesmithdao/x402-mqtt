# Evidence

Real runs on Base mainnet, 2026-09-28. A MacBook Air sells its sensor readings over MQTT (Mosquitto 2.1.2) and gets paid in USDC through the Coinbase facilitator. Every paid row links to its settlement on Basescan, and every "not charged" row was checked against the USDC contract.

The buyers are test wallets run by Cult OS. These are our own purchases, made to prove the pipeline, not customer sales.

- Payout: `0x9A4A53e4F4345bCe286Cd47d9c3B3Ef3b7992f69`
- Buyers: `0x3B8b93fc86Ad4Af0600C7fe5fE38B15B7A3dF573`, `0x1d49c4dedA1E447abeb4b309D8B9Fb55a196a1a9`
- Result: 18 of 18 scenarios passed
- Paid reading, full round trip (quote, sign, settle, deliver): median 1.28s, slowest 5% 1.82s

| Scenario | Expected | Result | Status | Proof |
|---|---|---|---|---|
| Paid reading · mac/battery/temperature | reading delivered, exactly $0.001 moved on-chain | 30.6 °C in 1.79s | pass | [0x3e7cc6d9…](https://basescan.org/tx/0x3e7cc6d9a35404a9f432b8fd39796c1eff1123b321fb3c43e55581425d9ea111) |
| Paid reading · mac/battery/level | reading delivered, exactly $0.001 moved on-chain | 94 % in 1.82s | pass | [0x9380ebba…](https://basescan.org/tx/0x9380ebba5c6f040ef15655ca98dabeec030ed9a186d3138be4b38f0dfc210500) |
| Paid reading · mac/power/watts | reading delivered, exactly $0.001 moved on-chain | 5.8 W in 1.13s | pass | [0x71a9a304…](https://basescan.org/tx/0x71a9a304b676ba38301c9e942015ed65030f9adeb2631268a7cea361da20e7df) |
| Paid reading · mac/cpu/load | reading delivered, exactly $0.001 moved on-chain | 2.02 load in 1.29s | pass | [0x51d7f3c3…](https://basescan.org/tx/0x51d7f3c325e865d05e9ccc2140b4340090b08b607d48b9d00720c26c2a52cb3e) |
| Paid reading · mac/memory/free | reading delivered, exactly $0.001 moved on-chain | 36 % in 1.16s | pass | [0x451a5a5d…](https://basescan.org/tx/0x451a5a5d4166abcdbb498d297127a0ae01249e3e0278307581c028c8af85eeea) |
| Paid reading · mac/battery/cycles | reading delivered, exactly $0.001 moved on-chain | 1053 cycles in 1.09s | pass | [0x4c85c5f4…](https://basescan.org/tx/0x4c85c5f46a49dc1be3a5e4c05e02cdeb53fd0fa6a66d7de89e5d6a7ba892ddf0) |
| Paid reading · mac/thermal/pressure | reading delivered, exactly $0.001 moved on-chain | normal in 1.04s | pass | [0xeaec0002…](https://basescan.org/tx/0xeaec0002d04226848e162fd7eba29c340c7b07791dc46ddbf7600ac1ccc4e235) |
| Paid reading · mac/battery/temperature | reading delivered, exactly $0.001 moved on-chain | 30.6 °C in 1.29s | pass | [0xa8100aaf…](https://basescan.org/tx/0xa8100aaff4b7f652f6f9e84a625431893629d5cf577f0719de56d4fa8ad332fc) |
| Paid reading · mac/power/watts | reading delivered, exactly $0.001 moved on-chain | 7.9 W in 1.04s | pass | [0xed182dbd…](https://basescan.org/tx/0xed182dbdc21c211be151eb7134bb14d0143f477b3b2b9b4461ce4a69cafc4463) |
| Paid reading · mac/cpu/load | reading delivered, exactly $0.001 moved on-chain | 3.53 load in 1.28s | pass | [0x0604b046…](https://basescan.org/tx/0x0604b046242fd73fdce176d8f54a62381be6d80fea5e1388b5aa81e6f6fff437) |
| Replay a used payment | second use rejected, no second charge | first 200, replay 409 payment already used | pass | [0xbc5ea24c…](https://basescan.org/tx/0xbc5ea24cae6636ef2ce423c27e54748638bb6a4337ed172919522db094d12bef) |
| Same request delivered three times (MQTT redelivery) | one settlement; repeats get the same receipt or an in-progress refusal | replies 409, 200, 200, distinct settlements 1 | pass | [0xefec4958…](https://basescan.org/tx/0xefec4958f2a7455a7975cee6c9a84f9cc9290cc7072ba52a4875e7d8d7905ad4) |
| One payment, two requests at once | one delivered, the other refused, one charge | 200 + 409 | pass | [0x0357db4c…](https://basescan.org/tx/0x0357db4ca3d57ebe64c5b3c43bed5fef97b7282735425a647aade9927e7759a4) |
| Underpayment ($0.0005 for a $0.001 reading) | rejected, not charged | 400 payment does not match the quote, charged: false | pass |  |
| Test-network payment sent to a mainnet quote | rejected, not charged | 400 payment does not match the quote | pass |  |
| Device offline (a paid topic with no device publishing) | refused, not charged | 503 device offline, not charged, charged: false | pass |  |
| Unpaid client listens to raw data and another buyer's replies for 12s | no messages delivered | 0 messages received | pass |  |
| Oversized message and a flood of 80 quote requests | oversized dropped, flood rate-limited | 80 replies to 80 requests, 20 rate-limited, oversized ignored | pass |  |
