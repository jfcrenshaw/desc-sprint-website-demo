"""Room availability checks and the automatic "please pick another room" notices.

Rooms come from ``sprintweek.yaml`` (see `sprintweek.config.Room`). A session is checked
only if its room matches a configured room of its site; rooms people type themselves
("Alice's office") are never flagged. The scheduling bot applies the same rules in
``worker/src/lib.js`` (`roomProblem`), so keep the two in sync.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re

NOTICE_MARKER = "sprintweek:room-notice"
RESOLVED_MARKER = "sprintweek:room-notice-resolved"
_NOTICE_RE = re.compile(r"<!--\s*sprintweek:room-notice\s+([\w:.-]+)\s*-->")


def norm(name: str) -> str:
    """Compare room names case- and whitespace-insensitively."""
    return " ".join((name or "").lower().split())


def find_room(session: dict, rooms_by_site: dict[str, list[dict]]) -> dict | None:
    """The configured room a session is booked in, or None for unknown or typed-in rooms."""
    wanted = norm(session.get("location", ""))
    if not wanted:
        return None
    return next((r for r in rooms_by_site.get(session.get("site", ""), []) if norm(r["name"]) == wanted), None)


def fits(session: dict, window: dict) -> bool:
    """Is the session (local date and times) inside one availability window?"""
    if window["date"] != session["date"]:
        return False
    return not window["start"] or (window["start"] <= session["start"] and session["end"] <= window["end"])


def room_problem(session: dict, rooms_by_site: dict[str, list[dict]]) -> str:
    """Explain why a session's room is unavailable, or return "" if it is fine.

    Parameters
    ----------
    session : dict
        Normalized session with ``site``, ``location``, ``date``, ``start``, ``end``.
    rooms_by_site : dict
        `Config.rooms_by_site`.

    Returns
    -------
    str
        For example ``"Redwood A is not available on Tue Oct 27 at 10:00–12:00
        (available: Mon 26, Wed 28; Tue 27 13:00–17:00)."``, or ``""``.
    """
    room = find_room(session, rooms_by_site)
    if room is None or room["available"] is None or any(fits(session, w) for w in room["available"]):
        return ""
    day = dt.date.fromisoformat(session["date"])
    return (
        f"{room['name']} is not available on {day:%a %b} {day.day} at {session['start']}–{session['end']} "
        f"(available: {room['summary']})."
    )


def notice_key(sprint: dict, session: dict) -> str:
    """Identify one conflict: the session plus the room and time that conflict."""
    what = "|".join(norm(session[k]) for k in ("location", "date", "start", "end"))
    return f"{sprint['number']}:{session['id']}:{hashlib.sha1(what.encode()).hexdigest()[:10]}"


def notice_body(sprint: dict, session: dict, scheduler_url: str) -> str:
    """The comment asking a sprint's team to move a session to another room."""
    key = notice_key(sprint, session)
    edit = f"{scheduler_url}/session/{session['id']}" if scheduler_url else session["url"]
    action = "Pick another room or time" if scheduler_url else "Edit the session comment"
    return "\n".join(
        [
            f"<!-- {NOTICE_MARKER} {key} -->",
            f"⚠️ **This session needs a new room.** {session['room_issue']}",
            "",
            f"[✏️ {action}]({edit}) · [view the session]({session['url']})",
            "",
            "<sub>Posted automatically because the organizers changed when this room is available. "
            "This note updates itself once the session is moved.</sub>",
        ]
    )


def resolved_body(old_body: str, key: str) -> str:
    """Turn an open notice into a struck-through "resolved" one."""
    skip = ("<!--", "<sub>", "[✏️")
    lines = [ln for ln in old_body.splitlines() if ln.strip() and not ln.lstrip().startswith(skip)]
    text = " ".join(lines).replace("⚠️ ", "")
    reason = "Resolved: the session, or the organizers' room list, has changed."
    return f"<!-- {RESOLVED_MARKER} {key} -->\n✅ ~~{text}~~ {reason}\n"


def plan_notices(
    data: dict, comments: list[dict], scheduler_url: str
) -> tuple[list[tuple[int, str]], list[tuple[int, str]]]:
    """Work out which room notices to post, refresh or mark resolved.

    Parameters
    ----------
    data : dict
        Output of `sprintweek.build.build_data` (sessions carry ``room_issue``).
    comments : list of dict
        All issue comments of the repository (snapshot format).
    scheduler_url : str
        Scheduling bot URL, for edit links.

    Returns
    -------
    to_post : list of (int, str)
        ``(issue number, comment body)`` for new conflicts.
    to_edit : list of (int, str)
        ``(comment id, new body)`` for open notices whose conflict is gone (marked
        resolved) or whose text is out of date, e.g. after availability changed again.
    """
    current = {}
    for sp in data["sprints"]:
        for s in sp["sessions"]:
            if s.get("room_issue"):
                current[notice_key(sp, s)] = (sp, s)
    open_notices = {}
    for c in comments:
        if c["user"] != "github-actions[bot]" or RESOLVED_MARKER in c["body"]:
            continue
        m = _NOTICE_RE.search(c["body"])
        if m:
            open_notices[m.group(1)] = c
    to_post = [
        (sp["number"], notice_body(sp, s, scheduler_url)) for key, (sp, s) in current.items() if key not in open_notices
    ]
    to_edit = []
    for key, c in open_notices.items():
        if key not in current:
            to_edit.append((c["id"], resolved_body(c["body"], key)))
        elif c["body"].strip() != (body := notice_body(*current[key], scheduler_url)).strip():
            to_edit.append((c["id"], body))
    return to_post, to_edit
