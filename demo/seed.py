"""Create the demo sprints from ``demo/sprints.toml``.

Usage
-----
Write the offline snapshot used by the tests and for local previews::

    python demo/seed.py snapshot demo/snapshot.json

Create labels, issues, session comments and wrap-up comments in the configured repository
(as the user logged in with ``gh``)::

    python demo/seed.py create

Re-running ``create`` is safe: existing issues (matched by title) and sessions are reused.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sprintweek.config import load_config  # noqa: E402
from sprintweek.github import GitHub, find_token  # noqa: E402
from sprintweek.parse import parse_list  # noqa: E402
from sprintweek.sessions import extract_session_data, normalize_session, render_session_comment  # noqa: E402

HERE = Path(__file__).resolve().parent
SEEDER = "jfcrenshaw"  # mentions of this account are kept (people are not notified about themselves)

# Form field id -> heading, in the order GitHub renders the issue form.
FORM = [
    ("pitch", "Short pitch"),
    ("contacts", "Contact person(s)"),
    ("type", "Sprint type"),
    ("working_groups", "Working groups"),
    ("goals", "Goals and deliverables"),
    ("prerequisites", "Prerequisites"),
    ("links", "Communication channel and links"),
    ("details", "Detailed description"),
    ("options", "Options"),
    ("wrapup", "Wrap-up"),
]
FORM_OPTIONS = ["New contributor friendly"]

# Labels copied from LSSTDESC/SprintWeek2026 (name: color, description).
LABELS = {
    "General Sprint": ("73c299", ""),
    "Infrastructure Sprint": ("06f6ed", ""),
    "Service Sprint": ("02ac4f", ""),
    "Paper Sprint": ("f6ed29", ""),
    "Tutorial": ("544fdb", ""),
    "New Contributor Friendly": ("e72e3f", ""),
    "CL": ("7aa64a", "Clusters"),
    "CO": ("d3791e", "Computing"),
    "DKM": ("d8f559", "Dark Matter"),
    "MCP": ("c0f6eb", "Modelling and Combined Probes"),
    "PLC": ("324ade", "Pixels to Light Curves"),
    "PO": ("fcdc65", "Pixels to Objects"),
    "PZ": ("2b9628", "Photometric redshifts"),
    "SC": ("7d9bd1", "Survey Coordination"),
    "SCS": ("a2f916", "Survey Computing & Simulation"),
    "SRV": ("0205c3", "Science Release Validation"),
    "TD": ("69a2e6", "Time Domain"),
    "WLSS": ("815534", "Weak Lensing & Large Scale Structure"),
    "STAR": ("7cc497", "Static Analysis Round Table"),
    "LBG": ("c20936", "Lyman Break Galaxies Topical Team"),
    "Beyond wCDM": ("54374e", "Beyond wCDM Topical Team"),
    "CCL + Firecrown": ("08f737", "Core Cosmology Library (CCL) + Firecrown Topical Team"),
    "Forecasting": ("a5c278", "Forecasting Topical Team"),
    "TJPCov": ("e2c7ed", "TJPCov Topical Team"),
    "PZ Data Challenge + RAIL": ("708c9d", "PZ Data Challenge and RAIL Development Topical Team"),
}


def defang(text: str) -> str:
    """Stop copied text from notifying people or creating backlinks in other repositories."""
    text = re.sub(r"https://github\.com/([\w.-]+/[\w.-]+)/(?:issues|pull)/(\d+)\S*", r"`\1#\2`", text)

    def mention(m: re.Match) -> str:
        return m.group(0) if m.group(1).lower() == SEEDER else f"`@{m.group(1)}`"

    return re.sub(r"(?<![\w`@/.])@([A-Za-z0-9][A-Za-z0-9-]{0,38})\b", mention, text)


def issue_body(sp: dict) -> str:
    """Render a sprint exactly as the GitHub issue form would."""
    parts = [
        f"> 🧪 Demo copy of SprintWeek2026 issue {sp['source']} for the calendar prototype. "
        "Mentions are disabled so nobody is notified.",
        "",
    ]
    for key, heading in FORM:
        if key == "options":
            ticked = sp.get("options", [])
            value = "\n".join(f"- [{'X' if o in ticked else ' '}] {o}" for o in FORM_OPTIONS)
        elif key == "working_groups":
            value = ", ".join(sp.get("working_groups", []))
        else:
            value = sp.get(key, "").strip()
        parts += [f"### {heading}", "", defang(value) or "_No response_", ""]
    return "\n".join(parts)


def labels_for(sp: dict) -> list[str]:
    """Labels the finished demo issue should carry (type and working groups are added by the bot)."""
    return [sp["type"], *parse_list(", ".join(sp.get("working_groups", []))), *sp.get("labels", [])] + (
        ["New Contributor Friendly"] if "New contributor friendly" in sp.get("options", []) else []
    )


def session_data(raw: dict, zoom: str) -> dict:
    data = {k: v for k, v in raw.items()}
    if data.get("online") == "zoom":
        data["online"] = zoom
    data["by"] = SEEDER
    return normalize_session(data)


def load_demo() -> dict:
    return tomllib.loads((HERE / "sprints.toml").read_text(encoding="utf-8"))


def write_snapshot(path: Path) -> None:
    """Write an offline snapshot in the format of `sprintweek.github.fetch_snapshot`."""
    demo, config = load_demo(), load_config()
    zones = [(s.name, s.timezone) for s in config.sites]
    issues, comments, cid = [], [], 4_000_000_000
    for n, sp in enumerate(demo["sprint"], start=1):
        url = f"https://github.com/{config.repo}/issues/{n}"
        stamp = f"2026-10-{19 + n % 6:02d}T16:{n:02d}:00Z"
        issues.append(
            {
                "number": n,
                "title": sp["title"],
                "body": issue_body(sp),
                "html_url": url,
                "state": "open",
                "state_reason": None,
                "user": SEEDER,
                "assignees": [],
                "labels": [
                    {"name": lb, "color": LABELS.get(lb, ("ededed", ""))[0], "description": LABELS.get(lb, ("", ""))[1]}
                    for lb in labels_for(sp)
                ],
                "created_at": stamp,
                "updated_at": stamp,
                "is_pull_request": False,
            }
        )
        bodies = [("github-actions[bot]", "NONE", "<!-- sprintweek:greeting -->\n👋 Thanks for proposing a sprint!")]
        bodies += [
            (SEEDER, "OWNER", render_session_comment(session_data(s, demo["zoom"]), zones))
            for s in sp.get("sessions", [])
        ]
        if sp.get("wrapup_comment"):
            bodies.append((SEEDER, "OWNER", defang(sp["wrapup_comment"].strip())))
        for user, assoc, body in bodies:
            cid += 1
            comments.append(
                {
                    "id": cid,
                    "issue": n,
                    "user": user,
                    "author_association": assoc,
                    "body": body,
                    "html_url": f"{url}#issuecomment-{cid}",
                    "created_at": stamp,
                    "updated_at": stamp,
                }
            )
    snapshot = {"repo": config.repo, "fetched_at": "2026-10-30T15:00:00Z", "issues": issues, "comments": comments}
    path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {path} with {len(issues)} issues and {len(comments)} comments.")


def create(dry_run: bool) -> None:
    """Create the demo in the configured repository."""
    demo, config = load_demo(), load_config()
    gh, repo = GitHub(find_token()), config.repo
    zones = [(s.name, s.timezone) for s in config.sites]

    existing = {lb["name"].lower() for lb in gh.paginate(f"/repos/{repo}/labels")}
    for name, (color, desc) in LABELS.items():
        if name.lower() not in existing:
            print(f"create label {name}")
            if not dry_run:
                gh.request("POST", f"/repos/{repo}/labels", {"name": name, "color": color, "description": desc})

    issues = {i["title"]: i for i in gh.paginate(f"/repos/{repo}/issues", {"state": "all"}) if "pull_request" not in i}
    for sp in demo["sprint"]:
        issue = issues.get(sp["title"])
        if issue is None:
            print(f"create issue: {sp['title']}")
            if dry_run:
                continue
            # Type and working-group labels are left for the triage bot to add.
            issue, _ = gh.request(
                "POST",
                f"/repos/{repo}/issues",
                {"title": sp["title"], "body": issue_body(sp), "labels": sp.get("labels", [])},
            )
            time.sleep(2)
        n = issue["number"]
        comments = gh.paginate(f"/repos/{repo}/issues/{n}/comments")
        have = set()
        for c in comments:
            data = extract_session_data(c.get("body") or "")
            if data:
                have.add((data.get("date"), data.get("start"), data.get("tz"), data.get("label", "")))
        for raw in sp.get("sessions", []):
            s = session_data(raw, demo["zoom"])
            if (s["date"], s["start"], s["tz"], s["label"]) in have:
                continue
            print(f"  #{n}: add session {s['date']} {s['start']} {s['tz']}")
            if not dry_run:
                gh.request("POST", f"/repos/{repo}/issues/{n}/comments", {"body": render_session_comment(s, zones)})
                time.sleep(2)
        if sp.get("wrapup_comment") and not any("## Wrap-up" in (c.get("body") or "") for c in comments):
            print(f"  #{n}: add wrap-up comment")
            if not dry_run:
                gh.request("POST", f"/repos/{repo}/issues/{n}/comments", {"body": defang(sp["wrapup_comment"].strip())})
                time.sleep(2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("snapshot")
    s.add_argument("path", type=Path)
    c = sub.add_parser("create")
    c.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.command == "snapshot":
        write_snapshot(args.path)
    else:
        create(args.dry_run)


if __name__ == "__main__":
    main()
