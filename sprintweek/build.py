"""Assemble the website data from a repository snapshot and write the static site."""

from __future__ import annotations

import datetime as dt
import json
import shutil
from collections import defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

from . import ics
from .config import PROGRAM_KINDS, Config
from .dates import parse_loose_date
from .parse import parse_contacts, parse_issue_body, parse_wrapup_comment, plain_text
from .rooms import room_problem
from .sessions import SessionError, extract_session_data, normalize_session

SITE_DIR = Path(__file__).resolve().parent.parent / "site"

# Comment authors (besides the scheduling bot) whose session and wrap-up comments are
# trusted: people with write access and, for organization repos, organization members.
TRUSTED_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}


def _is_excluded(issue: dict, config: Config) -> bool:
    if issue.get("is_pull_request") or issue.get("state_reason") == "not_planned":
        return True
    return any(lb["name"].lower() in config.exclude_labels for lb in issue["labels"])


def _tags(fields: dict, labels: list[dict], config: Config) -> list[dict]:
    """Merge the form's sprint type and working groups with the issue labels."""
    colors = {lb["name"].lower(): f"#{lb['color']}" for lb in labels if lb.get("color")}
    tags: dict[str, dict] = {}

    def add(name: str, kind: str) -> None:
        key = name.lower()
        if key not in tags:
            color = config.type_colors.get(name) if kind == "type" else None
            tags[key] = {"name": name, "kind": kind, "color": color or colors.get(key, "")}

    if fields["type"]:
        add(fields["type"], "type")
    for wg in fields["working_groups"]:
        add(wg, "group")
    for lb in labels:
        kind = "type" if lb["name"] in config.type_colors else "label"
        add(lb["name"], kind)
    return list(tags.values())


def _wrapup_date(hint: str | None, created_at: str, tz: str, config: Config) -> tuple[str, str]:
    """Resolve a wrap-up's date: its own date if readable, else the day it was posted (in ``tz``).

    Returns ``(YYYY-MM-DD, problem or "")``.
    """
    posted = dt.datetime.fromisoformat(created_at.replace("Z", "+00:00")).astimezone(ZoneInfo(tz)).date()
    date, problem = parse_loose_date(hint or "", config.days)
    if date:
        return date.isoformat(), ""
    if problem:
        return posted.isoformat(), f"{problem}, so it is shown on the day it was posted ({posted:%a %b} {posted.day})"
    return posted.isoformat(), ""


