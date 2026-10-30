import tempfile
import textwrap
import unittest
from pathlib import Path

from sprintweek.build import build_data
from sprintweek.config import ConfigError, load_config
from sprintweek.rooms import RESOLVED_MARKER, notice_key, plan_notices, room_problem
from sprintweek.sessions import encode_session_data

CONFIG = """
event:
  start_date: 2026-10-26   # a Monday
  end_date: 2026-10-30
github:
  repo: example/sprints
scheduler:
  url: https://bot.example
sites:
  - name: SLAC
    timezone: America/Los_Angeles
    rooms:
{rooms}
  - name: Paris
    timezone: Europe/Paris
"""

ROOMS = """
      - Redwood C-D
      - { name: Redwood B, available: [{ days: [Tue] }] }
      - name: Redwood A
        available:
          - days: [Mon, 2026-10-28]
          - days: [Tue]
            start: 13:00
            end: 17:00
"""


def load(rooms=ROOMS):
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(textwrap.dedent(CONFIG.format(rooms=rooms)))
    try:
        return load_config(f.name)
    finally:
        Path(f.name).unlink()


def session(**kw):
    return {"site": "SLAC", "location": "Redwood A", "date": "2026-10-27", "start": "13:00", "end": "17:00", **kw}


class TestRoomConfig(unittest.TestCase):
    def test_plain_flow_and_block_styles(self):
        rooms = {r.name: r.public() for r in load().sites[0].rooms}
        self.assertIsNone(rooms["Redwood C-D"]["available"])
        self.assertEqual(rooms["Redwood B"]["available"], [{"date": "2026-10-27", "start": "", "end": ""}])
        self.assertEqual(
            rooms["Redwood A"]["available"],
            [
                {"date": "2026-10-26", "start": "", "end": ""},
                {"date": "2026-10-27", "start": "13:00", "end": "17:00"},
                {"date": "2026-10-28", "start": "", "end": ""},
            ],
        )
        self.assertEqual(rooms["Redwood A"]["summary"], "Mon 26, Wed 28; Tue 27 13:00–17:00")

    def test_all_days_with_hours_and_full_weekday_names(self):
        rooms = load("      - { name: Kavli, available: [{ days: all, start: 9:00, end: 12:00 }, { days: [Friday] }] }")
        windows = rooms.sites[0].rooms[0].available
        self.assertEqual(len(windows), 6)
        self.assertEqual(windows[0], {"date": "2026-10-26", "start": "09:00", "end": "12:00"})

    def test_open_ended_windows(self):
        rooms = load("      - { name: A, available: [{ days: [Fri], end: 13:00 }, { days: [Mon], start: 14:00 }] }")
        room = rooms.sites[0].rooms[0]
        self.assertEqual(
            room.available,
            [
                {"date": "2026-10-26", "start": "14:00", "end": "24:00"},
                {"date": "2026-10-30", "start": "00:00", "end": "13:00"},
            ],
        )
        self.assertEqual(room.summary, "Fri 30 until 13:00; Mon 26 from 14:00")
        by_site = rooms.rooms_by_site
        friday = session(location="A", date="2026-10-30")
        self.assertEqual(room_problem({**friday, "start": "08:00", "end": "12:30"}, by_site), "")
        self.assertIn("until 13:00", room_problem({**friday, "start": "12:00", "end": "14:00"}, by_site))
        self.assertEqual(room_problem({**friday, "date": "2026-10-26", "start": "15:00", "end": "23:59"}, by_site), "")

    def test_errors_name_the_room(self):
        cases = {
            "      - { name: A, capacity: 20 }": "unknown",
            "      - { name: A, available: [{ start: 9:00, end: 10:00 }] }": "days",
            "      - { name: A, available: [{ days: [Mon], start: 10:00, end: 9:00 }] }": "after start",
            "      - { name: A, available: [{ days: [Sat] }] }": "no Sat",
            "      - { name: A, available: [{ days: [Mon], start: 1pm, end: 3pm }] }": "24-hour",
            "      - A\n      - a": "twice",
            "      - { name: A, available: [] }": "available",
        }
        for rooms, expected in cases.items():
            with self.subTest(rooms=rooms), self.assertRaises(ConfigError) as ctx:
                load(rooms)
            self.assertIn(expected, str(ctx.exception))

    def test_program_accepts_weekday_names(self):
        text = CONFIG.format(rooms="      []").replace(
            "    timezone: America/Los_Angeles\n",
            "    timezone: America/Los_Angeles\n    program:\n"
            "      - { title: X, kind: plenary, days: [Tue, Thu], start: 9:00, end: 10:00 }\n",
        )
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
            f.write(textwrap.dedent(text))
        try:
            c = load_config(f.name)
        finally:
            Path(f.name).unlink()
        self.assertEqual([p["date"] for p in c.program], ["2026-10-27", "2026-10-29"])


