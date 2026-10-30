"""Load ``sprintweek.yaml``, the per-event configuration.

The file is read with PyYAML's ``BaseLoader``, which keeps every value as text, so YAML
never guesses types (unquoted ``10:30`` would otherwise become the number 630, and
``no`` would become ``False``). Values are then checked and converted here, and any
problem raises `ConfigError` naming the offending setting.
"""

from __future__ import annotations

import datetime as dt
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import yaml

from .sessions import SessionError, normalize_session

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "sprintweek.yaml"
PROGRAM_KINDS = ("break", "meal", "plenary", "social")


class ConfigError(ValueError):
    """A problem in the configuration file. The message names the setting to fix."""


@dataclass
class Room:
    """A bookable room and when it can be used.

    ``available`` is None for "the whole week", else a list of windows
    ``{"date": "YYYY-MM-DD", "start": "HH:MM" or "", "end": "HH:MM" or ""}`` in the
    site's local time; empty times mean the whole day.
    """

    name: str
    available: list[dict] | None = None
    summary: str = "all week"

    def public(self) -> dict:
        return {"name": self.name, "available": self.available, "summary": self.summary}


@dataclass
class Site:
    """A physical venue with its own time zone."""

    name: str
    timezone: str
    rooms: list[Room] = field(default_factory=list)


@dataclass
class Config:
    """Everything the build, the website and the scheduling bot need to know."""

    title: str
    start_date: dt.date
    end_date: dt.date
    default_timezone: str
    sites: list[Site]
    repo: str
    exclude_labels: list[str]
    greet_new_issues: bool
    auto_label: bool
    scheduler_url: str
    bot_login: str
    org: str
    site_url: str
    type_colors: dict[str, str]
    program: list[dict] = field(default_factory=list)

    @property
    def days(self) -> list[dt.date]:
        """All dates of the Sprint Week, inclusive."""
        n = (self.end_date - self.start_date).days + 1
        return [self.start_date + dt.timedelta(days=i) for i in range(n)]

    @property
    def new_sprint_url(self) -> str:
        return f"https://github.com/{self.repo}/issues/new?template=sprint.yml"

    @property
    def rooms_by_site(self) -> dict[str, list[dict]]:
        """Published room descriptions keyed by site name (see `sprintweek.rooms`)."""
        return {s.name: [r.public() for r in s.rooms] for s in self.sites}

    def site_for_timezone(self, tz: str) -> str | None:
        """Return the name of the first site using time zone ``tz``, if any."""
        for site in self.sites:
            if site.timezone == tz:
                return site.name
        return None

    def public(self) -> dict:
        """Return the subset of the configuration published with the website.

        Returns
        -------
        dict
            JSON-serializable settings used by the frontend and the scheduling bot,
            including the expanded organizers' program. Contains no secrets.
        """
        noon = dt.datetime.combine(self.start_date, dt.time(12))
        return {
            "title": self.title,
            "start_date": self.start_date.isoformat(),
            "end_date": self.end_date.isoformat(),
            "days": [d.isoformat() for d in self.days],
            "default_timezone": self.default_timezone,
            "sites": [
                {
                    "name": s.name,
                    "timezone": s.timezone,
                    # Abbreviation during the event, e.g. "PDT" (browsers often only offer "GMT+1").
                    "abbr": noon.replace(tzinfo=ZoneInfo(s.timezone)).tzname(),
                    "rooms": [r.public() for r in s.rooms],
                }
                for s in self.sites
            ],
            "program": self.program,
            "repo": self.repo,
            "repo_url": f"https://github.com/{self.repo}",
            "new_sprint_url": self.new_sprint_url,
            "scheduler_url": self.scheduler_url,
            "bot_login": self.bot_login,
            "org": self.org,
            "site_url": self.site_url,
            "type_colors": self.type_colors,
        }


# ---------------------------------------------------------------- value checks


def _section(raw: dict, key: str) -> dict:
    value = raw.get(key) or {}
    if not isinstance(value, dict):
        raise ConfigError(f"'{key}' must be a section of 'name: value' settings")
    return value


