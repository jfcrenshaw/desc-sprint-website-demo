"""Forgiving date reading for text people type (wrap-up dates).

Accepts ``2026-10-29``, ``Thursday``, ``Thu Oct 29``, ``October 29``, ``29 Oct 2026``,
``10/29`` and ``29/10`` (numeric dates are read whichever way falls in the Sprint Week),
and the template placeholder ``YYYY-MM-DD`` (meaning "no date given").
"""

from __future__ import annotations

import datetime as dt
import re

WEEKDAYS = {
    **dict.fromkeys(("mon", "monday"), 0),
    **dict.fromkeys(("tue", "tues", "tuesday"), 1),
    **dict.fromkeys(("wed", "weds", "wednesday"), 2),
    **dict.fromkeys(("thu", "thur", "thurs", "thursday"), 3),
    **dict.fromkeys(("fri", "friday"), 4),
    **dict.fromkeys(("sat", "saturday"), 5),
    **dict.fromkeys(("sun", "sunday"), 6),
}
MONTHS = {
    name: i
    for i, names in enumerate(
        [
            ("jan", "january"),
            ("feb", "february"),
            ("mar", "march"),
            ("apr", "april"),
            ("may",),
            ("jun", "june"),
            ("jul", "july"),
            ("aug", "august"),
            ("sep", "sept", "september"),
            ("oct", "october"),
            ("nov", "november"),
            ("dec", "december"),
        ],  # fmt: skip
        start=1,
    )
    for name in names
}
PLACEHOLDER = "yyyy-mm-dd"

_WD = "|".join(sorted(WEEKDAYS, key=len, reverse=True))
_MO = "|".join(sorted(MONTHS, key=len, reverse=True))
_DAY = r"(\d{1,2})(?:st|nd|rd|th)?"
_YEAR = r"(?:,?\s*(\d{4}))?"
_ISO_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$")
_NUMERIC_RE = re.compile(r"^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$")
_MONTH_DAY_RE = re.compile(rf"^({_MO})\.?\s+{_DAY}{_YEAR}$", re.I)
_DAY_MONTH_RE = re.compile(rf"^{_DAY}\s+({_MO})\.?{_YEAR}$", re.I)
_WEEKDAY_RE = re.compile(rf"^({_WD})\.?(?:[,\s]+(.+))?$", re.I)


def _clean(text: str) -> str:
    return " ".join(re.sub(r"[*_`()\[\]]", " ", text or "").split()).strip(" ,.:;-–—").lower()


def _date(year: int, month: int, day: int) -> dt.date | None:
    try:
        return dt.date(year, month, day)
    except ValueError:
        return None


MAX_LENGTH = 60  # longer text is never a date (and is not worth parsing)


def _split_weekday(t: str) -> tuple[str | None, str]:
    """Split "thu oct 29" into ("thu", "oct 29"); text without a leading weekday is returned whole."""
    m = _WEEKDAY_RE.match(t)
    return (m.group(1), m.group(2) or "") if m else (None, t)


def looks_like_date(text: str) -> bool:
    """Does the whole text look like one of the accepted date forms (without checking it exists)?"""
    t = _clean(text)
    if len(t) > MAX_LENGTH:
        return False
    if t == PLACEHOLDER:
        return True
    weekday, rest = _split_weekday(t)
    if weekday and not rest:
        return True
    return any(r.match(rest) for r in (_ISO_RE, _NUMERIC_RE, _MONTH_DAY_RE, _DAY_MONTH_RE))


def parse_loose_date(text: str, days: list[dt.date]) -> tuple[dt.date | None, str]:
    """Read a typed date, using the Sprint Week to resolve weekdays and ambiguities.

    Parameters
    ----------
    text : str
        What the person wrote, e.g. ``"Thu Oct 29"`` or ``"10/29"``.
    days : list of datetime.date
        The days of the Sprint Week.

    Returns
    -------
    date : datetime.date or None
        The date, or None if none was given (placeholder) or it could not be read.
    problem : str
        Why the text could not be used ("" if it could, or if it was the placeholder).
    """
    t = _clean(text)
    if not t or t == PLACEHOLDER:
        return None, ""
    if len(t) > MAX_LENGTH:
        return None, "the date is too long to be read (write it like 2026-10-29)"
    year = days[0].year if days else dt.date.today().year
    weekday, t = _split_weekday(t)  # "Thursday, Oct 29": the explicit date wins
    if weekday and not t:
        matches = [d for d in days if d.weekday() == WEEKDAYS[weekday]]
        return (matches[0], "") if matches else (None, f"there is no {text.strip()} during the Sprint Week")
    candidates: list[dt.date | None] = []
    if m := _ISO_RE.match(t):
        candidates = [_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))]
    elif m := _MONTH_DAY_RE.match(t):
        candidates = [_date(int(m.group(3) or year), MONTHS[m.group(1)], int(m.group(2)))]
    elif m := _DAY_MONTH_RE.match(t):
        candidates = [_date(int(m.group(3) or year), MONTHS[m.group(2)], int(m.group(1)))]
    elif m := _NUMERIC_RE.match(t):
        a, b = int(m.group(1)), int(m.group(2))
        y = int(m.group(3)) if m.group(3) else year
        y += 2000 if y < 100 else 0
        candidates = list({_date(y, a, b), _date(y, b, a)} - {None})  # month/day and day/month
        in_week = [d for d in candidates if d in days]
        if len(in_week) == 1:
            return in_week[0], ""
        if len(candidates) > 1:
            return None, f"{text.strip()!r} could be read as {' or '.join(f'{d:%b %d}' for d in sorted(candidates))}"
    candidates = [d for d in candidates if d]
    if not candidates:
        return None, f"{text.strip()!r} is not a date (write it like 2026-10-29)"
    date = candidates[0]
    if days and date not in days:
        return None, f"{date:%a %b} {date.day} is not during the Sprint Week"
    return date, ""
