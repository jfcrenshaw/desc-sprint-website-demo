import json
import tempfile
import unittest
from pathlib import Path

from sprintweek import ics
from sprintweek.build import build_data, build_sprint, write_site
from sprintweek.config import load_config
from sprintweek.sessions import encode_session_data

ROOT = Path(__file__).resolve().parent.parent
CONFIG = load_config(ROOT / "sprintweek.yaml", repo="example/sprints")
SESSION = {"date": "2026-10-27", "start": "09:00", "end": "10:00", "tz": "America/Los_Angeles", "location": "Redwood A"}


def issue(**kw):
    base = {
        "number": 7,
        "title": "A sprint",
        "body": "### Short pitch\n\nHello",
        "html_url": "https://github.com/example/sprints/issues/7",
        "state": "open",
        "state_reason": None,
        "user": "author",
        "assignees": ["helper"],
        "labels": [],
        "created_at": "2026-10-01T00:00:00Z",
        "updated_at": "2026-10-01T00:00:00Z",
        "is_pull_request": False,
    }
    return {**base, **kw}


def comment(body, user="someone", assoc="NONE", cid=1, created="2026-10-02T00:00:00Z"):
    return {
        "id": cid,
        "issue": 7,
        "user": user,
        "author_association": assoc,
        "body": body,
        "html_url": f"https://github.com/example/sprints/issues/7#issuecomment-{cid}",
        "created_at": created,
        "updated_at": created,
    }