def _text(value, where: str, required: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ConfigError(f"{where}: expected a single value, not a list or section")
    value = value.strip()
    if required and not value:
        raise ConfigError(f"{where}: this setting is required")
    return value


def _bool(value, where: str, default: bool) -> bool:
    text = _text(value, where).lower()
    if not text:
        return default
    if text in ("true", "yes", "on"):
        return True
    if text in ("false", "no", "off"):
        return False
    raise ConfigError(f"{where}: expected true or false, got {text!r}")


def _list(value, where: str) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [value.strip()]
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ConfigError(f"{where}: expected a list such as [a, b]")
    return [v.strip() for v in value if v.strip()]


def _date(value, where: str) -> dt.date:
    text = _text(value, where, required=True)
    try:
        return dt.date.fromisoformat(text)
    except ValueError:
        raise ConfigError(f"{where}: {text!r} is not a date in YYYY-MM-DD format") from None


def _timezone(value, where: str) -> str:
    text = _text(value, where, required=True)
    try:
        ZoneInfo(text)
    except (ZoneInfoNotFoundError, ValueError):
        raise ConfigError(f"{where}: unknown time zone {text!r} (use a name like Europe/Paris)") from None
    return text


WEEKDAYS = {
    **dict.fromkeys(("mon", "monday"), 0),
    **dict.fromkeys(("tue", "tues", "tuesday"), 1),
    **dict.fromkeys(("wed", "weds", "wednesday"), 2),
    **dict.fromkeys(("thu", "thur", "thurs", "thursday"), 3),
    **dict.fromkeys(("fri", "friday"), 4),
    **dict.fromkeys(("sat", "saturday"), 5),
    **dict.fromkeys(("sun", "sunday"), 6),
}


def _days(value, days: list[dt.date], where: str) -> list[dt.date]:
    """Resolve ``all``, weekday names (``[Mon, Wed]``) and dates into sorted dates."""
    if isinstance(value, str) and value.strip().lower() == "all":
        return list(days)
    out = []
    for item in _list(value, where):
        key = item.lower().rstrip(".")
        if key in WEEKDAYS:
            matches = [d for d in days if d.weekday() == WEEKDAYS[key]]
            if not matches:
                raise ConfigError(f"{where}: there is no {item} during the Sprint Week")
            out += matches
        else:
            out.append(_date(item, where))
    if not out:
        raise ConfigError(f"{where}: give 'all', weekday names such as [Mon, Wed], or dates")
    return sorted(set(out))


def _clock(value, where: str) -> str:
    text = _text(value, where)
    m = re.fullmatch(r"([01]?\d|2[0-3]):([0-5]\d)", text)
    if not m:
        raise ConfigError(f"{where}: {text!r} is not a 24-hour time like 13:00")
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def _rooms(items, days: list[dt.date], where: str) -> list[Room]:
    """Validate a site's rooms: plain names (always available) or name + available windows."""
    if items is None or items == "":
        return []
    if not isinstance(items, list):
        raise ConfigError(f"{where}: expected a list of rooms")
    rooms, seen = [], set()
    for i, item in enumerate(items):
        if isinstance(item, str):
            room = Room(_text(item, f"{where}[{i + 1}]", required=True))
        elif isinstance(item, dict):
            name = _text(item.get("name"), f"{where}[{i + 1}].name", required=True)
            here = f"{where} → {name!r}"
            unknown = set(item) - {"name", "available"}
            if unknown:
                raise ConfigError(f"{here}: unknown setting(s) {', '.join(sorted(unknown))}")
            windows = item.get("available")
            if windows is None or windows == "":
                room = Room(name)
            else:
                if not isinstance(windows, list) or not windows:
                    raise ConfigError(f"{here}.available: expected a list of '- days: ...' entries")
                available, parts = [], []
                for j, w in enumerate(windows):
                    at = f"{here}.available[{j + 1}]"
                    if not isinstance(w, dict):
                        raise ConfigError(f"{at}: expected days (and optionally start and end)")
                    unknown = set(w) - {"days", "start", "end"}
                    if unknown:
                        raise ConfigError(f"{at}: unknown setting(s) {', '.join(sorted(unknown))}")
                    dates = _days(w.get("days"), days, f"{at}.days")
                    start = _clock(w["start"], f"{at}.start") if w.get("start") else ""
                    end = _clock(w["end"], f"{at}.end") if w.get("end") else ""
                    # Only an end means "until", only a start means "from"; neither is the whole day.
                    if bool(start) != bool(end):
                        start, end = start or "00:00", end or "24:00"
                    if start and end <= start:
                        raise ConfigError(f"{at}: end ({end}) must be after start ({start})")
                    available += [{"date": d.isoformat(), "start": start, "end": end} for d in dates]
                    hours = (
                        ""
                        if not start
                        else f" until {end}"
                        if start == "00:00"
                        else f" from {start}"
                        if end == "24:00"
                        else f" {start}–{end}"
                    )
                    parts.append(", ".join(f"{d:%a} {d.day}" for d in dates) + hours)
                available.sort(key=lambda w: (w["date"], w["start"]))
                room = Room(name, available, "; ".join(parts))
        else:
            raise ConfigError(f"{where}[{i + 1}]: expected a room name, or name and available")
        key = " ".join(room.name.lower().split())
        if key in seen:
            raise ConfigError(f"{where}: room {room.name!r} is listed twice")
        seen.add(key)
        rooms.append(room)
    return rooms


def _program(items, site: Site, days: list[dt.date], where: str) -> list[dict]:
    """Validate a site's program and expand it into one entry per day."""
    if items is None or items == "":
        return []
    if not isinstance(items, list):
        raise ConfigError(f"{where}: expected a list of program items")
    out = []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            raise ConfigError(f"{where}[{i + 1}]: expected title, kind, days, start, end, ...")
        title = _text(item.get("title"), f"{where}[{i + 1}].title", required=True)
        here = f"{where} → {title!r}"
        unknown = set(item) - {"title", "kind", "days", "start", "end", "location", "online", "note"}
        if unknown:
            raise ConfigError(f"{here}: unknown setting(s) {', '.join(sorted(unknown))}")
        kind = _text(item.get("kind"), f"{here}.kind", required=True).lower()
        if kind not in PROGRAM_KINDS:
            raise ConfigError(f"{here}.kind: must be one of {', '.join(PROGRAM_KINDS)}")
        for date in _days(item.get("days"), days, f"{here}.days"):
            data = {
                "date": date.isoformat(),
                "start": _text(item.get("start"), f"{here}.start", required=True),
                "end": _text(item.get("end"), f"{here}.end", required=True),
                "tz": site.timezone,
                "site": site.name,
                "location": _text(item.get("location"), f"{here}.location"),
                "online": _text(item.get("online"), f"{here}.online"),
                "label": title,
                "note": _text(item.get("note"), f"{here}.note"),
            }
            try:
                s = normalize_session(data)
            except SessionError as err:
                raise ConfigError(f"{here} on {date}: {err}") from None
            out.append(
                {
                    "id": f"{site.name}-{i + 1}-{date.isoformat()}",
                    "title": s["label"],
                    "kind": kind,
                    **{k: s[k] for k in ("site", "date", "start", "end", "tz", "tz_abbr", "start_utc", "end_utc")},
                    **{k: s[k] for k in ("location", "online", "note")},
                }
            )
    return out


def load_config(path: str | Path | None = None, repo: str | None = None) -> Config:
    """Read and validate the configuration file.

    Parameters
    ----------
    path : str or Path, optional
        Location of the YAML file. Defaults to ``sprintweek.yaml`` at the repository root.
    repo : str, optional
        ``owner/name`` overriding the configured repository.

    Returns
    -------
    Config
        The parsed configuration.

    Raises
    ------
    ConfigError
        If a setting is missing or invalid; the message names the setting.
    """
    path = Path(path or DEFAULT_CONFIG)
    try:
        raw = yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader) or {}
    except yaml.YAMLError as err:
        raise ConfigError(f"{path.name} is not valid YAML: {err}") from None
    if not isinstance(raw, dict):
        raise ConfigError(f"{path.name} must contain sections such as event:, sites:, github:")

    event, gh, sched = _section(raw, "event"), _section(raw, "github"), _section(raw, "scheduler")
    start, end = _date(event.get("start_date"), "event.start_date"), _date(event.get("end_date"), "event.end_date")
    if end < start:
        raise ConfigError("event.end_date is before event.start_date")
    days = [start + dt.timedelta(days=i) for i in range((end - start).days + 1)]

    raw_sites = raw.get("sites") or []
    if not isinstance(raw_sites, list):
        raise ConfigError("sites: expected a list of sites (each starting with '- name: ...')")
    sites, program = [], []
    for i, s in enumerate(raw_sites):
        if not isinstance(s, dict):
            raise ConfigError(f"sites[{i + 1}]: expected name, timezone, rooms, program")
        name = _text(s.get("name"), f"sites[{i + 1}].name", required=True)
        site = Site(
            name,
            _timezone(s.get("timezone"), f"sites → {name}.timezone"),
            _rooms(s.get("rooms"), days, f"sites → {name}.rooms"),
        )
        sites.append(site)
        program += _program(s.get("program"), site, days, f"sites → {name}.program")
    program.sort(key=lambda p: (p["start_utc"], p["end_utc"]))

    repo = (
        repo
        or os.environ.get("SPRINTWEEK_REPO")
        or _text(gh.get("repo"), "github.repo")
        or os.environ.get("GITHUB_REPOSITORY")
    )
    if not repo or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise ConfigError("github.repo: set it to 'owner/name' (or run inside GitHub Actions)")
    owner, name = repo.split("/", 1)

    site_url = _text(_section(raw, "site").get("url"), "site.url") or f"https://{owner.lower()}.github.io/{name}/"
    if not site_url.endswith("/"):
        site_url += "/"

    colors = _section(raw, "types")
    for type_name, color in colors.items():
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color.strip()):
            raise ConfigError(f'types.{type_name}: expected a quoted color like "#2f6fdf"')

    return Config(
        title=_text(event.get("title"), "event.title") or "Sprint Week",
        start_date=start,
        end_date=end,
        default_timezone=_text(event.get("default_timezone"), "event.default_timezone") or "local",
        sites=sites,
        repo=repo,
        exclude_labels=[s.lower() for s in _list(gh.get("exclude_labels"), "github.exclude_labels")],
        greet_new_issues=_bool(gh.get("greet_new_issues"), "github.greet_new_issues", True),
        auto_label=_bool(gh.get("auto_label"), "github.auto_label", True),
        scheduler_url=_text(sched.get("url"), "scheduler.url").rstrip("/"),
        bot_login=_text(sched.get("bot_login"), "scheduler.bot_login"),
        org=_text(sched.get("org"), "scheduler.org"),
        site_url=site_url,
        type_colors={k: v.strip() for k, v in colors.items()},
        program=program,
    )
