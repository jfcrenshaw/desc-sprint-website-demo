"""Command-line interface: ``python -m sprintweek {build,triage} ...``."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .bot import notify_rooms, triage
from .build import build_data, write_site
from .config import ConfigError, load_config
from .github import GitHub, fetch_snapshot, find_token


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m sprintweek", description=__doc__)
    parser.add_argument("--config", help="path to sprintweek.yaml (default: repository root)")
    parser.add_argument("--repo", help="owner/name of the sprint repository (overrides the config)")
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="fetch issues and write the static website")
    b.add_argument("--out", default="_site", help="output directory (default: _site)")
    b.add_argument("--snapshot", help="read issues from this JSON snapshot instead of the GitHub API")
    b.add_argument("--save-snapshot", help="also save the fetched issues to this JSON file")

    sub.add_parser("notify-rooms", help="ask sprint teams to move sessions out of unavailable rooms")

    t = sub.add_parser("triage", help="label sprint issues and post welcome comments")
    which = t.add_mutually_exclusive_group(required=True)
    which.add_argument("--issue", type=int, help="issue number")
    which.add_argument("--all", action="store_true", help="every open issue")
    t.add_argument("--greet", action="store_true", help="post or refresh the welcome comment")

    args = parser.parse_args(argv)
    try:
        config = load_config(args.config, args.repo)
    except ConfigError as err:
        print(f"::error title=sprintweek.yaml::{err}")  # shown as an annotation in GitHub Actions
        return 2

    if args.command == "build":
        if args.snapshot:
            snapshot = json.loads(Path(args.snapshot).read_text(encoding="utf-8"))
        else:
            snapshot = fetch_snapshot(GitHub(find_token()), config.repo)
        if args.save_snapshot:
            Path(args.save_snapshot).write_text(json.dumps(snapshot, ensure_ascii=False, indent=1), encoding="utf-8")
        data = build_data(snapshot, config)
        write_site(data, config, args.out)
        n_sessions = sum(len(s["sessions"]) for s in data["sprints"])
        print(f"Wrote {args.out}/ with {len(data['sprints'])} sprints and {n_sessions} sessions.")
        for w in data["warnings"]:
            print(f"::warning::{w}")  # shown as an annotation in GitHub Actions
        return 0

    gh = GitHub(find_token())
    if args.command == "notify-rooms":
        snapshot = fetch_snapshot(gh, config.repo)
        for line in notify_rooms(gh, config, build_data(snapshot, config), snapshot):
            print(line)
        return 0
    if args.all:
        numbers = [
            i["number"]
            for i in gh.paginate(f"/repos/{config.repo}/issues", {"state": "open"})
            if "pull_request" not in i
        ]
    else:
        numbers = [args.issue]
    for n in numbers:
        for line in triage(gh, config, n, args.greet):
            print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
