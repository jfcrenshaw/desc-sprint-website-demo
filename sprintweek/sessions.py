"""Scheduled sessions, stored as comments on the sprint issue.

Each session is one issue comment, normally posted by the scheduling bot. The comment
shows a human-readable summary and carries the authoritative data in a hidden line::

    <!-- sprintweek:session {"v":1,"date":"2026-10-27","start":"14:00","end":"16:00",
         "tz":"Europe/Paris","site":"Paris","location":"Salle 3","online":"https://...",
         "label":"","note":"","by":"alice"} -->

A cancelled session keeps its comment (so people can see what happened) with the
marker changed to ``sprintweek:cancelled``.
"""

from __future__ import annotations

import datetime as dt
import json
import re
from collections.abc import Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MARKER = "sprintweek:session"
CANCELLED_MARKER = "sprintweek:cancelled"
_DATA_RE = re.compile(r"<!--\s*sprintweek:session\s*(\{.*?\})\s*-->", re.S)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
LIMITS = {"location": 200, "online": 500, "label": 80, "note": 300, "site": 60, "by": 39}


class SessionError(ValueError):
    """A session comment that cannot be understood. The message is shown to people."""


def extract_session_data(body: str) -> dict | None:
    """Return the raw data of a session comment.

    Parameters
    ----------
    body : str
        Comment body.

    Returns
    -------
    dict or None
        The decoded data, or None if the comment is not a (live) session comment.

    Raises
    ------
    SessionError
        If the hidden data line is present but is not valid JSON.
    """
    m = _DATA_RE.search(body or "")
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError as err:
        raise SessionError(f"the hidden session data is not valid JSON ({err.msg})") from None
    if not isinstance(data, dict):
        raise SessionError("the hidden session data is not a JSON object")
    return data


def _text(data: dict, key: str) -> str:
    value = data.get(key) or ""
    if not isinstance(value, str):
        raise SessionError(f"'{key}' must be text")
    value = " ".join(value.split())  # no newlines or control characters
    return value[: LIMITS[key]]


def _time(data: dict, key: str) -> dt.time:
    value = str(data.get(key) or "")
    m = _TIME_RE.match(value)
    if not m:
        raise SessionError(f"'{key}' time {value!r} is not in 24-hour HH:MM format")
    return dt.time(int(m.group(1)), int(m.group(2)))


def normalize_session(data: dict) -> dict:
    """Validate session data and compute its start and end in UTC.

    Parameters
    ----------
    data : dict
        Raw session data from `extract_session_data`.

    Returns
    -------
    dict
        Cleaned fields plus ``start_utc``/``end_utc`` (ISO 8601, ``Z`` suffix),
        ``tz_abbr`` (e.g. ``"CET"``) and ``mode`` (``"in person"``, ``"online"``,
        ``"hybrid"`` or ``""`` when no place is given yet).

    Raises
    ------
    SessionError
        If the date, times or time zone are missing or invalid, or the session ends
        before it starts.
    """
    date_str = str(data.get("date") or "")
    if not _DATE_RE.match(date_str):
        raise SessionError(f"date {date_str!r} is not in YYYY-MM-DD format")
    try:
        date = dt.date.fromisoformat(date_str)
    except ValueError:
        raise SessionError(f"date {date_str!r} does not exist") from None

    start, end = _time(data, "start"), _time(data, "end")
    if end <= start:
        raise SessionError(f"the session ends ({end:%H:%M}) before it starts ({start:%H:%M})")

    tz_name = str(data.get("tz") or "")
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        raise SessionError(f"unknown time zone {tz_name!r}") from None

    online = _text(data, "online")
    if online and not re.match(r"^https://[^\s<>\"']+$", online):
        raise SessionError("the online link must start with https://")

    start_local = dt.datetime.combine(date, start, tzinfo=tz)
    end_local = dt.datetime.combine(date, end, tzinfo=tz)
    location, site = _text(data, "location"), _text(data, "site")
    physical = bool(location or site)
    mode = "hybrid" if physical and online else "online" if online else "in person" if physical else ""
    by = _text(data, "by")
    if by and not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})", by):
        by = ""

    def utc(d: dt.datetime) -> str:
        return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return {
        "date": date.isoformat(),
        "start": f"{start:%H:%M}",
        "end": f"{end:%H:%M}",
        "tz": tz_name,
        "tz_abbr": start_local.tzname(),
        "start_utc": utc(start_local),
        "end_utc": utc(end_local),
        "site": site,
        "location": location,
        "online": online,
        "mode": mode,
        "label": _text(data, "label"),
        "note": _text(data, "note"),
        "by": by,
    }


