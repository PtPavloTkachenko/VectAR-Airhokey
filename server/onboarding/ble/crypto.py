"""Vector RTS BLE crypto (v5) — libsodium via pynacl.

Handshake key schedule (from the reversed protocol, DECISIONS #74):
  - both sides generate an X25519 keypair,
  - client derives session keys with crypto_kx (client side),
  - the 6-digit PIN shown on Vector's face is mixed in via keyed BLAKE2b,
  - the channel is XChaCha20-Poly1305-IETF with 24-byte little-endian
    incrementing nonces (separate tx / rx counters).

This module is transport-agnostic: it only turns plaintext<->ciphertext and
manages the nonce counters. The exact handshake message payloads live in
handshake.py.
"""
from __future__ import annotations

import nacl.bindings as sodium

KEY_BYTES = sodium.crypto_kx_SESSION_KEY_BYTES        # 32
NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES  # 24


def generate_keypair() -> tuple[bytes, bytes]:
    """(public, secret) X25519 keypair for crypto_kx."""
    return sodium.crypto_kx_keypair()


def client_session_keys(client_pk: bytes, client_sk: bytes,
                        server_pk: bytes) -> tuple[bytes, bytes]:
    """(rx, tx) shared session keys, client side.

    crypto_kx_client_session_keys returns (rx, tx): rx decrypts data FROM the
    server (robot), tx encrypts data TO the server.
    """
    rx, tx = sodium.crypto_kx_client_session_keys(client_pk, client_sk,
                                                  server_pk)
    return rx, tx


def pin_mix(key: bytes, pin: str) -> bytes:
    """Keyed BLAKE2b of the session key with the PIN as the key.

    The RTS v5 handshake proves knowledge of the PIN by mixing it into the
    session keys before the encrypted channel opens. `pin` is the 6 digits
    Vector shows on his face after a backpack double-press.
    """
    pin_bytes = pin.encode("ascii")
    return sodium.crypto_generichash_blake2b_salt_personal(
        key, digest_size=KEY_BYTES, key=pin_bytes)


def derive_channel_keys(rx: bytes, tx: bytes, pin: str) -> tuple[bytes, bytes]:
    """(decrypt_key, encrypt_key) — keyed BLAKE2b of each session key with the
    ASCII PIN as the key (setpin.go:28-29). rx decrypts robot->app, tx
    encrypts app->robot."""
    return pin_mix(rx, pin), pin_mix(tx, pin)


class SecureChannel:
    """XChaCha20-Poly1305-IETF channel with LE-incrementing 24-byte nonces.

    Built AFTER the PIN is entered. Nonces are seeded from the robot's
    NonceMessage: encrypt uses ToRobotNonce, decrypt uses ToDeviceNonce
    (nonce.go:17-21); both increment (LE +1) after every op.
    """

    def __init__(self, decrypt_key: bytes, encrypt_key: bytes,
                 to_robot_nonce: bytes, to_device_nonce: bytes):
        self._dec_key = decrypt_key
        self._enc_key = encrypt_key
        self._enc_nonce = bytearray(to_robot_nonce)
        self._dec_nonce = bytearray(to_device_nonce)

    @staticmethod
    def _inc(nonce: bytearray) -> None:
        # sodium_increment: little-endian +1 with carry across all 24 bytes
        c = 1
        for i in range(len(nonce)):
            c += nonce[i]
            nonce[i] = c & 0xFF
            c >>= 8

    def encrypt(self, plaintext: bytes) -> bytes:
        ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            plaintext, b"", bytes(self._enc_nonce), self._enc_key)
        self._inc(self._enc_nonce)
        return ct

    def decrypt(self, ciphertext: bytes) -> bytes:
        pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
            ciphertext, b"", bytes(self._dec_nonce), self._dec_key)
        self._inc(self._dec_nonce)
        return pt