class TestBuildSprint(unittest.TestCase):
    def test_unscheduled_sprint_defaults_to_author_as_contact(self):
        sp, warnings = build_sprint(issue(), [], CONFIG)
        self.assertEqual(sp["sessions"], [])
        self.assertEqual(sp["contacts"], [{"login": "author", "name": None}])
        self.assertEqual(warnings, [])

    def test_multiple_sessions_are_sorted(self):
        later = encode_session_data({**SESSION, "date": "2026-10-29"})
        earlier = encode_session_data(SESSION)
        sp, _ = build_sprint(issue(), [comment(later, "jf", "OWNER", 1), comment(earlier, "jf", "OWNER", 2)], CONFIG)
        self.assertEqual([s["date"] for s in sp["sessions"]], ["2026-10-27", "2026-10-29"])
        self.assertEqual([s["id"] for s in sp["sessions"]], ["2", "1"])
        self.assertEqual(sp["sessions"][0]["site"], "SLAC")  # inferred from the time zone

    def test_only_trusted_authors_can_post_sessions(self):
        data = encode_session_data(SESSION)
        sp, warnings = build_sprint(issue(), [comment(data, "random", "NONE")], CONFIG)
        self.assertEqual(sp["sessions"], [])
        self.assertIn("ignored", warnings[0])
        for user, assoc in (("x", "MEMBER"), ("x", "COLLABORATOR"), ("x", "OWNER")):
            sp, _ = build_sprint(issue(), [comment(data, user, assoc)], CONFIG)
            self.assertEqual(len(sp["sessions"]), 1, assoc)

    def test_bot_is_trusted(self):
        config = load_config(ROOT / "sprintweek.yaml", repo="example/sprints")
        config.bot_login = "sprint-bot[bot]"
        sp, _ = build_sprint(issue(), [comment(encode_session_data(SESSION), "sprint-bot[bot]", "NONE")], config)
        self.assertEqual(len(sp["sessions"]), 1)

    def test_malformed_sessions_become_warnings(self):
        bad = [
            comment("<!-- sprintweek:session {oops} -->", "jf", "OWNER", 1),
            comment(encode_session_data({**SESSION, "end": "08:00"}), "jf", "OWNER", 2),
            comment(encode_session_data(SESSION), "jf", "OWNER", 3),
        ]
        sp, warnings = build_sprint(issue(), bad, CONFIG)
        self.assertEqual(len(sp["sessions"]), 1)
        self.assertEqual(len(warnings), 2)

    def test_cancelled_sessions_are_ignored(self):
        body = encode_session_data(SESSION).replace("sprintweek:session", "sprintweek:cancelled")
        sp, warnings = build_sprint(issue(), [comment(body, "jf", "OWNER")], CONFIG)
        self.assertEqual((sp["sessions"], warnings), ([], []))

    def test_each_wrapup_comment_is_separate_and_ordered(self):
        comments = [
            comment(
                "## Wrap-up\n2026-10-29\n\nSecond, written for Thursday",
                "helper",
                cid=3,
                created="2026-10-30T02:00:00Z",
            ),
            comment("## Wrap-up\n2026-10-29\n\nFirst", "author", cid=1, created="2026-10-29T20:00:00Z"),
            comment("## Wrap-up\n\nFrom a stranger", "stranger", cid=2),
            comment("## Wrap-up\n2026-10-30\n", "author", cid=4),  # template pasted, nothing written yet
        ]
        sp, warnings = build_sprint(issue(), sorted(comments, key=lambda c: c["created_at"]), CONFIG)
        self.assertEqual([w["text"] for w in sp["wrapups"]], ["First", "Second, written for Thursday"])
        self.assertEqual([w["date"] for w in sp["wrapups"]], ["2026-10-29", "2026-10-29"])
        self.assertEqual(
            [(w["author"], w["id"], w["source"]) for w in sp["wrapups"]],
            [("author", "1", "comment"), ("helper", "3", "comment")],
        )
        self.assertEqual(warnings, [])

    def test_undated_wrapups_use_the_posting_day_in_the_sprint_time_zone(self):
        paris = encode_session_data({**SESSION, "tz": "Europe/Paris", "location": ""})
        late = comment("## Wrap-up\n\nPosted at 23:30 UTC", "author", cid=2, created="2026-10-28T23:30:00Z")
        sp, _ = build_sprint(issue(), [comment(paris, "jf", "OWNER", 1), late], CONFIG)
        self.assertEqual(sp["wrapups"][0]["date"], "2026-10-29")  # already Thursday in Paris
        sp, _ = build_sprint(issue(), [late], CONFIG)
        self.assertEqual(sp["wrapups"][0]["date"], "2026-10-28")  # no sessions: first site (SLAC)

    def test_hostile_wrapup_comment_from_anyone(self):
        body = "## Wrap-up\n" + "mon " * 3000 + "\n\nDone"
        sp, warnings = build_sprint(issue(), [comment(body, "author", created="2026-10-28T18:00:00Z")], CONFIG)
        self.assertEqual(sp["wrapups"][0]["date"], "2026-10-28")

    def test_forgiving_wrapup_dates(self):
        for line in (
            "date: Thursday",
            "Date - Oct 29",
            "date: 29/10",
            "date: 10/29/2026",
            "Thu Oct 29",
            "date:2026-10-29",
        ):
            with self.subTest(line=line):
                sp, warnings = build_sprint(issue(), [comment(f"### Wrap up\n{line}\n\nDone", "author")], CONFIG)
                self.assertEqual(
                    (sp["wrapups"][0]["date"], sp["wrapups"][0]["date_note"], warnings), ("2026-10-29", "", [])
                )
        sp, _ = build_sprint(issue(), [comment("## Wrap-up: Thursday\n\nDone", "author")], CONFIG)
        self.assertEqual(sp["wrapups"][0]["date"], "2026-10-29")

    def test_template_placeholder_means_today_without_a_warning(self):
        c = comment("## Wrap-up\ndate: YYYY-MM-DD\n\nDone", "author", created="2026-10-28T18:00:00Z")
        sp, warnings = build_sprint(issue(), [c], CONFIG)
        self.assertEqual((sp["wrapups"][0]["date"], warnings), ("2026-10-28", []))

    def test_unreadable_wrapup_dates_fall_back_with_a_warning(self):
        for line, expected in (
            ("date: 2026-10-32", "is not a date"),
            ("date: Saturday", "no Saturday"),
            ("date: 2026-11-30", "not during the Sprint Week"),
            ("date: 10/11", "could be read as Oct 11 or Nov 10"),
        ):
            c = comment(f"## Wrap-up\n{line}\n\nDone", "author", created="2026-10-27T18:00:00Z")
            sp, warnings = build_sprint(issue(), [c], CONFIG)
            self.assertEqual(sp["wrapups"][0]["date"], "2026-10-27")
            self.assertIn(expected, warnings[0])
            self.assertIn("shown on the day it was posted (Tue Oct 27)", sp["wrapups"][0]["date_note"])
            self.assertEqual(sp["warnings"], [], "only session problems count as unreadable sessions")

    def test_wrapup_in_the_issue_body_is_dated_to_the_last_session(self):
        body = "### Short pitch\n\nHi\n\n### Wrap-up\n\nDone in the body."
        later = encode_session_data({**SESSION, "date": "2026-10-29"})
        sp, _ = build_sprint(
            issue(body=body),
            [comment(later, "jf", "OWNER"), comment("## Wrap-up\n\nAnd a comment", "author", cid=2)],
            CONFIG,
        )
        by_source = {w["source"]: w for w in sp["wrapups"]}
        self.assertEqual(by_source["issue"]["text"], "Done in the body.")
        self.assertEqual(by_source["issue"]["date"], "2026-10-29")
        self.assertEqual(by_source["comment"]["text"], "And a comment")

    def test_type_groups_and_flag_from_labels(self):
        names = ("Paper Sprint", "PZ", "WLSS", "New Contributor Friendly", "Paris")
        sp, _ = build_sprint(issue(labels=[{"name": n, "color": "ededed"} for n in names]), [], CONFIG)
        self.assertEqual(
            (sp["type"], sp["working_groups"], sp["new_contributor_friendly"]), ("Paper Sprint", ["PZ", "WLSS"], True)
        )
        kinds = {t["name"]: t["kind"] for t in sp["tags"]}
        self.assertEqual((kinds["Paper Sprint"], kinds["PZ"], kinds["Paris"]), ("type", "group", "label"))

    def test_working_groups_come_from_the_issue_form(self):
        self.assertIn("PZ", CONFIG.working_groups)
        self.assertIn("WLSS", CONFIG.working_groups)

    def test_tags_merge_form_and_labels(self):
        body = "### Sprint type\n\nPaper Sprint\n\n### Working groups\n\nPZ (Photometric Redshifts)"
        labels = [{"name": "pz", "color": "2b9628"}, {"name": "Paris", "color": "c293b5"}]
        sp, _ = build_sprint(issue(body=body, labels=labels), [], CONFIG)
        self.assertEqual(
            [(t["name"], t["kind"]) for t in sp["tags"]],
            [("Paper Sprint", "type"), ("PZ", "group"), ("Paris", "label")],
        )
        self.assertEqual(sp["tags"][1]["color"], "#2b9628")


