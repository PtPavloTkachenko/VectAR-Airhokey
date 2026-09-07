"""Unit tests for the pairing core — no robot, no wire-pod, no network."""
import configparser

import pytest

from game_bridge.web import pairing
from game_bridge.web.pairing import PairingError


# --- standardize_name ---

@pytest.mark.parametrize("raw,expected", [
    ("Vector-A1B2", "Vector-A1B2"),
    ("vector-a1b2", "Vector-A1B2"),
    ("a1b2", "Vector-A1B2"),
    ("  Vector-Z9Y8  ", "Vector-Z9Y8"),
])
def test_standardize_name(raw, expected):
    assert pairing.standardize_name(raw) == expected


def test_standardize_name_rejects_garbage():
    with pytest.raises(PairingError) as e:
        pairing.standardize_name("robot")
    assert e.value.step == pairing.STEP_CERT