def build_sprint(issue: dict, comments: list[dict], config: Config) -> tuple[dict, list[str]]:
    """Combine one sprint issue and its comments into the record used by the website.

    Parameters
    ----------
    issue : dict
        Issue from a snapshot (see `sprintweek.github.fetch_snapshot`).
    comments : list of dict
        That issue's comments, oldest first.
    config : Config
        Event configuration.

    Returns
    -------
    sprint : dict
        Website record, including its sorted ``sessions``.
    warnings : list of str
        Problems worth showing to organizers (malformed or untrusted session comments,
        wrap-up dates that could not be read).
    """
    fields = parse_issue_body(issue["body"], issue["title"])
    contacts = parse_contacts(fields["contacts"]) or [{"login": issue["user"], "name": None}]
    people = {issue["user"].lower(), *(a.lower() for a in issue["assignees"])}
    people |= {c["login"].lower() for c in contacts if c["login"]}

    sessions, wrapup_comments, warnings, notes = [], [], [], []
    for c in comments:
        trusted = (config.bot_login and c["user"] == config.bot_login) or c[
            "author_association"
        ] in TRUSTED_ASSOCIATIONS
        try:
            data = extract_session_data(c["body"])
        except SessionError as err:
            warnings.append(f"Session comment {c['html_url']} was skipped: {err}.")
            continue
        if data is not None:
            if not trusted:
                warnings.append(
                    f"Session comment {c['html_url']} by {c['user']} was ignored: "
                    "only the scheduling bot and collaborators can post sessions."
                )
                continue
            try:
                session = normalize_session(data)
            except SessionError as err:
                warnings.append(f"Session comment {c['html_url']} was skipped: {err}.")
                continue
            session.update(id=str(c["id"]), url=c["html_url"], updated_at=c["updated_at"])
            if not session["site"] and session["location"]:  # hand-written comment without a site
                session["site"] = config.site_for_timezone(session["tz"]) or ""
            session["room_issue"] = room_problem(session, config.rooms_by_site)
            sessions.append(session)
            continue
        parsed = parse_wrapup_comment(c["body"])
        if parsed and (c["user"].lower() in people or c["author_association"] in TRUSTED_ASSOCIATIONS):
            wrapup_comments.append((c, parsed))
    sessions.sort(key=lambda s: (s["start_utc"], s["end_utc"]))

    # Each wrap-up comment is a separate wrap-up. Undated ones get the day they were posted,
    # in the time zone of the sprint's sessions (or of the first site).
    home_tz = sessions[0]["tz"] if sessions else (config.sites[0].timezone if config.sites else "UTC")
    wrapups = []
    for c, parsed in wrapup_comments:
        date, problem = _wrapup_date(parsed["date_hint"], c["created_at"], home_tz, config)
        if problem:
            notes.append(f"Wrap-up {c['html_url']}: {problem}.")
        wrapups.append(
            {"id": str(c["id"]), "date": date, "date_note": problem, "author": c["user"], "created_at": c["created_at"],
             "url": c["html_url"], "text": parsed["text"], "source": "comment"}  # fmt: skip
        )
    if fields["wrapup"]:  # the "Wrap-up" section of older issue forms
        last_day = sessions[-1]["date"] if sessions else config.end_date.isoformat()
        wrapups.append(
            {"id": f"issue-{issue['number']}", "date": last_day, "date_note": "", "author": issue["user"],
             "created_at": issue["updated_at"], "url": issue["html_url"], "text": fields["wrapup"],
             "source": "issue"}  # fmt: skip
        )
    wrapups.sort(key=lambda w: w["created_at"])

    sprint = {
        "number": issue["number"],
        "title": issue["title"].strip(),
        "url": issue["html_url"],
        "state": issue["state"],
        "author": issue["user"],
        "assignees": issue["assignees"],
        "contacts": contacts,
        "contacts_md": fields["contacts"],
        "pitch": fields["pitch"],
        "goals": fields["goals"],
        "prerequisites": fields["prerequisites"],
        "links": fields["links"],
        "details": fields["details"],
        "wrapups": wrapups,
        "schedule_note": fields["schedule_note"],
        "type": fields["type"],
        "working_groups": fields["working_groups"],
        "new_contributor_friendly": any("new contributor" in o.lower() for o in fields["options"]),
        "tags": _tags(fields, issue["labels"], config),
        "sessions": sessions,
        "warnings": warnings,
        "created_at": issue["created_at"],
        "updated_at": issue["updated_at"],
    }
    return sprint, warnings + notes


def build_data(snapshot: dict, config: Config) -> dict:
    """Build the complete data file of the website.

    Parameters
    ----------
    snapshot : dict
        Repository snapshot (issues and comments).
    config : Config
        Event configuration.

    Returns
    -------
    dict
        ``{"generated_at", "source", "config", "sprints", "warnings"}``.
    """
    by_issue = defaultdict(list)
    for c in sorted(snapshot["comments"], key=lambda c: c["created_at"]):
        by_issue[c["issue"]].append(c)
    sprints, warnings = [], []
    for issue in sorted(snapshot["issues"], key=lambda i: i["number"]):
        if _is_excluded(issue, config):
            continue
        sprint, w = build_sprint(issue, by_issue[issue["number"]], config)
        sprints.append(sprint)
        warnings += [f"#{issue['number']}: {x}" for x in w]
        warnings += [
            f"#{issue['number']}: {s['room_issue']} ({s['url']})" for s in sprint["sessions"] if s["room_issue"]
        ]
    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {"repo": snapshot.get("repo", config.repo), "fetched_at": snapshot.get("fetched_at")},
        "config": config.public(),
        "sprints": sprints,
        "site_info": [
            {
                "site": s.name,
                "slug": s.slug,
                "path": s.info,
                "markdown": (config.root / s.info).read_text(encoding="utf-8"),
                "base": s.info.rsplit("/", 1)[0] + "/",  # relative links and images resolve from here
            }
            for s in config.sites
            if s.info
        ],
        "warnings": warnings,
    }


