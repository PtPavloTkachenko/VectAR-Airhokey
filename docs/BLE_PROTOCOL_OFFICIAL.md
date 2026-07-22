# Vector RTS BLE Onboarding — Canonical Byte-Level Reference

Reverse-engineered from the official Anki/DDL **Vector Web Setup** app
(`vector-web-setup.anki.bot`), bundle `rts.js` (480 KB). Every claim cites the
`rts.js` line(s) it came from. This is the authority our
`server/onboarding/ble/*.py` re-implementation is validated against.

Layering (bottom → top):

```
GATT notify/write  →  BleMessageProtocol (multipart, 1-byte header)
                   →  XChaCha20-Poly1305 secure channel (after PIN)
                   →  ExternalComms CLAD envelope (tag/version/msgType)
                   →  RtsConnection_N messages
```

---

## 1. GATT transport

| Item | Value | rts.js |
|---|---|---|
| Service (16-bit) | `0xFEE3` (`0000fee3-0000-1000-8000-00805f9b34fb`) | 17936 |
| **Write** char (app → robot) | `7d2a4bda-d29b-4152-b725-2491478c5cd7` | 17937, 18079 |
| **Notify** char (robot → app) | `30619f2d-0f54-41bd-a65a-7588d8c85b45` | 17938, 18064 |
| Advertise/pairing flag | manufacturer byte `[3] == 'p'` (0x70) | 17939 |
| Notifications | `startNotifications()` on the notify char | 18064 |
| Writes | `readChar.writeValue(msg)` — **write WITH response**, one at a time, paced by a 70 ms tick + FIFO queue | 17950, 18079, 18097 |

> Naming trap: rts.js labels the **write** UUID `readCharService` and the
> **notify** UUID `writeCharService` (17937-17938) — the labels are swapped
> relative to their role. It subscribes on `characteristics[1]`
> (`30619f2d`, notify) and writes to `readChar` (`7d2a4bda`). Our
> `transport.py` (`WRITE_CHAR=7d2a4bda`, `NOTIFY_CHAR=30619f2d`) is **correct**.

---

## 2. Multipart framing — `BleMessageProtocol` (rts.js 55-204)

Every GATT packet ≤ **20 bytes** (`maxPacketSize = 20`, rts.js 17940, 17960).
Byte 0 is a header; bytes 1..N are payload.

### Header byte (rts.js 197-203)

```
bit7 bit6 | bit5 .. bit0
 multipart |    size (payload length in THIS packet)
```

* `getHeaderByte(mp,size) = ((mp<<6) | (size & ~0xC0)) & 0xff`  (rts.js 197-199)
* `getSize(hb) = hb & ~0xC0 = hb & 0x3F`  (rts.js 201-203)
* `getMultipartBits(hb) = (hb>>6) & 0xff`  (rts.js 193-195)
* **Size field is 6 bits → max 63.** With maxPacketSize 20 the payload is ≤ 19,
  so it always fits.

### Multipart state values (rts.js 57-60)

| Name | bits | meaning |
|---|---|---|
| `kMsgContinue` | `0b00` | middle fragment |
| `kMsgEnd` | `0b01` | last fragment (delivers the message) |
| `kMsgStart` | `0b10` | first fragment of a multi-packet message |
| `kMsgSolo` | `0b11` | whole message in one packet |

### Send split — `sendMessage` (rts.js 141-173)

```
if len(msg) < 20:                       →  SOLO(len)                       [144-145]
else, loop:
  first  fragment  → START(19)          [150-156]   (msgSize = maxSize-1 = 19)
  middle fragments → CONTINUE(19)       [163-169]
  last   fragment  → END(remaining 1..19)[157-162]
```

So START/CONTINUE payloads are **always 19 bytes**; END is **1..19**; SOLO is
**0..19**. A 20-byte message ⇒ START(19)+END(1). Never a zero-length END.

### Receive reassembly — `receiveRawBuffer` (rts.js 79-139)

