"""Pure reference checks only. NOT application, DB concurrency, or payment tests."""
import unittest
import unicodedata
from datetime import datetime, timezone

def name_key(raw: str) -> str:
    if not isinstance(raw, str):
        raise TypeError("name must be text")
    text = unicodedata.normalize("NFKC", raw).translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))
    # Hiragana to Katakana for search only; never a person identifier.
    text = "".join(chr(ord(c) + 0x60) if 0x3041 <= ord(c) <= 0x3096 else c for c in text)
    return " ".join(text.split())

def cap_allows(mode: str, value: int | None, used: int, added: int) -> bool:
    if used < 0 or added < 0:
        raise ValueError("counts must be nonnegative")
    if mode == "UNSET": return False
    if mode == "UNLIMITED": return value is None
    if mode != "LIMITED" or value is None or value < 0: return False
    return used + added <= value

def balance(sales: int, deposit_applied: int, paid_later: int = 0) -> int:
    if min(sales, deposit_applied, paid_later) < 0: raise ValueError("nonnegative required")
    return sales - deposit_applied - paid_later

class ReferenceChecks(unittest.TestCase):
    def test_width(self): self.assertEqual(name_key("ＤＪ　Ａ"), "dj a")
    def test_kana(self): self.assertEqual(name_key("やまだ"), name_key("ﾔﾏﾀﾞ"))
    def test_not_kanji_inference(self): self.assertNotEqual(name_key("山田"), name_key("やまだ"))
    def test_names_are_not_identity(self):
        records = [{"id":"customer-1","name":"田中"},{"id":"customer-2","name":"田中"}]
        self.assertEqual(len({r["id"] for r in records}), 2)
    def test_unset(self): self.assertFalse(cap_allows("UNSET",None,0,1))
    def test_explicit_unlimited(self): self.assertTrue(cap_allows("UNLIMITED",None,1000,1))
    def test_limited_boundary(self): self.assertTrue(cap_allows("LIMITED",3,2,1))
    def test_limited_over(self): self.assertFalse(cap_allows("LIMITED",3,2,2))
    def test_negative(self):
        with self.assertRaises(ValueError): cap_allows("LIMITED",3,0,-1)
    def test_deposit_not_sales(self): self.assertEqual(balance(80000,20000),60000)
    def test_reward_example(self): self.assertEqual(14*500,7000)
    def test_time_half_open(self):
        a=datetime(2026,9,15,13,tzinfo=timezone.utc);b=datetime(2026,9,15,20,tzinfo=timezone.utc)
        self.assertTrue(a<=a<b); self.assertFalse(a<=b<b)
    def test_referrer_not_approver(self):
        visit={"referrer":"dj-a","decision_actor":"gate-b","count":2}
        self.assertEqual(visit["referrer"],"dj-a")
if __name__ == "__main__": unittest.main(verbosity=2)
