import unittest

from sprintweek.parse import (
    parse_contacts,
    parse_issue_body,
    parse_wrapup_comment,
    plain_text,
    split_sections,
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
            parse_contacts("Leo Sajkov (find on Slack or at sajkov@stanford.edu)"),
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
