import importlib.util
import unittest
from pathlib import Path

from sprintweek.parse import (
    parse_contacts,
    parse_issue_body,
    parse_wrapup_comment,
    plain_text,
    split_sections,
    tidy_body,
    wrapup_from_comment,
)

FORM_BODY = """### Short pitch

Build a **pipeline** for LBGs.

### Contact person(s)

@alice, Bob Smith (@bsmith)

### Sprint type

Paper Sprint

### Working groups

PZ (Photometric Redshifts), WLSS (Weak Lensing & Large-Scale Structure)

### Goals and deliverables

1. A pipeline
2. A paper draft

#### A sub-heading the author added

still part of the goals

### Prerequisites

_No response_

### Communication channel and links

Slack: #desc-lbg

### Detailed description

```python
# not a heading
### Wrap-up
```

### Options

- [X] New contributor friendly

### Wrap-up

_No response_
"""

LEGACY_BODY = """# [PZ Innovation Brainstorm]

Much of our WG activity is centered on implementing existing methods.

Contacts: @jfcrenshaw @jtmyles
Day/Time: Thursday 10a Pacific at SLAC and zoom
Main communication channel: #desc-pz
GitHub repo:

## Goals and deliverable

A list of project ideas.

## Resources and skills needed

[describe the resources (software, skills, data, or just enthusiasm) needed for this project]
"""


class TestIssueForm(unittest.TestCase):
    def setUp(self):
        self.f = parse_issue_body(FORM_BODY, "LBG sprint")

    def test_simple_fields(self):
        self.assertEqual(self.f["pitch"], "Build a **pipeline** for LBGs.")
        self.assertEqual(self.f["type"], "Paper Sprint")
        self.assertEqual(self.f["links"], "Slack: #desc-lbg")

    def test_dropdown_values_lose_their_explanations(self):
        self.assertEqual(self.f["working_groups"], ["PZ", "WLSS"])

    def test_no_response_is_empty(self):
        self.assertEqual(self.f["prerequisites"], "")
        self.assertEqual(self.f["wrapup"], "")

    def test_unknown_headings_stay_in_their_section(self):
        self.assertIn("A sub-heading the author added", self.f["goals"])
        self.assertIn("still part of the goals", self.f["goals"])

    def test_headings_inside_code_blocks_are_ignored(self):
        self.assertIn("### Wrap-up", self.f["details"])
        self.assertEqual(self.f["wrapup"], "")

    def test_checkboxes(self):
        self.assertEqual(self.f["options"], ["New contributor friendly"])

    def test_filled_in_wrapup(self):
        body = FORM_BODY.replace("### Wrap-up\n\n_No response_", "### Wrap-up\n\nWe wrote the paper! 🎉")
        self.assertEqual(parse_issue_body(body)["wrapup"], "We wrote the paper! 🎉")

    def test_empty_and_missing_bodies(self):
        for body in ("", None, "just some text"):
            f = parse_issue_body(body)
            self.assertEqual(f["goals"], "")
            self.assertEqual(f["working_groups"], [])
        self.assertEqual(parse_issue_body("just some text")["pitch"], "just some text")

    def test_html_comments_are_dropped(self):
        f = parse_issue_body("### Short pitch\n\n<!-- instructions -->\nHello")
        self.assertEqual(f["pitch"], "Hello")


class TestLegacyTemplate(unittest.TestCase):
    def setUp(self):
        self.f = parse_issue_body(LEGACY_BODY, "PZ Innovation Brainstorm")

    def test_pitch_is_first_paragraph(self):
        self.assertEqual(self.f["pitch"], "Much of our WG activity is centered on implementing existing methods.")

    def test_key_value_lines(self):
        self.assertEqual(self.f["contacts"], "@jfcrenshaw @jtmyles")
        self.assertIn("#desc-pz", self.f["links"])
        self.assertIn("Thursday 10a Pacific", self.f["schedule_note"])

    def test_old_headings_and_placeholders(self):
        self.assertEqual(self.f["goals"], "A list of project ideas.")
        self.assertEqual(self.f["prerequisites"], "")

    def test_bulleted_day_time(self):
        body = "Day/Time:\n- Wednesday, 8AM PDT, ZOOM ONLY\n- Wednesday 10AM, SLAC\n\nOther text"
        note = parse_issue_body(body)["schedule_note"]
        self.assertIn("ZOOM ONLY", note)
        self.assertIn("10AM, SLAC", note)