class TestBuildData(unittest.TestCase):
    def test_excluded_issues(self):
        snapshot = {
            "issues": [
                issue(number=1),
                issue(number=2, labels=[{"name": "Duplicate", "color": ""}]),
                issue(number=3, state="closed", state_reason="not_planned"),
                issue(number=4, is_pull_request=True),
                issue(number=5, state="closed", state_reason="completed"),
            ],
            "comments": [],
        }
        data = build_data(snapshot, CONFIG)
        self.assertEqual([s["number"] for s in data["sprints"]], [1, 5])

    def test_one_unreadable_issue_does_not_stop_the_build(self):
        from unittest import mock

        import sprintweek.build as build

        real = build.build_sprint

        def flaky(issue, comments, config):
            if issue["number"] == 2:
                raise ValueError("boom")
            return real(issue, comments, config)

        with mock.patch.object(build, "build_sprint", flaky):
            data = build.build_data(
                {"issues": [issue(number=1), issue(number=2), issue(number=3)], "comments": []}, CONFIG
            )
        self.assertEqual([s["number"] for s in data["sprints"]], [1, 3])
        self.assertIn("#2: could not be read (ValueError: boom)", data["warnings"][0])

    def test_demo_snapshot_builds_cleanly(self):
        snapshot = json.loads((ROOT / "demo" / "snapshot.json").read_text())
        data = build_data(snapshot, CONFIG)
        # One demo session (#4, Tuesday) is deliberately in a room open only Wed-Fri, to show the notices.
        self.assertEqual(len(data["warnings"]), 1)
        self.assertIn("#4: Redwoods A-B is not available on Tue Oct 27", data["warnings"][0])
        counts = [len(s["sessions"]) for s in data["sprints"]]
        self.assertIn(0, counts)
        self.assertIn(1, counts)
        self.assertGreater(max(counts), 1)
        modes = {x["mode"] for s in data["sprints"] for x in s["sessions"]}
        self.assertTrue({"online", "hybrid", "in person"} <= modes)
        self.assertTrue(any(s["wrapups"] for s in data["sprints"]))

    def test_write_site(self):
        snapshot = json.loads((ROOT / "demo" / "snapshot.json").read_text())
        data = build_data(snapshot, CONFIG)
        with tempfile.TemporaryDirectory() as tmp:
            write_site(data, CONFIG, tmp)
            out = Path(tmp)
            self.assertTrue((out / "index.html").exists())
            published = json.loads((out / "data" / "config.json").read_text())
            self.assertNotIn("token", json.dumps(published).lower())
            cal = (out / "calendar.ics").read_bytes()
            n = sum(len(s["sessions"]) for s in data["sprints"])
            n += sum(1 for p in CONFIG.program if p["kind"] in ("plenary", "social"))
            self.assertEqual(cal.count(b"BEGIN:VEVENT"), n)
            self.assertTrue(all(len(line) <= 75 for line in cal.split(b"\r\n")))
            self.assertEqual(
                len(list((out / "ics").glob("sprint-*.ics"))), sum(1 for s in data["sprints"] if s["sessions"])
            )
            for sp in data["sprints"]:
                for s in sp["sessions"]:
                    single = (out / "ics" / f"session-{s['id']}.ics").read_bytes()
                    self.assertEqual(single.count(b"BEGIN:VEVENT"), 1)
            self.assertEqual(len(list((out / "ics").glob("program-*.ics"))), len(CONFIG.program))


class TestIcs(unittest.TestCase):
    def test_escape(self):
        self.assertEqual(ics.escape("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne")

    def test_fold_respects_utf8(self):
        line = "SUMMARY:" + "é" * 100
        folded = ics.fold(line)
        parts = folded.split("\r\n ")
        self.assertTrue(all(len(p.encode()) <= 75 for p in parts))
        self.assertEqual("".join(parts), line)

    def test_stamp(self):
        self.assertEqual(ics.stamp("2026-10-27T13:00:00Z"), "20261027T130000Z")


class TestConfig(unittest.TestCase):
    def test_public_config(self):
        pub = CONFIG.public()
        self.assertEqual(pub["days"][0], "2026-10-26")
        self.assertEqual(len(pub["days"]), 5)
        self.assertEqual({s["name"]: s["abbr"] for s in pub["sites"]}, {"SLAC": "PDT", "Paris": "CET"})
        self.assertEqual(pub["site_url"], "https://example.github.io/sprints/")


if __name__ == "__main__":
    unittest.main()
