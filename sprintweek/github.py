"""A minimal GitHub REST client (standard library only) and repository snapshots."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.github.com"


def find_token() -> str | None:
    """Return a GitHub token from ``$GITHUB_TOKEN``/``$GH_TOKEN`` or the ``gh`` CLI, if any."""
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        return token
    try:
        out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=10)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


class GitHub:
    """Tiny wrapper around the GitHub REST API.

    Parameters
    ----------
    token : str, optional
        Access token. Public repositories can be read without one, at a lower rate limit.
    """

    def __init__(self, token: str | None = None):
        self.token = token

    def request(self, method: str, path: str, data: dict | None = None, params: dict | None = None):
        """Send one request and return ``(decoded JSON or None, response headers)``."""
        url = path if path.startswith("https://") else API + path
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "desc-sprintweek-calendar",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        body = None
        if data is not None:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return (json.loads(raw) if raw else None), resp.headers
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:500]
            raise RuntimeError(f"GitHub API {method} {path} failed: {err.code} {detail}") from None

    def paginate(self, path: str, params: dict | None = None) -> list:
        """GET every page of a list endpoint."""
        items, url, params = [], path, {"per_page": 100, **(params or {})}
        while url:
            page, headers = self.request("GET", url, params=params)
            items.extend(page)
            m = re.search(r'<([^>]+)>;\s*rel="next"', headers.get("Link") or "")
            url, params = (m.group(1) if m else None), None
        return items


def _slim_issue(issue: dict) -> dict:
    return {
        "number": issue["number"],
        "title": issue["title"],
        "body": issue.get("body") or "",
        "html_url": issue["html_url"],
        "state": issue["state"],
        "state_reason": issue.get("state_reason"),
        "user": issue["user"]["login"],
        "assignees": [a["login"] for a in issue.get("assignees") or []],
        "labels": [
            {"name": lb["name"], "color": lb.get("color", ""), "description": lb.get("description") or ""}
            for lb in issue.get("labels", [])
        ],
        "created_at": issue["created_at"],
        "updated_at": issue["updated_at"],
        "is_pull_request": "pull_request" in issue,
    }


def _slim_comment(comment: dict) -> dict:
    return {
        "id": comment["id"],
        "issue": int(comment["issue_url"].rsplit("/", 1)[1]),
        "user": comment["user"]["login"],
        "author_association": comment.get("author_association", "NONE"),
        "body": comment.get("body") or "",
        "html_url": comment["html_url"],
        "created_at": comment["created_at"],
        "updated_at": comment["updated_at"],
    }


def fetch_snapshot(gh: GitHub, repo: str) -> dict:
    """Download every issue and issue comment of a repository.

    Parameters
    ----------
    gh : GitHub
        API client.
    repo : str
        ``owner/name``.

    Returns
    -------
    dict
        ``{"repo", "fetched_at", "issues", "comments"}`` with trimmed-down objects.
        Test fixtures use the same format.
    """
    issues = gh.paginate(f"/repos/{repo}/issues", {"state": "all"})
    comments = gh.paginate(f"/repos/{repo}/issues/comments", {"sort": "created", "direction": "asc"})
    return {
        "repo": repo,
        "fetched_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "issues": [_slim_issue(i) for i in issues],
        "comments": [_slim_comment(c) for c in comments],
    }