class TestSplitSections(unittest.TestCase):
    def test_first_heading_wins(self):
        s = split_sections("### Short pitch\n\nA\n\n### Short pitch\n\nB")
        self.assertIn("B", s["pitch"])  # the repeated heading is kept as content


class TestContacts(unittest.TestCase):
    def test_handles_and_names(self):
        self.assertEqual(
            parse_contacts("@alice, Bob Smith (@bsmith); Carol Jones"),
            [
                {"login": "alice", "name": None},
                {"login": "bsmith", "name": "Bob Smith"},
                {"login": None, "name": "Carol Jones"},
            ],
        )

    def test_space_separated_handles(self):
        self.assertEqual([c["login"] for c in parse_contacts("@a @b-c @d")], ["a", "b-c", "d"])

    def test_and_separator_and_backticks(self):
        self.assertEqual(
            parse_contacts("John Franklin Crenshaw and `@ztq1996`"),
            [{"login": None, "name": "John Franklin Crenshaw"}, {"login": "ztq1996", "name": None}],
        )

    def test_emails_and_remarks_are_not_handles(self):
        self.assertEqual(
            parse_contacts("Leo Sajkov (find on Slack or at leo@example.org)"),
            [{"login": None, "name": "Leo Sajkov"}],
        )

    def test_bold_markup(self):
        self.assertEqual(
            parse_contacts("**François Lanusse** (@EiffL)"), [{"login": "EiffL", "name": "François Lanusse"}]
        )

    def test_empty(self):
        self.assertEqual(parse_contacts(""), [])


class TestWrapupComments(unittest.TestCase):
    def test_variants(self):
        for opening in ("## Wrap-up", "# Wrap up", "### 📝 Wrapup", "**Wrap-up**", "## Wrap-up: day 5"):
            self.assertEqual(wrapup_from_comment(f"{opening}\n\nWe did it."), "We did it.", opening)

    def test_not_a_wrapup(self):
        self.assertIsNone(wrapup_from_comment("Great sprint! Here is my wrap-up: ..."))
        self.assertIsNone(wrapup_from_comment("## Day 1 notes\n\nwrap-up tomorrow"))
        self.assertIsNone(wrapup_from_comment("## Wrap-up\n\n"))

    def test_dates(self):
        cases = {
            "## Wrap-up\ndate: 2026-10-30\n\nWe did it.": ("2026-10-30", "We did it."),
            "# Wrap-up\nDate - Thursday\nDone": ("Thursday", "Done"),
            "### wrap up\n**Date:** Oct 29\nDone": ("Oct 29", "Done"),
            "**Wrap-up**\n\n2026-10-29\nx": ("2026-10-29", "x"),
            "## Wrap-up\n**2026-10-29**\nx": ("2026-10-29", "x"),
            "Wrap-up:\ndate: YYYY-MM-DD\nok": ("YYYY-MM-DD", "ok"),
            "##Wrapup\ndate: 10/29\nok": ("10/29", "ok"),
            "## Wrap-ups for Thursday\nok": ("Thursday", "ok"),
            "## Wrap-up: Thursday\nDone.": ("Thursday", "Done."),
            "**Wrap-up** (Fri)\nDone": ("Fri", "Done"),
            "## Wrap-up\ndate: nonsense\nok": ("nonsense", "ok"),
            "## Wrap-up of the Monster sprint\nok": (None, "ok"),
            "## Wrap-up\nWednesday was fun\nok": (None, "Wednesday was fun\nok"),
            "## Wrap-up\nDated results: none\nok": (None, "Dated results: none\nok"),
            "## Wrap-up: day 5\nok": (None, "ok"),
        }
        for body, (hint, text) in cases.items():
            with self.subTest(body=body):
                self.assertEqual(parse_wrapup_comment(body), {"date_hint": hint, "text": text})

    def test_plain_wrapup_line_without_hash(self):
        self.assertEqual(parse_wrapup_comment("Wrap-up\ndate: Fri\nDone")["text"], "Done")
        self.assertIsNone(parse_wrapup_comment("Wrap-up was great!\nreally"))
        self.assertIsNone(parse_wrapup_comment("Great sprint, wrap-up tomorrow"))

    def test_template_without_text_is_ignored(self):
        self.assertIsNone(parse_wrapup_comment("## Wrap-up\n2026-10-30\n"))