```
size  = hb & 0x3F ;  multi = hb >> 6
if size != len(pkt)-1:  console.log("Size failure"); return   // DROP  [88-91]
switch(multi):
  START   [94-104] : buffer = [] ; buffer += pkt[1:] ; state=CONTINUE
  CONTINUE[105-113]: buffer += pkt[1:]               ; state=CONTINUE
  END     [114-125]: buffer += pkt[1:] ; delegate.handleReceive(buffer) ; state=START
  SOLO    [126-137]: deliver pkt[1:] (buffer LEFT INTACT)               ; state=START
```

* `append(buf)` = `this.buffer.concat(buf.slice(1))` — strips the header byte
  (rts.js 175-177).
* `handleReceive` fires **only** on END (rts.js 121) and SOLO (rts.js 133), and
  resets `state` to START. The state-mismatch `if`s (rts.js 95-97, 106-108,
  115-117, 127-129) have **empty bodies** — they are advisory no-ops, not error
  recovery.
* The delegate is `VectorBluetooth`, whose `handleReceive` fans the reassembled
  message out to `onReceiveEvent` listeners (rts.js 17992-17998) — i.e. the
  active `RtsVxHandler.receive`.

**Our `_Reassembler.feed` (transport.py 62-89) is byte-exact equivalent** —
verified by fuzzing the official `sendMessage` against it, 200 000 random
messages (lengths 0-300), **0 divergences**. One cosmetic difference: our SOLO
case does `self._buf = bytearray()` (transport.py 78) whereas the official
leaves `this.buffer` intact (rts.js 126-137). Irrelevant to any real flow
(a SOLO only appears when no multipart is in progress).

---

## 3. Version handshake (pre-CLAD)

The **first** notify frame from the robot is a bare version announcement, NOT a
CLAD message:

```
frame body = [0x01, version:uint32-LE]      (5 bytes)   rts.js 1503-1506, 1551-1554
```

* `handleRtsHandshake.receive`: `if data[0]==1 && data.length==5` →
  `version = BufferToUInt32(data.slice(1))` (rts.js 1503-1505).
* The app echoes the same 5-byte frame back: `GenerateHandshakeMessage(version)`
  = `[1].concat(Int32ToLE(version))` (rts.js 1551-1554, 1792). Re-framing a
  5-byte message adds a SOLO header `0xC5`, so the wire bytes are
  `C5 01 vv 00 00 00`.
* `HandleHandshake(version)` picks the handler (rts.js 1622-1651):

| version | handler | rts.js |
|---|---|---|
| 2 | RtsV2Handler (factory) | 1644-1646 |
| 3 | RtsV3Handler (dev) | 1640-1642 |
| 4 | RtsV4Handler | 1636-1638 |
| 5 or 7 | RtsV5Handler (7 == 5) | 1631-1634 |
| 6 | RtsV6Handler | 1627-1629 |

**The robot chooses the version; the app adopts it.** Versions differ only in
message *layouts* (e.g. StatusResponse gains fields at v3/v5); the download and
crypto machinery are identical. Our `messages.parse_envelope` echoes the robot's
version on every reply (session.py 111).

> Our `transport.py` treats the first *reassembled* message as this handshake,
> echoes the raw packet verbatim, and records `version = raw[2]` (transport.py
> 158-164) — `raw[2]` is the low byte of the uint32, correct for all real
> versions (2-6).

---

## 4. Crypto handshake

### Sequence

```
robot → app : version frame [01 vv 00 00 00]        (§3)
robot → app : RtsConnRequest { robotPubKey[32] }     tag 0x01   rts.js 12273
app   → robot: RtsConnResponse { connType, appPubKey[32] }  tag 0x02  rts.js 12476-12483
robot → app : RtsNonceMessage { toRobotNonce[24], toDeviceNonce[24] }  tag 0x03  rts.js 12499-12507
                → app shows PIN prompt (first-time pair)          rts.js 12521-12523
app   → robot: RtsAck(0x03)   [LAST PLAINTEXT message]   tag 0x12  rts.js 12512-12514
  --- ENCRYPTION ON both sides ---
robot → app : RtsChallengeMessage { number:u32 }     tag 0x04   rts.js 12526
app   → robot: RtsChallengeMessage { number+1 }      tag 0x04   rts.js 12527-12531
robot → app : RtsChallengeSuccessMessage             tag 0x05   rts.js 12534
```

