"""Spec tests for format_bytes.

These tests define the contract. They are WRITE-PROTECTED during the
goalkeeper run: the implementation must change to satisfy them, the
assertions below must not. The exact expected strings here are the spec.
"""

import unittest

from format_bytes import format_bytes


class TestBasic(unittest.TestCase):
    def test_zero(self):
        self.assertEqual(format_bytes(0), "0 B")

    def test_512(self):
        self.assertEqual(format_bytes(512), "512 B")

    def test_1023(self):
        self.assertEqual(format_bytes(1023), "1023 B")

    def test_1024(self):
        self.assertEqual(format_bytes(1024), "1.0 KB")

    def test_1mb(self):
        self.assertEqual(format_bytes(1048576), "1.0 MB")

    def test_1gb(self):
        self.assertEqual(format_bytes(1073741824), "1.0 GB")


class TestRounding(unittest.TestCase):
    def test_1_5_kb(self):
        self.assertEqual(format_bytes(1536), "1.5 KB")

    def test_2_5_kb(self):
        self.assertEqual(format_bytes(2560), "2.5 KB")

    def test_5_mb(self):
        self.assertEqual(format_bytes(5242880), "5.0 MB")


class TestErrors(unittest.TestCase):
    def test_none(self):
        with self.assertRaises(ValueError):
            format_bytes(None)

    def test_negative(self):
        with self.assertRaises(ValueError):
            format_bytes(-5)

    def test_string(self):
        with self.assertRaises(ValueError):
            format_bytes("100")


if __name__ == "__main__":
    unittest.main()
