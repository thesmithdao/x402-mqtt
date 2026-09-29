# Evidence

Real runs on Base mainnet, 2026-09-29. A MacBook Air sells its sensor readings over MQTT (Mosquitto 2.1.2) and gets paid in USDC through the Coinbase facilitator. Nothing is mocked: every paid row links to its settlement on Basescan, and every "not charged" row was checked against the USDC contract.

The buyers are test wallets run by Cult OS. These are our own purchases, made to prove the pipeline, not customer sales.

- Payout: `0x9A4A53e4F4345bCe286Cd47d9c3B3Ef3b7992f69`
- Buyers: `0x3B8b93fc86Ad4Af0600C7fe5fE38B15B7A3dF573`, `0x1d49c4dedA1E447abeb4b309D8B9Fb55a196a1a9`
- Result: 18 of 18 scenarios passed
- Paid reading, full round trip (quote, sign, settle, deliver): median 1.10s, slowest 5% 1.62s

| Scenario | Expected | Result | Status | Proof |
|---|---|---|---|---|
| Paid reading · mac/battery/temperature | reading delivered, exactly $0.001 moved on-chain | 30.8 °C in 1.62s | pass | [0xac9e4072…](https://basescan.org/tx/0xac9e40722258f27155c3689e202950b3892d08c4d536d45eb9f08bd3cb5ab081) |
| Paid reading · mac/battery/level | reading delivered, exactly $0.001 moved on-chain | 99 % in 1.32s | pass | [0xb3706494…](https://basescan.org/tx/0xb370649457b57651bc7e946afe1229aa073f385fe5c60d64ee8a26a4664fcb25) |
| Paid reading · mac/power/watts | reading delivered, exactly $0.001 moved on-chain | 8.3 W in 1.04s | pass | [0x8c9676d7…](https://basescan.org/tx/0x8c9676d7bc7887d5e467c44f6ca47ca60b90db6c4fc8e0c3ff4eed5bafd8f839) |
| Paid reading · mac/cpu/load | reading delivered, exactly $0.001 moved on-chain | 1.9 load in 0.98s | pass | [0x9bcc2d1c…](https://basescan.org/tx/0x9bcc2d1c638bc34ae17ca70b4967e0a4b488a6390059c445744a1169c04650a4) |
| Paid reading · mac/memory/free | reading delivered, exactly $0.001 moved on-chain | 34 % in 0.99s | pass | [0x6d0867e7…](https://basescan.org/tx/0x6d0867e7168c6eaea6a7ab425f5660b4e82ae313e3b3b6aaac6e11adcbb26d94) |
| Paid reading · mac/battery/cycles | reading delivered, exactly $0.001 moved on-chain | 1055 cycles in 1.08s | pass | [0x3edbe675…](https://basescan.org/tx/0x3edbe675e4971c0e45b99132e88a3ca44dfd7d7e7c773f24676f04ede0965776) |
| Paid reading · mac/thermal/pressure | reading delivered, exactly $0.001 moved on-chain | normal in 1.10s | pass | [0x5ef62b1a…](https://basescan.org/tx/0x5ef62b1a29ac8bd967cf0ce96a706aa51ee382b183139caf7f40414fa464802f) |
| Paid reading · mac/battery/temperature | reading delivered, exactly $0.001 moved on-chain | 30.8 °C in 1.08s | pass | [0x2088a8e9…](https://basescan.org/tx/0x2088a8e9a670aa016cda7c32fbbd3ee40207d20f70a603107f147c486dd16c1e) |
| Paid reading · mac/power/watts | reading delivered, exactly $0.001 moved on-chain | 8.3 W in 1.23s | pass | [0x848913df…](https://basescan.org/tx/0x848913dfc2f256b91f1a0116c903c51a187bcd48bff32adc90673f69d84c2774) |
| Paid reading · mac/cpu/load | reading delivered, exactly $0.001 moved on-chain | 1.97 load in 1.17s | pass | [0xabceb7bb…](https://basescan.org/tx/0xabceb7bb7aa48b9da442031fca5c9e824929cdf18abcb2ec20bc37ebe4519896) |
| Replay a used payment | second use rejected, no second charge | first 200, replay 409 payment already used | pass | [0xaa8aa3d2…](https://basescan.org/tx/0xaa8aa3d2c51ad31ad0f05d18c05780be0a94b59b3612104d9f3c1dccb6833bb6) |
| Same request delivered three times (MQTT redelivery) | one settlement; repeats get the same receipt or an in-progress refusal | replies 409, 200, 200, distinct settlements 1 | pass | [0x94bc1407…](https://basescan.org/tx/0x94bc1407882546f360ffc4e88c9d2dbf5c555e83676213bf7d6d0710e2462faa) |
| One payment, two requests at once | one delivered, the other refused, one charge | 200 + 409 | pass | [0xb91f71ae…](https://basescan.org/tx/0xb91f71ae69168cb1dac525f70b5ab40fcbcfc669b0719a48e876987306a5f15a) |
| Underpayment ($0.0005 for a $0.001 reading) | rejected, not charged | 400 payment does not match the quote, charged: false | pass |  |
| Test-network payment sent to a mainnet quote | rejected, not charged | 400 payment does not match the quote | pass |  |
| Device offline (a paid topic with no device publishing) | refused, not charged | 503 device offline, not charged, charged: false | pass |  |
| Unpaid client listens to raw data and another buyer's replies for 12s | no messages delivered | 0 messages received | pass |  |
| Oversized message and a flood of 80 quote requests | oversized dropped, flood rate-limited | 80 replies to 80 requests, 20 rate-limited, oversized ignored | pass |  |
