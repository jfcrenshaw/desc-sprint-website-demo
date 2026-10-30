# DESC Sprint Week calendar

A lightweight Sprint Week website where **GitHub Issues are the single source of truth**.
Each sprint is one GitHub issue.
Each scheduled session is one comment on that issue.
A GitHub Action turns the issues into a static calendar on GitHub Pages, with daily and weekly views, a sprint directory, pitch and wrap-up slides, and calendar subscriptions.

**Demo:** <https://jfcrenshaw.github.io/desc-sprint-website-demo/> (built from the [issues of this repository](https://github.com/jfcrenshaw/desc-sprint-website-demo/issues), which copy real SprintWeek2026 sprints).

There is no database, no server to maintain and no new account for participants.
Everything runs on free GitHub features.

- [For participants](#for-participants)
- [How it works](#how-it-works)
- [Setting up a new Sprint Week](#setting-up-a-new-sprint-week)
- [Local development](#local-development)
- [Security notes](#security-notes)

## For participants

### Propose a sprint

Click **＋ Propose a sprint** on the website (or *New issue → Propose a sprint* on GitHub) and fill in the form.
Only the title and a short pitch are required.
You do **not** need to know when you will meet: proposals without sessions are listed on the website under *Not yet scheduled*, where people can find them and join.

The form asks for contacts, sprint type, working groups, goals, prerequisites, links and a longer description.
Everything can be changed later by editing the issue (the "…" menu → *Edit*).
The website updates within a few minutes.

### Schedule, move or cancel a session

A sprint can have any number of sessions, and each appears on the calendar on its own while linking back to the same issue.
Each session is a comment on the sprint issue that starts with a hidden data line, for example:

```text
<!-- sprintweek:session {"v":1,"date":"2026-10-27","start":"14:00","end":"16:00","tz":"Europe/Paris","site":"Paris","location":"Salle 3","online":"https://zoom.us/j/123","label":"Kickoff","note":"","by":"alice"} -->
```

followed by a human-readable summary ("📅 Session scheduled · Tuesday, October 27 · 14:00–16:00 CET …").
Times are written in the session's own time zone (an IANA name such as `America/Los_Angeles`), and the website converts them for every viewer.

- **Add a session:** post a new session comment.
- **Move a session:** edit the comment and change the date, times or room.
- **Cancel a session:** delete the comment, or change `sprintweek:session` to `sprintweek:cancelled` to keep a visible record.

Session comments are only accepted from the scheduling bot and from people with write access to the repository (or members of the organization that owns it), so a stranger cannot put events on the calendar.
Malformed entries are skipped and reported as warnings in the Action log; they never break the site.

> **Coming next:** a scheduling bot.
> New sprint issues will get a "📅 Schedule a session" link that opens a small form (day, time, room, Zoom link).
> The bot then posts the session comment for you, with an "Edit or cancel" link.
> Until it is enabled, organizers post session comments.

### Add a wrap-up

After the sprint, either:

- edit the issue and fill in the **Wrap-up** section of the form, or
- post a comment that starts with a `## Wrap-up` heading.

Bullet points, links and plots are all welcome.
Wrap-ups are shown on the sprint's page and in the wrap-up slides.
Comment wrap-ups are accepted from the sprint's author, assignees and listed contacts, and from repository collaborators.

### Follow the schedule

- **Today** shows today's sessions plus *Happening now* and *Up next*.
- **Week** is an hourly calendar (a list on phones).
- **All sprints** is a directory, with unscheduled proposals first.
- **Times in** switches every time on the page between your own clock, each site's local time and UTC.
- **Filter** narrows everything by sprint type, working group, label, site/online, or "new contributor friendly".
- **Subscribe** adds the whole schedule to Google Calendar, Apple Calendar or Outlook, and it stays up to date.
  Each sprint page also has an *Add to my calendar* button for just that sprint.

### Present pitches and wrap-ups

**Present** (top right) builds slides straight from the issues: one per sprint.
For *morning pitches* choose a day: you get an agenda slide and then a slide per sprint meeting that day (pitch, contacts, goals, sessions in every site's time).
Not-yet-scheduled sprints can be appended.
For *wrap-ups* you get one slide per sprint with a wrap-up.
Use the arrow keys, space or a clicker to move; `F` toggles full screen.
Nobody needs to make Google Slides.

## How it works

```text
GitHub issue (sprint) ──┐
  + session comments    │  issue / comment events     GitHub Action           GitHub Pages
  + wrap-up             ├────────────────────────────▶ python -m sprintweek ───▶ static site
issue labels ───────────┘                              build                    data/sprints.json
                                                                                calendar.ics
```

1. **Issue form** ([.github/ISSUE_TEMPLATE/sprint.yml](.github/ISSUE_TEMPLATE/sprint.yml)) collects the sprint description with `### Heading` sections that are easy to edit by hand and easy to parse.
2. **Session comments** hold one session each, as JSON in a hidden HTML comment ([sprintweek/sessions.py](sprintweek/sessions.py)).
   A structured, machine-written record avoids parsing free-text dates such as "28/10" or "Tue 9a Pacific".
   It also means each session has its own URL and edit history.
3. **[Build workflow](.github/workflows/site.yml)** runs on every issue or relevant comment change, on pushes, and on demand.
   It downloads *all* issues and comments, so the site is always a fresh copy of GitHub and there is no state to drift.
   Bursts of edits collapse into one queued build.
4. **[Triage workflow](.github/workflows/triage.yml)** posts a welcome comment on new sprint issues and adds the labels matching the type and working groups chosen in the form (only labels that already exist).
5. **Python package** [`sprintweek/`](sprintweek/) (standard library only) parses the issues and writes `data/sprints.json`, the `.ics` feeds and the static files.
6. **Frontend** [`site/`](site/) is plain HTML, CSS and JavaScript modules with three small vendored libraries: [EventCalendar](https://github.com/vkurko/calendar) (calendar views, MIT), [marked](https://github.com/markedjs/marked) (Markdown) and [DOMPurify](https://github.com/cure53/DOMPurify) (sanitizing).
   There is no build step.

### Time zones

Each session stores its wall-clock time and IANA time zone, and the build converts it to UTC with Python's `zoneinfo`, so daylight saving is always right.
For example, Paris switched to CET on 2026-10-25 while SLAC stayed on PDT until 2026-11-01.
The browser converts UTC to whatever zone the viewer picks.
Calendar feeds use UTC.

### What counts as a sprint

Every issue in the repository except pull requests, issues closed as *not planned*, and issues with one of the `exclude_labels` in [sprintweek.toml](sprintweek.toml) (by default `duplicate`, `invalid`, `wontfix`, `not a sprint`).
Older free-form issues (like the SprintWeek2026 template with `Contacts:` and `Day/Time:` lines) are understood on a best-effort basis: they appear as unscheduled, with their `Day/Time` text shown as a note.

## Setting up a new Sprint Week

1. **Create the repository** for the new Sprint Week by copying this one (or use *Use this template*).
   It must be public for free GitHub Pages.
2. **Edit [sprintweek.toml](sprintweek.toml):** title, dates, sites with time zones and rooms, the repository name, and sprint-type colors.
3. **Edit the dropdowns** in [.github/ISSUE_TEMPLATE/sprint.yml](.github/ISSUE_TEMPLATE/sprint.yml) if the working groups or sprint types change.
   Sprint types must match the `[types]` table in `sprintweek.toml`.
4. **Create labels** for the working groups and sprint types if you want them added automatically (*Issues → Labels*).
5. **Enable GitHub Pages:** *Settings → Pages → Build and deployment → Source: GitHub Actions*.
6. **Enable Actions** if needed: *Settings → Actions → General → Allow all actions*.
   Under *Workflow permissions*, the default read-only token is fine, because the workflows request what they need.
7. **Run the build once:** *Actions → Build calendar → Run workflow* (pushing to `main` also triggers it).
   The site appears at `https://<owner>.github.io/<repository>/`.
8. Update the calendar link in [.github/ISSUE_TEMPLATE/config.yml](.github/ISSUE_TEMPLATE/config.yml).
9. Delete the demo issues, or start from an empty repository.

To refresh the welcome comments on existing issues (for example after changing the scheduler URL), run *Actions → Welcome new sprints → Run workflow*.

## Local development

Requires Python ≥ 3.11 and nothing else.

```sh
python -m unittest discover -s tests -t .                       # run the tests
python -m sprintweek build --snapshot demo/snapshot.json         # build _site/ from the offline demo data
python -m sprintweek build                                       # build _site/ from the live issues
python -m http.server -d _site 8000                              # preview at http://localhost:8000
```

`python -m sprintweek build` uses `$GITHUB_TOKEN`, or the token of the [GitHub CLI](https://cli.github.com/) if you are logged in.
Public repositories also work without a token, at a lower rate limit.
`--save-snapshot file.json` saves the downloaded issues for offline work.

The demo content lives in [demo/sprints.toml](demo/sprints.toml).
`python demo/seed.py snapshot demo/snapshot.json` regenerates the offline snapshot used by the tests.
`python demo/seed.py create` creates the demo issues in the configured repository.
It disables @mentions and links to other repositories' issues, so seeding never notifies anyone.

Repository layout:

| Path | What it is |
| --- | --- |
| `sprintweek.toml` | Per-event configuration |
| `sprintweek/` | Build script: GitHub API client, parsers, `.ics` writer, triage bot |
| `site/` | Static frontend: `index.html` (calendar), `present.html` (slides), `assets/`, `vendor/` |
| `tests/` | Unit tests (`unittest`, no dependencies) |
| `demo/` | Demo content and seeding script |
| `.github/` | Issue form and workflows |

## Security notes

- Issue content is user-controlled.
  The frontend never inserts it as raw HTML: plain text goes through `textContent`, and Markdown is rendered by marked and sanitized by DOMPurify (no scripts, styles, iframes or forms).
  Links open with `rel="noopener noreferrer"`.
- Session data is length-limited, and online links must be `https://`.
  Session comments from untrusted accounts are ignored.
- The workflows use the automatic `GITHUB_TOKEN` with minimal permissions.
  No token or secret is ever written to the published site, which only contains `data/sprints.json`, the `.ics` files and static assets.
- The welcome comment and copied demo content avoid @mentions so nobody is pinged unexpectedly.
