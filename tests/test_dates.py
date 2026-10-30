import datetime as dt
import unittest

from sprintweek.dates import looks_like_date, parse_loose_date

WEEK = [dt.date(2026, 10, 26) + dt.timedelta(days=i) for i in range(5)]  # Mon Oct 26 - Fri Oct 30
THU = dt.date(2026, 10, 29)


class TestLooseDates(unittest.TestCase):
    def test_accepted_forms(self):
        for text in (
            "2026-10-29", "2026-10-29 ", "**2026-10-29**", "Thursday", "thu.", "Thurs", "Thu Oct 29",
            "Thursday, October 29",
            "October 29", "Oct 29th", "29 Oct", "29 October 2026", "Oct 29, 2026", "10/29", "29/10", "29.10.2026",
            "10/29/26",
        ):  # fmt: skip
            with self.subTest(text=text):
                self.assertTrue(looks_like_date(text))
                self.assertEqual(parse_loose_date(text, WEEK), (THU, ""))

    def test_placeholder_and_empty_mean_no_date(self):
        for text in ("YYYY-MM-DD", "yyyy-mm-dd", "", "  "):
            self.assertEqual(parse_loose_date(text, WEEK), (None, ""))

    def test_problems(self):
        cases = {
            "2026-10-32": "is not a date",
            "Saturday": "no Saturday",
            "2026-11-30": "not during the Sprint Week",
            "10/11": "could be read as Oct 11 or Nov 10",
            "tomorrow": "is not a date",
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                date, problem = parse_loose_date(text, WEEK)
                self.assertIsNone(date)
                self.assertIn(expected, problem)

    def test_explicit_date_beats_weekday(self):
        self.assertEqual(parse_loose_date("Monday Oct 29", WEEK), (THU, ""))

    def test_not_dates(self):
        for text in ("Wednesday was fun", "day 5", "Monster", "Dated results"):
            self.assertFalse(looks_like_date(text), text)


if __name__ == "__main__":
    unittest.main()


class TestHostileInput(unittest.TestCase):
    def test_long_repeated_weekdays_do_not_crash(self):
        text = "mon " * 5000
        self.assertFalse(looks_like_date(text))
        date, problem = parse_loose_date(text, WEEK)
        self.assertIsNone(date)
        self.assertIn("too long", problem)
