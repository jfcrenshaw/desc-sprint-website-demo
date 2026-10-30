"""Write iCalendar (RFC 5545) feeds. Times are always written in UTC."""

from __future__ import annotations

import datetime as dt


def escape(text: str) -> str:
    """Escape a TEXT value."""
    return (
        (text or "")
        .replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r", "")
        .replace("\n", "\\n")
    )


def fold(line: str) -> str:
    """Fold a content line into chunks of at most 75 octets, never splitting a UTF-8 character."""
    out, current, size = [], "", 0
    for ch in line:
        n = len(ch.encode())
        if size + n > (75 if not out else 74):  # continuation lines start with one space
            out.append(current)
            current, size = "", 0
        current += ch
        size += n
    out.append(current)
    return "\r\n ".join(out)


def stamp(iso: str) -> str:
    """Convert ``2026-10-27T13:00:00Z`` to ``20261027T130000Z``."""
    d = dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    return d.strftime("%Y%m%dT%H%M%SZ")


def calendar(name: str, events: list[dict], generated_at: str) -> str:
    """Build an ``.ics`` document.

    Parameters
    ----------
    name : str
        Calendar name shown by calendar apps.
    events : list of dict
        Each with ``uid``, ``start_utc``, ``end_utc``, ``summary`` and optionally
        ``description``, ``location``, ``url`` and ``updated_at``.
    generated_at : str
        ISO 8601 UTC time used as the DTSTAMP of every event.

    Returns
    -------
    str
        The calendar with CRLF line endings.
    """
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//LSST DESC//Sprint Week calendar//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{escape(name)}",
        "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
        "X-PUBLISHED-TTL:PT1H",
    ]
    for ev in events:
        lines += [
            "BEGIN:VEVENT",
            f"UID:{ev['uid']}",
            f"DTSTAMP:{stamp(generated_at)}",
            f"DTSTART:{stamp(ev['start_utc'])}",
            f"DTEND:{stamp(ev['end_utc'])}",
            f"SUMMARY:{escape(ev['summary'])}",
        ]
        if ev.get("updated_at"):
            lines.append(f"LAST-MODIFIED:{stamp(ev['updated_at'])}")
        if ev.get("location"):
            lines.append(f"LOCATION:{escape(ev['location'])}")
        if ev.get("description"):
            lines.append(f"DESCRIPTION:{escape(ev['description'])}")
        if ev.get("url"):
            lines.append(f"URL:{ev['url']}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(ln) for ln in lines) + "\r\n"