# Organizers' program items worth putting in people's calendars (not coffee or lunch).
FEED_KINDS = ("plenary", "social")


def calendar_events(sprints: list[dict], config: Config, program_kinds: tuple[str, ...] = FEED_KINDS) -> list[dict]:
    """Convert every session, plus program items of ``program_kinds``, into iCalendar events."""
    events = []
    for item in config.program:
        if item["kind"] not in program_kinds:
            continue
        place = " – ".join(x for x in (item["site"], item["location"]) if x)
        desc = [
            item["note"],
            f"Join online: {item['online']}" if item["online"] else "",
            f"Schedule: {config.site_url}",
        ]
        events.append(
            {
                "uid": f"program-{item['id']}@{config.repo.replace('/', '.')}.sprintweek",
                "start_utc": item["start_utc"],
                "end_utc": item["end_utc"],
                "summary": item["title"],
                "location": " / ".join(x for x in (place, "Online" if item["online"] else "") if x),
                "description": "\n\n".join(x for x in desc if x),
                "url": config.site_url,
            }
        )
    for sp in sprints:
        for s in sp["sessions"]:
            summary = sp["title"] + (f" — {s['label']}" if s["label"] else "")
            place = " – ".join(x for x in (s["site"], s["location"]) if x)
            location = " / ".join(x for x in (place, "Online" if s["online"] else "") if x)
            desc = [plain_text(sp["pitch"], 600)]
            if s["online"]:
                desc.append(f"Join online: {s['online']}")
            if s["note"]:
                desc.append(s["note"])
            desc.append(f"Details: {config.site_url}#sprint/{sp['number']}")
            desc.append(f"GitHub issue: {sp['url']}")
            events.append(
                {
                    "uid": f"session-{s['id']}@{config.repo.replace('/', '.')}.sprintweek",
                    "start_utc": s["start_utc"],
                    "end_utc": s["end_utc"],
                    "summary": summary,
                    "location": location,
                    "description": "\n\n".join(x for x in desc if x),
                    "url": sp["url"],
                    "updated_at": s["updated_at"],
                }
            )
    return events


def write_site(data: dict, config: Config, out_dir: str | Path, site_dir: str | Path = SITE_DIR) -> None:
    """Write the deployable website.

    Parameters
    ----------
    data : dict
        Output of `build_data`.
    config : Config
        Event configuration.
    out_dir : str or Path
        Destination; replaced if it exists.
    site_dir : str or Path, optional
        Static frontend files to copy.
    """
    out = Path(out_dir)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(site_dir, out)
    (out / ".nojekyll").write_text("")
    for folder in sorted({s.info.rsplit("/", 1)[0] for s in config.sites if s.info}):
        shutil.copytree(config.root / folder, out / folder, dirs_exist_ok=True)  # info pages and their images
    (out / "data").mkdir(exist_ok=True)
    (out / "data" / "sprints.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "data" / "config.json").write_text(
        json.dumps(data["config"], ensure_ascii=False, indent=1), encoding="utf-8"
    )

    events = calendar_events(data["sprints"], config)
    (out / "calendar.ics").write_text(
        ics.calendar(config.title, events, data["generated_at"]), encoding="utf-8", newline=""
    )
    (out / "ics").mkdir(exist_ok=True)
    for sp in data["sprints"]:
        if sp["sessions"]:
            mine = [e for e in events if e["uid"].split("@")[0] in {f"session-{s['id']}" for s in sp["sessions"]}]
            name = f"{sp['title']} ({config.title})"
            (out / "ics" / f"sprint-{sp['number']}.ics").write_text(
                ics.calendar(name, mine, data["generated_at"]), encoding="utf-8", newline=""
            )
    # One file per session and per program item, for "Add to calendar: Apple / other (.ics)".
    for ev in calendar_events(data["sprints"], config, program_kinds=PROGRAM_KINDS):
        (out / "ics" / f"{ev['uid'].split('@')[0]}.ics").write_text(
            ics.calendar(ev["summary"], [ev], data["generated_at"]), encoding="utf-8", newline=""
        )
