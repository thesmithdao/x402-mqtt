# Evidence

Real runs on Base mainnet, 2026-09-28. A MacBook Air sells its sensor readings over MQTT (Mosquitto 2.1.2) and gets paid in USDC through the Coinbase facilitator. Nothing is mocked: every paid row links to its settlement on Basescan, and every "not charged" row was checked against the USDC contract.

The buyers are test wallets run by Cult OS. These are our own purchases, made to prove the pipeline, not customer sales.

- Payout: `0x9A4A53e4F4345bCe286Cd47d9c3B3Ef3b7992f69`
- Buyers: `0x3B8b93fc86Ad4Af0600C7fe5fE38B15B7A3dF573`, `0x1d49c4dedA1E447abeb4b309D8B9Fb55a196a1a9`
- Result: 18 of 18 scenarios passed
- Paid reading, full round trip (quote, sign, settle, deliver): median 1.23s, slowest 5% 1.60s

| Scenario | Expected | Result | Status | Proof |
|---|---|---|---|---|
| Paid reading · mac/battery/temperature | reading delivered, exactly $0.001 moved on-chain | 31 °C in 1.60s | pass | [0xfd87cc99…](https://basescan.org/tx/0xfd87cc99d5dbcb10b0c0beaad4e0dc3c9872f01c93555bfdcf54e101339c7770) |
| Paid reading · mac/battery/level | reading delivered, exactly $0.001 moved on-chain | 87 % in 1.56s | pass | [0xf88f5bce…](https://basescan.org/tx/0xf88f5bcef47fe220d34e1d2a125a35af26e3752276357f0bdd6f9008586789a1) |
| Paid reading · mac/power/watts | reading delivered, exactly $0.001 moved on-chain | 11.4 W in 0.98s | pass | [0x1c40176f…](https://basescan.org/tx/0x1c40176fb626a863abdfc44a835efcad7d240ebf80dbdfafa2aae354dae8522f) |
| Paid reading · mac/cpu/load | reading delivered, exactly $0.001 moved on-chain | 2.06 load in 1.18s | pass | [0xd37f613e…](https://basescan.org/tx/0xd37f613e50a45c6518bfc3ca3f812154f08de4b29e63f8562e00456d49326574) |
| Paid reading · mac/memory/free | reading delivered, exactly $0.001 moved on-chain | 37 % in 1.02s | pass | [0xbdf13cfd…](https://basescan.org/tx/0xbdf13cfd729abefe91610ddee109e629f02bc25b8af46e7e1238ce75d249ed4b) |
| Paid reading · mac/battery/cycles | reading delivered, exactly $0.001 moved on-chain | 1053 cycles in 1.42s | pass | [0x1174f1c3…](https://basescan.org/tx/0x1174f1c3ddcf8340018a64f693c488661a1ee3fedc9505af12d08b5810ef9660) |
| Paid reading · mac/thermal/pressure | reading delivered, exactly $0.001 moved on-chain | normal in 1.28s | pass | [0xac97bee7…](https://basescan.org/tx/0xac97bee7c36497b851cbf31ddbefaa55e12bbcffd118e6a5c1395aa39dbb3ecb) |
| Paid reading · mac/battery/temperature | reading delivered, exactly $0.001 moved on-chain | 31 °C in 1.23s | pass | [0x91b49cbb…](https://basescan.org/tx/0x91b49cbb886c6563e83178d8f6be419ce45cf0f1bda405c5ac4e6c24195f37ec) |
| Paid reading · mac/power/watts | reading delivered, exactly $0.001 moved on-chain | 11.4 W in 1.20s | pass | [0xc3f0a07d…](https://basescan.org/tx/0xc3f0a07d45e16248cd7bbb62c9e0ba9c8ba9df3d9ca010aa0f775f6238b5575c) |
| Paid reading · mac/cpu/load | reading delivered, exactly $0.001 moved on-chain | 2.19 load in 1.05s | pass | [0x11b3e767…](https://basescan.org/tx/0x11b3e767680a45e5c4012e89e8520736e39a45b1fa0ca4939665ecdd477f20b4) |
| Replay a used payment | second use rejected, no second charge | first 200, replay 409 payment already used | pass | [0x4d02b60d…](https://basescan.org/tx/0x4d02b60d16be7789d1ed58a6d775b20053ca1ff6be9a2aeb8a028f960d6b3573) |
| Same request delivered three times (MQTT redelivery) | one settlement; repeats get the same receipt or an in-progress refusal | replies 409, 200, 200, distinct settlements 1 | pass | [0xae53ea91…](https://basescan.org/tx/0xae53ea91ef56786f27ce3abe5a5943dc6dc0b13439cbcd4463a29fbaf12b9345) |
| One payment, two requests at once | one delivered, the other refused, one charge | 200 + 409 | pass | [0x0fe03177…](https://basescan.org/tx/0x0fe031775e6c3d302d3cc2b996decb39e001053e1cb2ee19e1fb19ebb8f1d77b) |
| Underpayment ($0.0005 for a $0.001 reading) | rejected, not charged | 400 payment does not match the quote, charged: false | pass |  |
| Test-network payment sent to a mainnet quote | rejected, not charged | 400 payment does not match the quote | pass |  |
| Device offline (a paid topic with no device publishing) | refused, not charged | 503 device offline, not charged, charged: false | pass |  |
| Unpaid client listens to raw data and another buyer's replies for 12s | no messages delivered | 0 messages received | pass |  |
| Oversized message and a flood of 80 quote requests | oversized dropped, flood rate-limited | 80 replies to 80 requests, 20 rate-limited, oversized ignored | pass |  |