class TestPlainText(unittest.TestCase):
    def test_markdown_is_flattened(self):
        self.assertEqual(plain_text("**Bold** [link](https://x.org) ![img](a.png)"), "Bold link (https://x.org)")

    def test_limit(self):
        self.assertEqual(plain_text("one two three four", 10), "one two…")


if __name__ == "__main__":
    unittest.main()


FIELDS_COMPARED = (
    "pitch",
    "contacts",
    "type",
    "working_groups",
    "goals",
    "links",
    "wrapup",
    "options",
    "schedule_note",
)


class TestTidyBody(unittest.TestCase):
    def test_compact_layout(self):
        tidy = tidy_body(FORM_BODY, "LBG sprint")
        self.assertNotIn("_No response_", tidy)
        self.assertTrue(
            tidy.startswith("Build a **pipeline** for LBGs.\n\n**Contacts:** @alice, Bob Smith (@bsmith)\n")
        )
        self.assertIn("**Type:** Paper Sprint · **Working groups:** PZ, WLSS · 🌱 New contributor friendly", tidy)
        self.assertIn("**Links:** Slack: #desc-lbg", tidy)
        self.assertIn("### Goals and deliverables\n\n1. A pipeline", tidy)
        self.assertIn("### More details\n\n```python", tidy)
        self.assertNotIn("Prerequisites", tidy)
        self.assertNotIn("### Wrap-up\n\n", tidy)  # the fixture's "### Wrap-up" is inside a code block

    def test_round_trip_and_idempotence(self):
        tidy = tidy_body(FORM_BODY, "LBG sprint")
        before, after = parse_issue_body(FORM_BODY), parse_issue_body(tidy)
        for key in FIELDS_COMPARED + ("details",):
            self.assertEqual(before[key], after[key], key)
        self.assertIsNone(tidy_body(tidy, "LBG sprint"))

    def test_only_a_pitch(self):
        body = (
            "### Short pitch\n\nJust an idea.\n\n### Contact person(s)\n\n_No response_\n\n"
            "### Sprint type\n\nGeneral Sprint\n"
        )
        self.assertEqual(tidy_body(body), "Just an idea.\n\n**Type:** General Sprint\n")

    def test_old_prerequisites_are_folded_into_more_details(self):
        body = "### Short pitch\n\nHi\n\n### Prerequisites\n\n- Python\n- NERSC\n\n### Detailed description\n\nMore."
        tidy = tidy_body(body)
        self.assertIn("### More details\n\n**Prerequisites:**\n- Python\n- NERSC\n\nMore.", tidy)
        self.assertEqual(parse_issue_body(tidy)["prerequisites"], "")

    def test_multi_line_links_and_multi_paragraph_pitch(self):
        body = (
            "### Short pitch\n\nFirst.\n\nSecond.\n\n"
            "### Communication channel and links\n\nSlack: #a\nRepo: https://x.org"
        )
        tidy = tidy_body(body)
        self.assertIn("**Links:**\nSlack: #a\nRepo: https://x.org", tidy)
        parsed = parse_issue_body(tidy)
        self.assertEqual((parsed["pitch"], parsed["links"]), ("First.\n\nSecond.", "Slack: #a\nRepo: https://x.org"))

    def test_other_text_is_left_alone(self):
        self.assertIsNone(tidy_body(LEGACY_BODY))
        self.assertIsNone(tidy_body("Just some text I wrote."))
        self.assertIsNone(tidy_body(""))

    def test_legacy_value_with_a_middle_dot_is_kept_whole(self):
        self.assertEqual(parse_issue_body("Day/Time: Mon · Tue\n\nPitch")["schedule_note"], "Day/Time: Mon · Tue")

    def test_every_demo_issue_round_trips(self):
        root = Path(__file__).resolve().parent.parent
        spec = importlib.util.spec_from_file_location("seed", root / "demo" / "seed.py")
        seed = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(seed)
        for sp in seed.load_demo()["sprints"]:
            raw = seed.issue_body(sp)
            tidy = tidy_body(raw, sp["title"])
            before, after = parse_issue_body(raw, sp["title"]), parse_issue_body(tidy, sp["title"])
            with self.subTest(title=sp["title"]):
                for key in FIELDS_COMPARED:
                    self.assertEqual(before[key], after[key], key)
                self.assertIn(before["details"], after["details"])
                self.assertEqual(after["prerequisites"], "")
                self.assertIsNone(tidy_body(tidy, sp["title"]))