class TestRoomProblem(unittest.TestCase):
    def setUp(self):
        self.rooms = load().rooms_by_site

    def test_windows(self):
        self.assertEqual(room_problem(session(), self.rooms), "")
        self.assertIn("not available on Tue Oct 27 at 12:30–17:00", room_problem(session(start="12:30"), self.rooms))
        self.assertTrue(room_problem(session(end="17:30"), self.rooms))
        self.assertEqual(room_problem(session(date="2026-10-26", start="07:00", end="21:00"), self.rooms), "")
        self.assertTrue(room_problem(session(date="2026-10-29"), self.rooms))

    def test_names_and_sites(self):
        self.assertEqual(room_problem(session(location="  redwood   a "), self.rooms), "")
        self.assertTrue(room_problem(session(location="REDWOOD A", date="2026-10-29"), self.rooms))
        self.assertEqual(room_problem(session(location="Redwood C-D", date="2026-10-29"), self.rooms), "")
        self.assertEqual(room_problem(session(location="Alice's office", date="2026-10-29"), self.rooms), "")
        self.assertEqual(room_problem(session(site="Paris", date="2026-10-29"), self.rooms), "")
        self.assertEqual(room_problem(session(location="", date="2026-10-29"), self.rooms), "")


def snapshot(session_data, extra_comments=()):
    issue = {
        "number": 4, "title": "Sprint", "body": "### Short pitch\n\nHi",
        "html_url": "https://github.com/example/sprints/issues/4",
        "state": "open", "state_reason": None, "user": "author", "assignees": [], "labels": [],
        "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z", "is_pull_request": False,
    }  # fmt: skip
    comment = {
        "id": 99, "issue": 4, "user": "jf", "author_association": "OWNER", "body": encode_session_data(session_data),
        "html_url": "https://github.com/example/sprints/issues/4#issuecomment-99",
        "created_at": "2026-10-02T00:00:00Z", "updated_at": "2026-10-02T00:00:00Z",
    }  # fmt: skip
    return {"issues": [issue], "comments": [comment, *extra_comments]}


def bot_comment(body, cid=500):
    return {"id": cid, "issue": 4, "user": "github-actions[bot]", "author_association": "NONE", "body": body,
            "html_url": "x", "created_at": "2026-10-03T00:00:00Z", "updated_at": "2026-10-03T00:00:00Z"}  # fmt: skip


class TestNotices(unittest.TestCase):
    def setUp(self):
        self.config = load()
        self.bad = {
            "date": "2026-10-27",
            "start": "10:00",
            "end": "12:00",
            "tz": "America/Los_Angeles",
            "site": "SLAC",
            "location": "Redwood A",
        }

    def test_build_flags_conflicts(self):
        data = build_data(snapshot(self.bad), self.config)
        s = data["sprints"][0]["sessions"][0]
        self.assertIn("Redwood A is not available", s["room_issue"])
        self.assertTrue(any("Redwood A" in w for w in data["warnings"]))
        self.assertEqual(data["sprints"][0]["warnings"], [], "room conflicts are not 'unreadable session' warnings")

    def test_post_once_then_resolve(self):
        snap = snapshot(self.bad)
        data = build_data(snap, self.config)
        to_post, to_resolve = plan_notices(data, snap["comments"], self.config.scheduler_url)
        self.assertEqual(len(to_post), 1)
        self.assertEqual(to_resolve, [])
        number, body = to_post[0]
        self.assertEqual(number, 4)
        self.assertIn("https://bot.example/session/99", body)
        self.assertNotIn("@", body.split("-->", 1)[1])

        # Already posted: nothing to do.
        snap = snapshot(self.bad, [bot_comment(body)])
        url = self.config.scheduler_url
        self.assertEqual(plan_notices(build_data(snap, self.config), snap["comments"], url), ([], []))

        # Same conflict, but the room's availability (and so the text) changed: refresh in place.
        stale = bot_comment(body.replace("Tue 27 13:00–17:00", "Tue 27 14:00–17:00"))
        snap = snapshot(self.bad, [stale])
        self.assertEqual(plan_notices(build_data(snap, self.config), snap["comments"], url), ([], [(500, body)]))

        # Session moved to an open time: the notice is resolved.
        moved = {**self.bad, "start": "13:00", "end": "15:00"}
        snap = snapshot(moved, [bot_comment(body)])
        to_post, to_resolve = plan_notices(build_data(snap, self.config), snap["comments"], "")
        self.assertEqual(to_post, [])
        self.assertEqual(to_resolve[0][0], 500)
        self.assertTrue(to_resolve[0][1].startswith(f"<!-- {RESOLVED_MARKER} "))
        self.assertIn("Resolved", to_resolve[0][1])

        # A resolved notice is left alone.
        snap = snapshot(moved, [bot_comment(to_resolve[0][1])])
        self.assertEqual(plan_notices(build_data(snap, self.config), snap["comments"], ""), ([], []))

    def test_moving_to_another_bad_time_posts_a_new_notice(self):
        snap = snapshot(self.bad)
        data = build_data(snap, self.config)
        body = plan_notices(data, snap["comments"], "")[0][0][1]
        other = {**self.bad, "date": "2026-10-29"}
        snap = snapshot(other, [bot_comment(body)])
        to_post, to_resolve = plan_notices(build_data(snap, self.config), snap["comments"], "")
        self.assertEqual((len(to_post), len(to_resolve)), (1, 1))

    def test_only_bot_notices_count(self):
        snap = snapshot(self.bad)
        data = build_data(snap, self.config)
        key = notice_key(data["sprints"][0], data["sprints"][0]["sessions"][0])
        fake = {**bot_comment(f"<!-- sprintweek:room-notice {key} -->"), "user": "someone"}
        to_post, _ = plan_notices(data, [*snap["comments"], fake], "")
        self.assertEqual(len(to_post), 1)


if __name__ == "__main__":
    unittest.main()