### Keys (rts.js 12206-12224)

```js
clientKeys = crypto_kx_client_session_keys(myPub, myPriv, robotPub)  // {sharedRx, sharedTx}
sharedRx = crypto_generichash(32, clientKeys.sharedRx, pin)   // BLAKE2b(msg=rx, key=PIN)
sharedTx = crypto_generichash(32, clientKeys.sharedTx, pin)   // BLAKE2b(msg=tx, key=PIN)
cryptoKeys.decrypt = sharedRx
cryptoKeys.encrypt = sharedTx
```

* libsodium calls: `crypto_kx_keypair` (12471), `crypto_kx_client_session_keys`
  (12207), `crypto_generichash` = keyed BLAKE2b-256 (12212-12213),
  `crypto_aead_xchacha20poly1305_ietf_encrypt/decrypt` (12393/12412),
  `sodium.increment` (12401/12420).
* **rx** decrypts robot→app; **tx** encrypts app→robot. The 6-digit PIN is mixed
  into BOTH via keyed BLAKE2b — this proves PIN knowledge without sending it.

### Nonces (rts.js 12504-12507, 12389-12428)

| | seed | rts.js |
|---|---|---|
| encrypt nonce (app→robot) | `toRobotNonce` (24 B) | 12507 |
| decrypt nonce (robot→app) | `toDeviceNonce` (24 B) | 12506 |

* 24-byte XChaCha20 nonce, **`sodium.increment` (LE +1 with carry)** after every
  *successful* op (encrypt 12401; decrypt 12420 — inside the `try`).
* **On decrypt failure** the official DOES NOT increment, deletes the saved
  session, returns `null`, and `receive()` bails (rts.js 12411-12427, 12254-12256).
  A single lost/corrupt message therefore permanently desyncs the nonce stream —
  the app just silently ignores everything after (the download stalls, it does
  not truncate cleanly).

**Our `crypto.py` matches exactly**: `crypto_kx_client_session_keys` →
`crypto_generichash_blake2b_salt_personal(key=pin)` → XChaCha20-Poly1305-IETF
with 24-byte LE-incrementing tx/rx nonces (crypto.py 34-91). Difference: pynacl
**raises** `CryptoError` on a bad MAC (crypto.py 89) instead of returning null —
so on our side a lost packet raises rather than silently stalls. See §7.

### Envelope after decrypt (rts.js 12264-12269, 10206-10211)

```
byte0 = 0x04   ExternalCommsTag.RtsConnection            (rts.js 10209)
byte1 = ver    RtsConnection version tag (2..6)
byte2 = msgTy  RtsConnection_NTag message type
byte3.. = body (little-endian; u8-len strings unless noted u16)
```

Matches `messages.envelope` (`[0x04, version, msg_type] + payload`, messages.py 57).

---

## 5. RTS message catalogue (RtsConnection_5Tag, rts.js 7325-7362)

Tag → name → wire body. `u8/u16/u32` little-endian; `str(k)` = `k`-byte
length prefix + bytes; `farr(n)` = fixed n-byte array; `varr(k)` = `k`-byte
count prefix + elements.

