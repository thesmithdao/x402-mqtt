# Transport: MQTT

## Summary

The MQTT transport carries x402 payment flows over MQTT, the messaging protocol most connected devices already speak. It lets agents pay for device data such as sensor readings, and lets devices sell that data without holding keys or running a web server.

It reuses the x402 v2 objects unchanged: `PaymentRequired`, `PaymentPayload` and `SettleResponse`. The keys `x402/payment` and `x402/payment-response` match the MCP transport. The transport works on MQTT 3.1.1 and 5.0 brokers because all request and reply data travels in the message body.

### Topics

| Topic | Direction | Purpose |
|---|---|---|
| `x402/v1/catalog` | seller → all (retained) | Offers for sale, each with its `accepts` |
| `x402/v1/req/<topic>` | buyer → seller | Request for `<topic>`, with or without payment |
| `x402/v1/res/<clientId>/…` | seller → buyer | Replies, on a topic only that buyer can read |
| `raw/<topic>` | device → seller | The device's own readings, private to the seller |

Brokers MUST restrict `raw/#` so only the seller can read it, and MUST restrict `x402/v1/res/<clientId>/#` so only the client with that id can read it.

Requests carry payments that can be settled, so buyers MUST reach remote brokers over TLS (`mqtts://` or `wss://`). The broker and the seller see every payment. A buyer's client id is the key to its replies: it MUST be random, at least 128 bits, and never shared.

## Payment Flow Overview

1. The buyer publishes a request for a topic without payment.
2. The seller replies with status `402` and a `PaymentRequired`.
3. The buyer creates a `PaymentPayload` for one of the `accepts` entries.
4. The buyer publishes the same request again, with the payment in `x402/payment`.
5. The seller verifies the payment, makes sure it has a fresh reading, settles, and only then replies.
6. The reply carries the reading in `result` and the settlement in `x402/payment-response`.

## Payment Required Signaling

**Mechanism**: a reply with `status: 402` published to the request's `replyTo`
**Data Format**: `PaymentRequired`

Request:

```json
{ "id": "7d0f5b4e", "replyTo": "x402/v1/res/x402-buyer-1a2b3c/7d0f5b4e" }
```

published to `x402/v1/req/mac/battery/temperature`.

Reply:

```json
{
  "id": "7d0f5b4e",
  "status": 402,
  "paymentRequired": {
    "x402Version": 2,
    "resource": {
      "url": "mqtt://127.0.0.1:1884/mac/battery/temperature",
      "description": "Battery temperature",
      "mimeType": "application/json"
    },
    "accepts": [
      {
        "scheme": "exact",
        "network": "eip155:8453",
        "amount": "1000",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "payTo": "0x9A4A53e4F4345bCe286Cd47d9c3B3Ef3b7992f69",
        "maxTimeoutSeconds": 120,
        "extra": { "name": "USD Coin", "version": "2" }
      }
    ]
  }
}
```

`id` is 1–64 characters of `[A-Za-z0-9_-]`. `replyTo` MUST start with `x402/v1/res/`.

## Payment Payload Transmission

**Mechanism**: the `x402/payment` field of the request
**Data Format**: `PaymentPayload`

```json
{
  "id": "7d0f5b4e",
  "replyTo": "x402/v1/res/x402-buyer-1a2b3c/7d0f5b4e",
  "x402/payment": {
    "x402Version": 2,
    "accepted": { "scheme": "exact", "network": "eip155:8453", "amount": "1000", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "payTo": "0x9A4A53e4F4345bCe286Cd47d9c3B3Ef3b7992f69", "maxTimeoutSeconds": 120, "extra": { "name": "USD Coin", "version": "2" } },
    "payload": { "signature": "0x…", "authorization": { "from": "0x3B8b…F573", "to": "0x9A4A…2f69", "value": "1000", "validAfter": "…", "validBefore": "…", "nonce": "0x…" } }
  }
}
```

A buyer that gets no reply MUST resend the same request with the same `id` and the same payment. It MUST NOT sign a new payment for the same request.

