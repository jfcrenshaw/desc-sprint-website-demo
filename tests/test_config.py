import tempfile
import textwrap
import unittest
from pathlib import Path

from sprintweek.build import calendar_events
from sprintweek.config import ConfigError, load_config

ROOT = Path(__file__).resolve().parent.parent

BASE = """
event:
  title: Test Week
  start_date: 2026-10-26
  end_date: 2026-10-28
github:
  repo: example/sprints
sites:
  - name: SLAC
    timezone: America/Los_Angeles
    rooms: [Redwood A]
    program:
{program}
types:
  General Sprint: "#2f6fdf"
"""


def load(program="      []", extra="", **replace):
    text = BASE.format(program=program) + extra
    for old, new in replace.items():
        text = text.replace(old, new)
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(textwrap.dedent(text))
    try:
        return load_config(f.name)
    finally:
        Path(f.name).unlink()


class TestRepositoryConfig(unittest.TestCase):
    def test_shipped_config_loads(self):
        config = load_config(ROOT / "sprintweek.yaml")
        self.assertEqual([s.name for s in config.sites], ["SLAC", "Paris"])
        self.assertTrue(config.program)
        self.assertEqual(config.bot_login, "desc-sprint-week-demo-bot[bot]")


class TestProgram(unittest.TestCase):
    def test_unquoted_times_and_all_days(self):
        # Plain YAML would read 10:30 as the number 630; the loader keeps it as text.
        c = load("      - { title: Coffee, kind: break, days: all, start: 10:30, end: 11:00 }")
        self.assertEqual([p["date"] for p in c.program], ["2026-10-26", "2026-10-27", "2026-10-28"])
        self.assertEqual({(p["start"], p["end"]) for p in c.program}, {("10:30", "11:00")})
        self.assertEqual(c.program[0]["start_utc"], "2026-10-26T17:30:00Z")
        self.assertEqual(c.program[0]["site"], "SLAC")

    def test_listed_days_block_style_and_sorting(self):
        c = load(
            """
      - title: Reception
        kind: social
        days: [2026-10-27]
        start: 17:00
        end: 19:00
        location: Lobby
        online: https://zoom.us/j/1
      - { title: Pitches, kind: plenary, days: [2026-10-26, 2026-10-27], start: 08:30, end: 09:00 }"""
        )
        self.assertEqual(
            [(p["title"], p["date"]) for p in c.program],
            [("Pitches", "2026-10-26"), ("Pitches", "2026-10-27"), ("Reception", "2026-10-27")],
        )
        self.assertEqual(c.program[-1]["location"], "Lobby")
        self.assertEqual(c.public()["program"], c.program)

    def test_feed_gets_plenaries_and_socials_only(self):
        c = load(
            """
      - { title: Coffee, kind: break, days: all, start: 10:30, end: 11:00 }
      - { title: Lunch, kind: meal, days: all, start: 12:00, end: 13:00 }
      - { title: Pitches, kind: plenary, days: [2026-10-26], start: 08:30, end: 09:00 }
      - { title: Party, kind: social, days: [2026-10-28], start: 18:00, end: 20:00 }"""
        )
        self.assertEqual([e["summary"] for e in calendar_events([], c)], ["Pitches", "Party"])

    def test_errors_name_the_setting(self):
        cases = {
            "      - { title: Coffee, kind: snack, days: all, start: 10:30, end: 11:00 }": "kind",
            "      - { title: Coffee, kind: break, days: all, start: 11:00, end: 10:30 }": "ends",
            "      - { title: Coffee, kind: break, days: all, start: 10am, end: 11:00 }": "HH:MM",
            "      - { title: Coffee, kind: break, days: [2026-13-01], start: 10:30, end: 11:00 }": "days",
            "      - { title: Coffee, kind: break, start: 10:30, end: 11:00 }": "days",
            "      - { title: Coffee, kind: break, days: all, start: 10:30, end: 11:00, room: A }": "unknown",
            "      - { title: Coffee, kind: break, days: all, start: 10:30, end: 11:00, online: http://x }": "https",
            "      - { kind: break, days: all, start: 10:30, end: 11:00 }": "title",
        }
        for program, expected in cases.items():
            with self.subTest(program=program), self.assertRaises(ConfigError) as ctx:
                load(program)
            self.assertIn(expected, str(ctx.exception))
            self.assertIn("SLAC", str(ctx.exception))


class TestValues(unittest.TestCase):
    def test_unquoted_color_is_reported(self):
        with self.assertRaises(ConfigError) as ctx:
            load(**{'General Sprint: "#2f6fdf"': "General Sprint: #2f6fdf"})
        self.assertIn("quoted color", str(ctx.exception))

    def test_booleans(self):
        self.assertFalse(
            load(**{"  repo: example/sprints": "  repo: example/sprints\n  greet_new_issues: no"}).greet_new_issues
        )
        with self.assertRaises(ConfigError):
            load(**{"  repo: example/sprints": "  repo: example/sprints\n  auto_label: maybe"})

    def test_bad_dates_zones_and_yaml(self):
        for old, new, expected in [
            ("end_date: 2026-10-28", "end_date: 2026-10-20", "before"),
            ("start_date: 2026-10-26", "start_date: 26/10/2026", "YYYY-MM-DD"),
            ("timezone: America/Los_Angeles", "timezone: PST", "unknown time zone"),
            ("  repo: example/sprints", "  repo: not a repo", "owner/name"),
            ("event:", "event: [", "not valid YAML"),
        ]:
            with self.subTest(new=new), self.assertRaises(ConfigError) as ctx:
                load(**{old: new})
            self.assertIn(expected, str(ctx.exception))

    def test_defaults(self):
        c = load()
        self.assertEqual(c.site_url, "https://example.github.io/sprints/")
        self.assertEqual(c.default_timezone, "local")
        self.assertTrue(c.greet_new_issues)
        self.assertEqual(c.program, [])


if __name__ == "__main__":
    unittest.main()