def encode_session_data(data: dict) -> str:
    """Serialize session data into the hidden comment line.

    ``<``, ``>`` and ``&`` are escaped so user text can never close the HTML comment.
    """
    fields = ("date", "start", "end", "tz", "site", "location", "online", "label", "note", "by")
    payload = {"v": 1, **{k: data.get(k, "") for k in fields}}
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    text = text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return f"<!-- {MARKER} {text} -->"


def _md_escape(text: str) -> str:
    """Escape Markdown and defang @mentions in user-supplied text."""
    text = re.sub(r"([\\`*_{}\[\]<>()#+!|~])", r"\\\1", text)
    return text.replace("@", "@​")


def render_session_comment(session: dict, other_timezones: Sequence[tuple[str, str]] = (), edit_url: str = "") -> str:
    """Render the comment the scheduling bot posts for a session.

    The scheduling bot (``worker/src/index.js``) produces the same layout; only the
    hidden data line is read back by the build, so the visible text may differ.

    Parameters
    ----------
    session : dict
        Normalized session from `normalize_session`.
    other_timezones : sequence of (str, str)
        ``(label, IANA zone)`` pairs for "also at" conversions, e.g. other sites.
    edit_url : str, optional
        Link to the scheduling form for editing or cancelling this session.

    Returns
    -------
    str
        Markdown comment body.
    """
    start = dt.datetime.fromisoformat(session["start_utc"].replace("Z", "+00:00"))
    end = dt.datetime.fromisoformat(session["end_utc"].replace("Z", "+00:00"))
    tz = ZoneInfo(session["tz"])
    s, e = start.astimezone(tz), end.astimezone(tz)
    when = f"{s:%A, %B} {s.day} · {s:%H:%M}–{e:%H:%M} {s.tzname()}"
    title = f"📅 **Session scheduled{': ' + _md_escape(session['label']) if session.get('label') else ''}**"
    lines = [encode_session_data(session), title, "", f"**When:** {when}"]
    also = []
    for label, zone in other_timezones:
        if zone != session["tz"]:
            zs, ze = start.astimezone(ZoneInfo(zone)), end.astimezone(ZoneInfo(zone))
            day = f", {zs:%a}" if zs.date() != s.date() else ""
            also.append(f"{zs:%H:%M}–{ze:%H:%M} {zs.tzname()} ({label}{day})")
    if also:
        lines.append(f"<sub>= {' · '.join(also)}</sub>")
    where = []
    place = [_md_escape(session[k]) for k in ("site", "location") if session.get(k)]
    if place:
        where.append("📍 " + " – ".join(place))
    if session.get("online"):
        where.append(f"💻 [Join online]({session['online']})")
    lines.append(f"**Where:** {' · '.join(where) if where else 'to be announced'}")
    if session.get("note"):
        lines.append(f"**Note:** {_md_escape(session['note'])}")
    footer = f"Scheduled by [{session['by']}](https://github.com/{session['by']})" if session.get("by") else ""
    if edit_url:
        footer += f"{' · ' if footer else ''}[✏️ Edit or cancel this session]({edit_url})"
    if footer:
        lines += ["", f"<sub>{footer}</sub>"]
    return "\n".join(lines) + "\n"
