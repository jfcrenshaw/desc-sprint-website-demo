import unittest

from sprintweek.sessions import (
    SessionError,
    encode_session_data,
    extract_session_data,
    normalize_session,
    render_session_comment,
)

BASE = {"date": "2026-10-27", "start": "14:00", "end": "16:00", "tz": "Europe/Paris"}


def session(**kw):
    return normalize_session({**BASE, **kw})


class TestNormalize(unittest.TestCase):
    def test_utc_conversion_paris_after_dst(self):
        # Europe switched back to CET (UTC+1) on 2026-10-25.
        s = session()
        self.assertEqual((s["start_utc"], s["end_utc"]), ("2026-10-27T13:00:00Z", "2026-10-27T15:00:00Z"))
        self.assertEqual(s["tz_abbr"], "CET")

    def test_utc_conversion_paris_before_dst(self):
        s = session(date="2026-10-23")
        self.assertEqual(s["start_utc"], "2026-10-23T12:00:00Z")
        self.assertEqual(s["tz_abbr"], "CEST")

    def test_utc_conversion_pacific(self):
        # The US stays on daylight time until 2026-11-01.
        s = session(tz="America/Los_Angeles", start="09:00", end="10:30")
        self.assertEqual((s["start_utc"], s["end_utc"]), ("2026-10-27T16:00:00Z", "2026-10-27T17:30:00Z"))
        self.assertEqual(s["tz_abbr"], "PDT")

    def test_single_digit_hours(self):
        s = session(start="9:05", end="9:45")
        self.assertEqual((s["start"], s["end"]), ("09:05", "09:45"))

    def test_modes(self):
        self.assertEqual(session()["mode"], "")
        self.assertEqual(session(location="Redwood C")["mode"], "in person")
        self.assertEqual(session(site="Paris")["mode"], "in person")
        self.assertEqual(session(online="https://zoom.us/j/1")["mode"], "online")
        self.assertEqual(session(location="Redwood C", online="https://zoom.us/j/1")["mode"], "hybrid")

    def test_text_is_single_line_and_truncated(self):
        s = session(location="Room\n\n  101\t", note="x" * 1000)
        self.assertEqual(s["location"], "Room 101")
        self.assertEqual(len(s["note"]), 300)

    def test_bad_login_is_dropped(self):
        self.assertEqual(session(by="good-login")["by"], "good-login")
        self.assertEqual(session(by="bad)(login")["by"], "")

    def test_invalid_entries(self):
        cases = {
            "date": [{"date": "27/10/2026"}, {"date": "2026-02-30"}, {"date": ""}],
            "time": [{"start": "2pm"}, {"end": "25:00"}, {"start": None}],
            "before": [{"start": "16:00", "end": "14:00"}, {"end": "14:00"}],
            "time zone": [{"tz": "CET-ish"}, {"tz": ""}, {"tz": "../../etc/passwd"}],
            "https": [{"online": "javascript:alert(1)"}, {"online": "http://zoom.us/j/1"}],
            "text": [{"location": ["not", "text"]}],
        }
        for expected, variants in cases.items():
            for kw in variants:
                with self.subTest(kw=kw), self.assertRaises(SessionError) as ctx:
                    session(**kw)
                self.assertIn(expected, str(ctx.exception))


class TestCommentRoundTrip(unittest.TestCase):
    def test_render_then_extract(self):
        s = session(location="Salle <b>3</b> & co -->", online="https://zoom.us/j/1", label="Kickoff", by="alice")
        body = render_session_comment(
            s, [("SLAC", "America/Los_Angeles"), ("Paris", "Europe/Paris")], "https://bot/edit/1"
        )
        self.assertNotIn("<b>", body.split("-->", 1)[0])  # user text cannot close the hidden comment early
        data = extract_session_data(body)
        self.assertEqual(data["location"], "Salle <b>3</b> & co -->")
        self.assertEqual(normalize_session(data)["start_utc"], s["start_utc"])
        self.assertIn("06:00–08:00 PDT (SLAC)", body)
        self.assertNotIn("(Paris)", body)  # no conversion into the session's own zone
        self.assertIn("https://bot/edit/1", body)

    def test_mentions_are_defanged(self):
        body = render_session_comment(session(note="ping @everyone", by="alice"))
        self.assertNotIn("@everyone", body.split("-->", 1)[1])

    def test_day_change_is_shown(self):
        body = render_session_comment(session(start="08:00", end="09:00"), [("SLAC", "America/Los_Angeles")])
        self.assertIn("00:00–01:00 PDT (SLAC)", body)
        late = render_session_comment(session(start="06:00", end="07:00"), [("SLAC", "America/Los_Angeles")])
        self.assertIn("(SLAC, Mon)", late)

    def test_extract(self):
        self.assertIsNone(extract_session_data("just a comment"))
        self.assertIsNone(extract_session_data('<!-- sprintweek:cancelled {"date": "2026-10-27"} -->'))
        with self.assertRaises(SessionError):
            extract_session_data("<!-- sprintweek:session {not json} -->")
        self.assertIsNone(extract_session_data("<!-- sprintweek:session [1, 2] -->"))

    def test_encoding_is_stable(self):
        line = encode_session_data({**BASE, "location": "A"})
        self.assertTrue(line.startswith('<!-- sprintweek:session {"v":1,'))
        self.assertEqual(extract_session_data(line)["location"], "A")


if __name__ == "__main__":
    unittest.main()
