# Evidence

Base mainnet, 2026-09-27: A MacBook Air sells its sensor readings over MQTT (Mosquitto 2.1.2) and gets paid in USDC through the Coinbase facilitator.

The buyers are test wallets run by Cult OS. These are our own purchases, made to prove the pipeline, not customer sales.

- Payout: `0x9A4A53e4F4345bCe286Cd47d9c3B3Ef3b7992f69`
- Buyers: `0x3B8b93fc86Ad4Af0600C7fe5fE38B15B7A3dF573`, `0x1d49c4dedA1E447abeb4b309D8B9Fb55a196a1a9`
- Result: 18 of 18 scenarios passed
- Paid reading, full round trip (quote, sign, settle, deliver): median 1.12s, slowest 5% 1.83s

| Scenario | Expected | Result | Status | Proof |
|---|---|---|---|---|
| Paid reading · mac/battery/temperature | reading delivered, exactly $0.001 moved on-chain | 31.4 °C in 1.83s | pass | [0x7beb1988…](https://basescan.org/tx/0x7beb198812cbd809455563f7d01dab78e66506ced8e4e35e851d619f5c45c43e) |
| Paid reading · mac/battery/level | reading delivered, exactly $0.001 moved on-chain | 41 % in 1.12s | pass | [0x9e83f3a7…](https://basescan.org/tx/0x9e83f3a7fd27574167c4f2fc560141558df4e0792077788c27787a6c80520125) |
| Paid reading · mac/power/watts | reading delivered, exactly $0.001 moved on-chain | 11 W in 0.80s | pass | [0x06d0314a…](https://basescan.org/tx/0x06d0314acb4b5c86bf8f54b9d607b0f165d926b8bdb18c0cff4c521a8c8c4266) |
| Paid reading · mac/cpu/load | reading delivered, exactly $0.001 moved on-chain | 4.75 load in 1.04s | pass | [0xbe404d31…](https://basescan.org/tx/0xbe404d31a41eee25bac278ff2d0d99d93c1ef5d694c0dea6ec3e05412ad3f77b) |
| Paid reading · mac/memory/free | reading delivered, exactly $0.001 moved on-chain | 40 % in 1.39s | pass | [0xcd5e95ab…](https://basescan.org/tx/0xcd5e95abc7f9fc0d5291520dee6e569ca60404be3f3c58fe70887eb3fd0704e8) |
| Paid reading · mac/battery/cycles | reading delivered, exactly $0.001 moved on-chain | 1052 cycles in 1.29s | pass | [0xb6c260f5…](https://basescan.org/tx/0xb6c260f50829395ce10537de0004afedd90e2eb4b2e97871919c4704a6e1f533) |
| Paid reading · mac/thermal/pressure | reading delivered, exactly $0.001 moved on-chain | normal in 0.96s | pass | [0xd8186068…](https://basescan.org/tx/0xd81860681e390d7f3b7089058cee9223bd673dbdddf262659c61cd7fe90ecc52) |
| Paid reading · mac/battery/temperature | reading delivered, exactly $0.001 moved on-chain | 31.4 °C in 0.96s | pass | [0xef31ee45…](https://basescan.org/tx/0xef31ee45ca92cf253740222c5a7cc118593a611ef65f25aec2cbd9b3d123d985) |
| Paid reading · mac/power/watts | reading delivered, exactly $0.001 moved on-chain | 11 W in 1.24s | pass | [0xb7722aa8…](https://basescan.org/tx/0xb7722aa8601194a460443c9a70106dbb657b864bd4fd08ef806a5b31680c140f) |
| Paid reading · mac/cpu/load | reading delivered, exactly $0.001 moved on-chain | 5.24 load in 1.09s | pass | [0xe574cdd3…](https://basescan.org/tx/0xe574cdd30065078c98c58180a967d9eb983367f7a0794a769472ece60be49155) |
| Replay a used payment | second use rejected, no second charge | first 200, replay 409 payment already used | pass | [0x414305f6…](https://basescan.org/tx/0x414305f6c105f4264a471f4bae200d4f7823fe076e0db291aa1d6e9de0d521bc) |
| Same request delivered three times (MQTT redelivery) | one settlement; repeats get the same receipt or an in-progress refusal | replies 409, 200, 200, distinct settlements 1 | pass | [0x1f615b84…](https://basescan.org/tx/0x1f615b8483868bd7d31c94e928c4f0b648bb30a697b57c48f051e30c38e6376c) |
| One payment, two requests at once | one delivered, the other refused, one charge | 200 + 409 | pass | [0x5e0348cf…](https://basescan.org/tx/0x5e0348cf6de822facaf558d760f32b0c91eb8134989d8b9a88e2bff68e3eaa38) |
| Underpayment ($0.0005 for a $0.001 reading) | rejected, not charged | 400 payment does not match the quote, charged: false | pass |  |
| Test-network payment sent to a mainnet quote | rejected, not charged | 400 payment does not match the quote | pass |  |
| Device offline (a paid topic with no device publishing) | refused, not charged | 503 device offline, not charged, charged: false | pass |  |
| Unpaid client listens to raw data and another buyer's replies for 12s | no messages delivered | 0 messages received | pass |  |
| Oversized message and a flood of 80 quote requests | oversized dropped, flood rate-limited | 80 replies to 80 requests, 20 rate-limited, oversized ignored | pass |  |