Whoever holds a signed payment can settle it until it expires. Buyers MUST count every signed payment as spent until expiry and chain evidence establish it unused, whatever the reply says. EVM uses `validBefore` and token authorization state. Solana uses the signed recent blockhash and complete finalized history; a wall-clock timeout is insufficient.

## Settlement Response Delivery

**Mechanism**: the `x402/payment-response` field of a `status: 200` reply
**Data Format**: `SettleResponse`

```json
{
  "id": "7d0f5b4e",
  "status": 200,
  "result": { "value": 31.4, "unit": "°C", "ts": 1790544651036 },
  "x402/payment-response": {
    "success": true,
    "transaction": "0xec7f730c4c9a4b6d53dba1cb9f308aa63853f78536eacb293c72cd52de8ce130",
    "network": "eip155:8453",
    "payer": "0x3B8b93fc86Ad4Af0600C7fe5fE38B15B7A3dF573"
  }
}
```

The seller MUST retain the fresh reading and reconciliation metadata before settlement, and reply with the reading only after payment succeeds. If a reply is lost, the same request/payment recovers that original reading. Readings more than 5 seconds in the future are refused.

Sellers MUST make payments idempotent per network and payment identity: `(payer, nonce)` on EVM, immutable transaction message hash on Solana. Hashing Solana wire bytes is insufficient because the facilitator supplies the fee-payer signature. An identical settled request with the same `id` and topic gets the same reply after caller-signature validation. Reuse under another `id` or topic is refused. A new purchase uses a new request ID.

## Solana

Solana offers use x402 v2 `exact`, network `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, and canonical six-decimal USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. Requirements include the facilitator's `extra.feePayer`. The payment payload contains a base64 partially signed transaction; the receipt transaction is its final base58 signature. Public keys and signatures are case-sensitive.

0.2.0 accepts the SDK's ordinary keypair transaction: compute-unit limit, compute-unit price, one exact SPL `TransferChecked`, and a memo. Source and destination are the derived USDC token accounts. Required signers are the buyer and facilitator. Compute limits are at most 400,000 units and 50,000 microlamports per unit. Lookup tables, durable nonces and smart-wallet/CPI transactions are unsupported. Token accounts must already exist.

The seller persists the message hash, token accounts, blockhash, submission context and original reading, never signed payment credentials. After an interrupted settlement it checks the known signature, or bounded recent source-account history for that exact message. Incomplete history or an unavailable RPC leaves payment pending. Saved payments retain their original fee payer when the facilitator advertises a new one; signature and quote checks still apply. Startup recovery has a bounded work window; remaining entries are reconciled on the same request's retry. One seller process owns a ledger.

## Error Handling

Errors are replies with a non-200 `status` and an `error` string:

| Status | Meaning | Payment |
|---|---|---|
| `400` | Payment invalid or does not match the quote | No |
| `402` | Payment required (the quote) | No |
| `404` | Nothing for sale on this topic | No |
| `409` | Payment already used, or already in progress | Original payment may exist; no new settlement |
| `429` | Too many requests | No |
| `503` | Device offline, facilitator unavailable before settlement | No settlement submitted |
| `503` | Settlement pending or confirmation unavailable | May have paid; retry the same request/payment |

Requests larger than 16 KB, or without a valid `id` and `replyTo`, are dropped with no reply.

`replyTo` is chosen by the sender, so it is not an identity. Sellers SHOULD check the payment against the quote, its signature and the payer's balance before calling the facilitator, and SHOULD rate-limit paid requests per paying wallet. Brokers that can read message bodies SHOULD only accept a request whose `replyTo` is under the sender's own client id.

If settlement fails or times out, the seller MUST check the chain before deciding (for `exact` on EVM, `authorizationState(from, nonce)` on the token, then the transaction that used the nonce). It delivers only if that transaction moved the exact amount from the payer to its `payTo`. A used or cancelled nonce on its own is not payment.

## References

- [x402 transport template](https://github.com/x402-foundation/x402/blob/main/specs/transport_template.md)
- [x402 MCP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md)
- [MQTT 3.1.1](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/mqtt-v3.1.1.html) and [MQTT 5.0](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)
- [EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)