| tag | name | body | rts.js | impl |
|---|---|---|---|---|
| 0x01 | RtsConnRequest ← | `farr(32)` robotPubKey | 2379-2398 | ✅ |
| 0x02 | RtsConnResponse → | `u8` connType + `farr(32)` appPubKey | 2469-2504 | ✅ |
| 0x03 | RtsNonceMessage ← | `farr(24)` toRobotNonce + `farr(24)` toDeviceNonce | 2512-2534 | ✅ |
| 0x04 | RtsChallengeMessage ↔ | `u32` number | 2594 | ✅ |
| 0x05 | RtsChallengeSuccessMessage ← | (empty) | 5019+ | ✅ |
| 0x06 | RtsWifiConnectRequest → | `str1` ssidHex + `str1` pw + `u8` timeout + `u8` authType + `bool` hidden | 2763 | ✅ |
| 0x07 | RtsWifiConnectResponse_3 ← | `str1` ssidHex + `u8` wifiState + `u8` connResult | 12290 | ✅ |
| 0x08 | RtsWifiIpRequest → | (empty) | — | ✅ |
| 0x09 | RtsWifiIpResponse ← | `bool` hasV4 + `bool` hasV6 + `farr(4)` v4 + `farr(16)` v6 | 2962 | ✅ (v4) |
| 0x0A | RtsStatusRequest → | (empty) | — | ✅ |
| 0x0B | RtsStatusResponse_5 ← | `str1` ssidHex + `u8` wifiState + `bool` accessPoint + `u8` bleState + `u8` batteryState + `str1` version + `str1` esn + `bool` otaInProgress + `bool` hasOwner + `bool` isCloudAuthed | 3370 | ✅ |
| 0x0C | RtsWifiScanRequest → | (empty) | — | ✅ |
| 0x0D | RtsWifiScanResponse_3 ← | `u8` statusCode + `varr1` of {`u8` auth, `u8` signal, `str1` ssidHex, `bool` hidden, `bool` provisioned} | 3505 | ✅ |
| 0x0E | RtsOtaUpdateRequest → | `str1` url | 3674 | ✅ |
| 0x0F | RtsOtaUpdateResponse ← | `u8` status + `u64` current + `u64` expected | 3752 | ✅ |
| 0x10 | RtsCancelPairing ↔ | (empty) | 7342 | — |
| 0x11 | RtsForceDisconnect ← | (empty) | 7343 | — |
| 0x12 | RtsAck → | `u8` rtsConnectionTag | 2555 | ✅ |
| 0x13/0x14 | RtsWifiAccessPoint Req/Resp | `bool` enable / `str1` ssid+`str1` pw | — | — |
| 0x15 | RtsSshRequest → | `varr2` of `str1` authorizedKeys chunks | 3963 | ⚠️ firmware no-op |
| 0x16 | RtsSshResponse ← | `u8` exitCode | — | ⚠️ never sent |
| 0x17 | RtsOtaCancelRequest → | (empty) | 12693-12701 | ✅ |
| 0x18 | RtsLogRequest → | `u8` mode + `varr2` of `str1` filter | 4040-4066 | ✅ |
| 0x19 | RtsLogResponse ← | `u8` exitCode + `u32` fileId | 4086-4109 | ✅ |
| 0x1A | RtsFileDownload ← | `u8` status + `u32` fileId + `u32` packetNumber + `u32` packetTotal + `str2` fileChunk | 4129-4162 | ✅ |
| 0x1B/0x1C | RtsWifiForget Req/Resp | `str1` ssid / `bool` didDelete | — | — |
| 0x1D | RtsCloudSessionRequest_5 → | `str2` sessionToken + `str1` clientName + `str1` appId | 4229-4258 | ✅ |
| 0x1E | RtsCloudSessionResponse ← | `bool` success + `u8` statusCode + `str2` clientTokenGuid | 12+ | ✅ |
| 0x1F/0x20 | RtsAppConnectionId Req/Resp | — | 7357-7358 | — |
| 0x21 | RtsResponse ← | (generic reject) | 12333 | — |
| 0x22 | RtsSdkProxyRequest → | `str1` clientGuid + `str1` messageId + `str1` urlPath + `str2` json | — | ✅ |
| 0x23 | RtsSdkProxyResponse ← | `str1` messageId + `u16` statusCode + `str1` responseType + `str2` responseBody | — | ✅ |

(→ app-to-robot, ← robot-to-app, ↔ both.) Envelope tag/version bytes precede
every body. Cross-checked against `messages.py` builders/parsers — all
download-path layouts identical.

