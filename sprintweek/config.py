"""Load ``sprintweek.toml``, the per-event configuration."""

from __future__ import annotations

import datetime as dt
import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "sprintweek.toml"


@dataclass
class Site:
    """A physical venue with its own time zone."""

    name: str
    timezone: str
    rooms: list[str] = field(default_factory=list)


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

    @property
    def days(self) -> list[dt.date]:
        """All dates of the Sprint Week, inclusive."""
        n = (self.end_date - self.start_date).days + 1
        return [self.start_date + dt.timedelta(days=i) for i in range(n)]

    @property
    def new_sprint_url(self) -> str:
        return f"https://github.com/{self.repo}/issues/new?template=sprint.yml"

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
            JSON-serializable settings used by the frontend and the scheduling bot.
            Contains no secrets.
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
                    "rooms": s.rooms,
                }
                for s in self.sites
            ],
            "repo": self.repo,
            "repo_url": f"https://github.com/{self.repo}",
            "new_sprint_url": self.new_sprint_url,
            "scheduler_url": self.scheduler_url,
            "bot_login": self.bot_login,
            "org": self.org,
            "site_url": self.site_url,
            "type_colors": self.type_colors,
        }


def load_config(path: str | Path | None = None, repo: str | None = None) -> Config:
    """Read and validate the configuration file.

    Parameters
    ----------
    path : str or Path, optional
        Location of the TOML file. Defaults to ``sprintweek.toml`` at the repository root.
    repo : str, optional
        ``owner/name`` overriding the configured repository.

    Returns
    -------
    Config
        The parsed configuration.

    Raises
    ------
    ValueError
        If a required setting is missing or invalid.
    """
    raw = tomllib.loads(Path(path or DEFAULT_CONFIG).read_text(encoding="utf-8"))
    event = raw.get("event", {})
    gh = raw.get("github", {})
    sched = raw.get("scheduler", {})

    start, end = event.get("start_date"), event.get("end_date")
    if not isinstance(start, dt.date) or not isinstance(end, dt.date) or end < start:
        raise ValueError("[event] start_date and end_date must be dates with end_date >= start_date")

    sites = [Site(s["name"], s["timezone"], list(s.get("rooms", []))) for s in raw.get("sites", [])]
    for site in sites:
        ZoneInfo(site.timezone)  # raises for unknown zones

    repo = repo or os.environ.get("SPRINTWEEK_REPO") or gh.get("repo") or os.environ.get("GITHUB_REPOSITORY")
    if not repo or "/" not in repo:
        raise ValueError("Set [github] repo = 'owner/name' (or $GITHUB_REPOSITORY)")
    owner, name = repo.split("/", 1)

    site_url = raw.get("site", {}).get("url") or f"https://{owner.lower()}.github.io/{name}/"
    if not site_url.endswith("/"):
        site_url += "/"

    return Config(
        title=event.get("title", "Sprint Week"),
        start_date=start,
        end_date=end,
        default_timezone=event.get("default_timezone", "local"),
        sites=sites,
        repo=repo,
        exclude_labels=[s.lower() for s in gh.get("exclude_labels", [])],
        greet_new_issues=bool(gh.get("greet_new_issues", True)),
        auto_label=bool(gh.get("auto_label", True)),
        scheduler_url=sched.get("url", "").rstrip("/"),
        bot_login=sched.get("bot_login", ""),
        org=sched.get("org", ""),
        site_url=site_url,
        type_colors=dict(raw.get("types", {})),
    )
