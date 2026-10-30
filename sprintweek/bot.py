"""Housekeeping run by GitHub Actions on new or edited sprint issues.

* Posts (or updates) one welcome comment with links to the calendar and the scheduler.
* Adds the repository labels matching the sprint type and working groups chosen in the form.
"""

from __future__ import annotations

from .build import _is_excluded
from .config import Config
from .github import GitHub
from .parse import parse_issue_body

GREETING_MARKER = "<!-- sprintweek:greeting -->"


def greeting(number: int, config: Config) -> str:
    """Return the welcome comment for sprint issue ``number``."""
    lines = [
        GREETING_MARKER,
        "👋 Thanks for proposing a sprint! It is now listed on the "
        f"**[{config.title} calendar]({config.site_url}#sprint/{number})**.",
        "",
    ]
    if config.scheduler_url:
        lines.append(
            f"📅 **[Schedule a session]({config.scheduler_url}/schedule?sprint={number})**: "
            "pick a day, time and room. "
            "Add as many sessions as you need. Each appears below as a comment with a link to edit or cancel it."
        )
    else:
        lines.append("📅 **Sessions:** the organizers will add your sessions here once you know when you will meet.")
    lines += [
        "",
        "📝 **After the sprint**, add a wrap-up for the closing plenary: edit this issue and fill in the *Wrap-up* "
        "section, or post a comment that starts with `## Wrap-up`.",
        "",
        "<sub>Edit the issue at any time to update the description; the calendar refreshes within a few minutes.</sub>",
    ]
    return "\n".join(lines)


def triage(gh: GitHub, config: Config, number: int, greet: bool) -> list[str]:
    """Label a sprint issue and optionally post or refresh its welcome comment.

    Parameters
    ----------
    gh : GitHub
        Client authenticated with permission to write issues.
    config : Config
        Event configuration.
    number : int
        Issue number.
    greet : bool
        Post the welcome comment, or update it if it already exists.

    Returns
    -------
    list of str
        Human-readable log of what was done.
    """
    repo, log = config.repo, []
    issue, _ = gh.request("GET", f"/repos/{repo}/issues/{number}")
    slim = {
        "is_pull_request": "pull_request" in issue,
        "state_reason": issue.get("state_reason"),
        "labels": issue["labels"],
    }
    if _is_excluded(slim, config):
        return [f"#{number}: not a sprint, skipped"]

    if config.auto_label:
        fields = parse_issue_body(issue.get("body") or "", issue["title"])
        wanted = [fields["type"], *fields["working_groups"]]
        if any("new contributor" in o.lower() for o in fields["options"]):
            wanted.append("New Contributor Friendly")
        existing = {lb["name"].lower(): lb["name"] for lb in gh.paginate(f"/repos/{repo}/labels")}
        current = {lb["name"].lower() for lb in issue["labels"]}
        add = sorted({existing[w.lower()] for w in wanted if w and w.lower() in existing and w.lower() not in current})
        if add:
            gh.request("POST", f"/repos/{repo}/issues/{number}/labels", {"labels": add})
            log.append(f"#{number}: added labels {', '.join(add)}")

    if greet and config.greet_new_issues:
        body = greeting(number, config)
        comments = gh.paginate(f"/repos/{repo}/issues/{number}/comments")
        mine = [c for c in comments if GREETING_MARKER in (c.get("body") or "") and c["user"]["type"] == "Bot"]
        if not mine:
            gh.request("POST", f"/repos/{repo}/issues/{number}/comments", {"body": body})
            log.append(f"#{number}: posted welcome comment")
        elif mine[0]["body"].strip() != body.strip():
            gh.request("PATCH", f"/repos/{repo}/issues/comments/{mine[0]['id']}", {"body": body})
            log.append(f"#{number}: updated welcome comment")
    return log