* **RtsConnResponse.connType** (RtsConnType): `FirstTimePair=0`, `Reconnection=1`
  (rts.js 12464/12479; messages.py 53-54).
* **RtsSshRequest / RtsSshResponse (0x15/0x16)**: defined in the CLAD schema
  (rts.js 3963) but the reference client registers **no** SSH handler and stock
  firmware never answers — SSH cannot be added over BLE (session.py 294-316).

---

## 6. Log-download sub-protocol

Trigger: `doLog()` sends **`RtsLogRequest(mode=0, filter=[])`** (rts.js
12707-12718). Wire body = `00 00 00` (mode `00`, filter count `0000`). Our
`log_request(mode=0, filters=None)` emits the identical `00 00 00`
(messages.py 164-171).

Flow (rts.js 12336-12377):

```
1. robot → RtsLogResponse{exitCode, fileId}
      exitCode==0 → logId = fileId ; logFile = []          [12336-12342]
2. robot → RtsFileDownload{status, fileId, packetNumber, packetTotal, fileChunk}  (repeat)
      if fileId == logId:                                   [12346]
          logFile = logFile.concat(fileChunk)   ← ARRIVAL ORDER, not indexed  [12347]
          onLogProgress(packetNumber / packetTotal)         [12349-12351, 1752-1753]
          if packetNumber == packetTotal:  DONE             [12366]
3. onLogsDownloaded(name, logFile)                          [12368-12372]
      name = "vector-logs-" + dateString + ".tar.bz2"       [12369]
      Blob(logFile, {type:".tar.gz"}) → browser download    [1778-1789]
```

* Completion is **`packetNumber == packetTotal`** (rts.js 12366). wire-pod's Go
  client uses the same equality for both logs and OTA
  (`ble.go` 57, 77). Our `download_logs` uses `packet >= total` (session.py
  190) — equivalent for a monotonic counter that lands exactly on the total.
* **Chunks are concatenated in arrival order and filtered by `fileId`** — never
  indexed by `packetNumber`. Our `download_logs`/`capture_logs.py` match this;
  `get_robot_key.py` (dict keyed by `packetNumber`, `while len(chunks)<total`)
  encodes the **old frame-count assumption** and is only safe for the "narrowed,
  tiny bundle" path it guards with `--max-packets`.
* **mode / filter**: `mode:u8`, `filter: varr2<str1>`. On observed firmware the
  filter does **not** narrow the bundle (probe_logs.py exists precisely because
  every `(mode,filter)` returned the same huge `PacketTotal`). The full,
  unfiltered bundle is a `tar.bz2` of the robot's logs; on a long-running robot
  it is ~149 k BLE packets (docs/DEV_OWN_ROBOT.md). It contains
  `data/ssh/id_rsa_Vector-XXXX`, the robot's own SSH private key.
* **packetNumber / packetTotal units**: rts.js is agnostic (it only ever divides
  or compares them). Arrival-order concat + `packet==total` completion recovers
  the full bundle under **either** a byte-counter or a frame-counter reading —
  confirmed by end-to-end simulation (see §7). Do NOT rely on the
  "byte counter, verified against rts.js" claim in session.py 262-266 — rts.js
  does not prove the unit.

---

## 7. Where our 30 KB truncation is / is NOT

**Not** in framing, crypto, parse, or completion — every one of those matches
the official app byte-for-byte (proven: 200 k-trial multipart fuzz + full-
pipeline sim recovering the whole 202 KB under both counter models, on a clean
channel).

The real mechanics of loss:

| event | our code (crypto ON) | result |
|---|---|---|
| clean channel | reassemble → decrypt → concat all → `done` at total | **full 202 KB** |
| 1 lost BLE packet mid-message | short logical msg → Poly1305 MAC fail → `CryptoError` **raised** (session.py 89, uncaught in download loop) | **error**, not a short return |
| 1 whole logical msg dropped | next decrypt uses a desynced nonce → `CryptoError` **raised** | **error** |
| genuinely small/partial bundle | `packetNumber==packetTotal` fires at ~30 KB | **clean ~30 KB return** |

So a **clean** "completes, returns ~30 KB" is only consistent with the robot
actually advertising `packetTotal ≈ 30 KB` on frame 1 (a small/partial bundle) —
**not** a reassembly truncation. If instead the run *errors* around 30 KB, that
is BLE notification loss (each loss ⇒ CryptoError) or the 240 s deadline
(session.py 225) firing on a slow link (`raise "…stalled after N bytes"`).

**Confirm which**, before changing transport code, with the existing tool:
`python -m onboarding.capture_logs` prints `*** PacketTotal on frame 1 = N ***`
and whether the blob opens as a tar (capture_logs.py 92-95, 124-140).

---

## 8. OTA sub-protocol (rts.js 12305-12332, 1310, 1738-1750)

```
app → RtsOtaUpdateRequest{ url }                            tag 0x0E
robot → RtsOtaUpdateResponse{ status:u8, current:u64, expected:u64 } (repeat)  tag 0x0F
    onOtaProgress(current/expected)                         [12308-12310]
    waitForResponse=="ota-start": status==3 → resolve ; status>=5 → reject  [12321-12326]
    complete when current == expected                       (ble.go 57 mirror)
app → RtsOtaCancelRequest{} to abort                        tag 0x17  [12693-12701]
```

* `status` 0/1 = in-progress/ok; `>=5` = error; wire-pod treats `214` as a
  build-type mismatch (ankidev vs production). The BLE link drops when the robot
  reboots into the new image — that drop is success, not failure (session.py
  360-367). Our `parse_ota_update_response` (messages.py 235-248) matches
  (`status:u8 + current:u64 + expected:u64`).

---

## 9. UI / flow state machine (index.html)

`setPhase(container)` swaps the visible `.vec-container`. Phases → protocol step:

| container | index.html | protocol step | rts.js |
|---|---|---|---|
| containerIncompatible / containerEnvironment(Error) | 69/90/104 | Web-Bluetooth capability gate | — |
| containerDiscover | 119 | `btnDiscoverVector` → `vecBle.tryConnect` | 1801-1804 |
| containerLoading | 163 | connecting / working | 1802, 1810 |
| containerEnterPin | 170 | `onReadyForPin` (after Nonce) → `btnEnterPin`→`enterPin` | 1655-1656, 1807-1811 |
| containerWifi | 213 | `doWifiScan` → list networks | 1556-1560 |
| containerWifiConfig | 226 | `doWifiConnect(ssid,pw,auth,15)` | 1197 |
| containerAccount | 250 | cloud login / `doAnkiAuth` (session token) | 1960 |
| containerSettings | 357 | status panel; **Save Logs → `doLog`** ; CLI | 2156 |
| containerOta / containerOtaComplete | 403/453 | `doOtaStart(url)` → progress → `containerDiscover` | 1310, 1745 |
| containerComplete | 445 | onboarding done | — |

After the encrypted channel is up, `onEncryptedConnection` (rts.js 1668) auto-
drives `doStatus` then `doWifiScan`. "Save Logs" is a manual button in
containerSettings that calls `rtsHandler.doLog()` (rts.js 2156) and streams the
bundle to a browser download (rts.js 1778-1789).

---

## Appendix — libsodium calls used (rts.js)

| function | purpose | rts.js |
|---|---|---|
| `crypto_kx_keypair` | app X25519 keypair | 12471 |
| `crypto_kx_client_session_keys` | (rx,tx) from (appPriv, appPub, robotPub) | 12207 |
| `crypto_generichash(32, key, pin)` | keyed BLAKE2b — mix PIN into rx/tx | 12212-12213 |
| `crypto_aead_xchacha20poly1305_ietf_encrypt` | app→robot | 12393 |
| `crypto_aead_xchacha20poly1305_ietf_decrypt` | robot→app | 12412 |
| `sodium.increment` | LE +1 nonce, per successful op | 12401, 12420 |
