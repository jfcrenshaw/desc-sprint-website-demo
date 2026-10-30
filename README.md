# DESC Sprint Week calendar

A lightweight Sprint Week website where **GitHub Issues are the single source of truth**.
Each sprint is one GitHub issue.
Each scheduled session is one comment on that issue, posted by a scheduling bot from a simple web form.
A GitHub Action turns the issues into a static calendar on GitHub Pages, with daily and weekly views, a sprint directory, pitch and wrap-up slides, and calendar subscriptions.

**Demo:** <https://jfcrenshaw.github.io/desc-sprint-website-demo/> (built from the [issues of this repository](https://github.com/jfcrenshaw/desc-sprint-website-demo/issues), which copy real SprintWeek2026 sprints).

There is no database and no new account for participants.
The calendar runs entirely on free GitHub features; the optional scheduling bot is a small, stateless Cloudflare Worker on the free plan.

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

A sprint can have any number of sessions.
Each appears on the calendar on its own and links back to the same issue.

1. Click **📅 Schedule a session**: it is in the bot's welcome comment on your issue, and on the sprint's page on the website.
2. Sign in with GitHub, then pick the day, start and end time, the site (or *Online only*) and optionally a room, a Zoom link, a session name and a note.
   The form shows the time at the other sites as you type, and what is already booked in the room you picked that day (rooms can be shared, so this is for information).
3. Click **Schedule session**.
   The bot posts the session as a comment on the issue, and the calendar shows it a minute or two later.

To **move** or **cancel** a session, click **✏️ Edit or cancel this session** in its comment (or *Edit or cancel* on the website).
Cancelled sessions stay on the issue, struck through, but disappear from the calendar.

The sprint's author, assignees, contacts @mentioned in the issue and repository collaborators can schedule and edit its sessions.
Organization members can also add sessions.
See [worker/README.md](worker/README.md) for how the bot works and how to set it up.

<details>
<summary>Under the hood, and the manual fallback for organizers</summary>

Each session comment starts with a hidden data line, for example:

```text
<!-- sprintweek:session {"v":1,"date":"2026-10-27","start":"14:00","end":"16:00","tz":"Europe/Paris","site":"Paris","location":"Salle 3","online":"https://zoom.us/j/123","label":"Kickoff","note":"","by":"alice"} -->
```

followed by a human-readable summary.
Times are written in the session's own time zone (an IANA name such as `America/Los_Angeles`), and the website converts them for every viewer.

The build only accepts session comments written by the bot (`bot_login` in `sprintweek.yaml`) or by people with write access to the repository (or members of the organization that owns it), so nobody else can put events on the calendar.
Organizers can therefore also add a session by hand, by copying an existing session comment and editing its data line, or fix one by editing the line.
Changing `sprintweek:session` to `sprintweek:cancelled` cancels a session.
Malformed entries are skipped and reported as warnings in the build log; they never break the site.

</details>

### Add a wrap-up

Post a comment on the sprint's issue that starts with a `## Wrap-up` heading and, on the next line, the date of the plenary it is for:

```markdown
## Wrap-up
date: 2026-10-30

What we did, with plots and links...
```

The bot's welcome comment on every sprint shows this template in a highlighted box (GitHub adds a copy button to it).
Leaving `date: YYYY-MM-DD` as it is, or leaving the date out, means the day you post it.

- Post as many wrap-ups as you like, even several for the same day: each is shown separately on the sprint's page and becomes its own slide in the wrap-up presentation for its date.
- Small slips are understood: any heading level (`#`, `###`), bold, "Wrap up" or "Wrapup", a missing `#`, `Date - Thursday`, and dates such as `Thursday`, `Oct 29`, `29 October` or `10/29` (numeric dates are read whichever way falls in the Sprint Week).
- A date that still cannot be read, or that is not during the Sprint Week, files the wrap-up under the day it was posted and shows a ⚠️ note on the sprint's page (and a warning in the build log).
  Edit the comment to fix it.
- Wrap-ups are accepted from the sprint's author, assignees and listed contacts, and from repository collaborators (or members of the organization that owns the repository).
  You can edit your comment at any time; the website updates a minute later.

### Follow the schedule

- **Today** shows today's sessions plus *Happening now* and *Up next*.
- The organizers' program is on the calendar too: plenaries and socials as grey and amber entries, coffee and meals as shaded bands behind the sessions (in the time of the site they belong to).
- **Week** is an hourly calendar (a list on phones).
- **Scheduled** and **Unscheduled** list the sprints as cards; *Unscheduled* holds proposals still looking for a time (and for collaborators).
- **Rooms** shows one site and day at a time with a column per room: what is booked where, and (striped) when a room is not available. Use it to find a free room before scheduling; on phones it is a list per room.
- **SLAC info** and **Paris info** (one tab per site) have practical information: getting there, access, Wi-Fi, food, contacts, plus each site's rooms and daily program.
- **Times in** switches every time on the page between your own clock, each site's local time and UTC.
- **Filter** narrows everything by sprint type, working group, label, site/online, or "new contributor friendly".
- The **☀/☾ switch** (top right, and on the Present page) toggles light and dark mode; until you use it, the site follows your device's setting.
- **Subscribe** adds the whole schedule to Google Calendar, Apple Calendar or Outlook, and it stays up to date.
  Each sprint page also has an *Add to my calendar* button for just that sprint.

### Present pitches and wrap-ups

**Present** (top right) builds slides straight from the issues: one per sprint.
For *morning pitches* choose a day: you get an agenda slide and then a slide per sprint meeting that day (pitch, contacts, goals, sessions in every site's time).
Not-yet-scheduled sprints can be appended.
For *wrap-ups* choose a day: you get one slide per wrap-up dated that day, grouped by sprint (in the order their first wrap-up was posted), each showing who wrote it and when.
Use the arrow keys, space or a clicker to move; `F` toggles full screen.
Nobody needs to make Google Slides.

## How it works

```text
GitHub issue (sprint) ──┐
  + session comments    │  issue / comment events     GitHub Action           GitHub Pages
  + wrap-up             ├────────────────────────────▶ python -m sprintweek ───▶ static site
issue labels ───────────┘                              build                    data/sprints.json
          ▲                                                                     calendar.ics
          │ posts session comments
  scheduling bot (Cloudflare Worker + GitHub App) ◀── "Schedule a session" form
```

1. **Issue form** ([.github/ISSUE_TEMPLATE/sprint.yml](.github/ISSUE_TEMPLATE/sprint.yml)) collects the sprint description with `### Heading` sections that are easy to edit by hand and easy to parse.
2. **Session comments** hold one session each, as JSON in a hidden HTML comment ([sprintweek/sessions.py](sprintweek/sessions.py)).
   A structured, machine-written record avoids parsing free-text dates such as "28/10" or "Tue 9a Pacific".
   It also means each session has its own URL and edit history.
3. **[Build workflow](.github/workflows/site.yml)** runs on every issue or relevant comment change, on pushes, and on demand.
   It downloads *all* issues and comments, so the site is always a fresh copy of GitHub and there is no state to drift.
   Bursts of edits collapse into one queued build.
4. **[Scheduling bot](worker/)** (a Cloudflare Worker plus a GitHub App) serves the session form and posts the session comments on behalf of signed-in sprint members.
   The build workflow also posts (and later resolves) the automatic room-change notices.
5. **[Triage workflow](.github/workflows/triage.yml)** posts a welcome comment on new sprint issues and adds the labels matching the type and working groups chosen in the form (only labels that already exist).
6. **Python package** [`sprintweek/`](sprintweek/) (standard library plus PyYAML) parses the issues and writes `data/sprints.json`, the `.ics` feeds and the static files.
7. **Frontend** [`site/`](site/) is plain HTML, CSS and JavaScript modules with three small vendored libraries: [EventCalendar](https://github.com/vkurko/calendar) (calendar views, MIT), [marked](https://github.com/markedjs/marked) (Markdown) and [DOMPurify](https://github.com/cure53/DOMPurify) (sanitizing).
   There is no build step.

### Time zones

Each session stores its wall-clock time and IANA time zone, and the build converts it to UTC with Python's `zoneinfo`, so daylight saving is always right.
For example, Paris switched to CET on 2026-10-25 while SLAC stayed on PDT until 2026-11-01.
The browser converts UTC to whatever zone the viewer picks.
Calendar feeds use UTC.

### Organizers' program (coffee, meals, plenaries)

The fixed schedule set by the organizers lives in [sprintweek.yaml](sprintweek.yaml), under each site, rather than in issues: it is not proposed or discussed, it often repeats every day, and only people with write access to the repository should change it.

```yaml
sites:
  - name: SLAC
    timezone: America/Los_Angeles
    program:
      - { title: Coffee, kind: break, days: all, start: 10:30, end: 11:00 }
      - title: Welcome reception
        kind: social                  # break | meal | plenary | social
        days: [2026-10-26]            # or: all
        start: 17:00
        end: 19:00
        location: Redwood lobby
        online: https://zoom.us/j/... # optional
        note: Drinks and snacks       # optional
```

Times are in the site's time zone.
Edit the file on GitHub (pencil icon) and commit; the calendar updates a minute later.

- **Breaks and meals** are drawn as shaded bands behind the sprint sessions, and only when viewing that site's time zone (or filtering by that site), so Paris coffee does not clutter the SLAC calendar.
- **Plenaries** are normal calendar entries shown to everyone, and **socials** are shown at their site (or to everyone if they have an online link).
  Both are included in the calendar feed.
- A mistake (an impossible time, a misspelled `kind`, an unquoted color) stops the build with a message naming the setting; the website keeps showing the previous version until it is fixed.

### Rooms and their availability

Each site lists its rooms in [sprintweek.yaml](sprintweek.yaml).
A plain name is available all week; a room can also be limited to some days and hours:

```yaml
    rooms:
      - Redwoods C-D               # all week
      - name: Redwood A
        available:
          - days: [Mon, Wed]       # weekday names or dates (2026-10-28)
          - days: [Tue]
            start: 13:00           # only these hours; leave out for the whole day
            end: 17:00
```

- The scheduling form only suggests rooms open on the chosen day (with their hours), warns as soon as someone picks a room outside its availability, and the bot refuses to save such a session.
  People can still type a room that is not in the list ("Alice's office"); only listed rooms are checked.
- **Changing availability after people have scheduled** never moves or deletes anyone's session.
  Instead, sessions now outside their room's availability are listed as warnings in the build, flagged on the website, and the sprint issue gets one automatic comment asking the team to pick another room, with an edit link.
  When the session is moved or cancelled (or the room's availability or name changes so it is no longer flagged), that comment is struck through and marked resolved.
- Renaming a room in the config leaves older sessions with the old name, which then counts as a typed-in room and is not checked.

### Site info pages

Each site can have a Markdown page, shown as a "<site> info" tab:

```yaml
sites:
  - name: SLAC
    info: site-info/slac.md
```

Write anything there (access, Wi-Fi, food, contacts, maps); edit it on GitHub and the website updates a minute later.
Keep the page in a folder such as `site-info/`: images and files next to it are published too and can be linked with relative paths (`![map](slac-map.png)`).
Below the text, the website adds the site's local time, its rooms with their availability, and its daily program, all from `sprintweek.yaml`.
The website is public, so do not put Wi-Fi passwords or door codes there.

### What counts as a sprint

Every issue in the repository except pull requests, issues closed as *not planned*, and issues with one of the `exclude_labels` in [sprintweek.yaml](sprintweek.yaml) (by default `duplicate`, `invalid`, `wontfix`, `not a sprint`).
Older free-form issues (like the SprintWeek2026 template with `Contacts:` and `Day/Time:` lines) are understood on a best-effort basis: they appear as unscheduled, with their `Day/Time` text shown as a note.

## Setting up a new Sprint Week

1. **Create the repository** for the new Sprint Week by copying this one (or use *Use this template*).
   It must be public for free GitHub Pages.
2. **Edit [sprintweek.yaml](sprintweek.yaml):** title, dates, sites with their time zones, rooms and [program](#organizers-program-coffee-meals-plenaries), the repository name, and sprint-type colors.
3. **Edit the dropdowns** in [.github/ISSUE_TEMPLATE/sprint.yml](.github/ISSUE_TEMPLATE/sprint.yml) if the working groups or sprint types change.
   Sprint types must match the `types` section of `sprintweek.yaml`.
4. **Create labels** for the working groups and sprint types if you want them added automatically (*Issues → Labels*).
5. **Enable GitHub Pages:** *Settings → Pages → Build and deployment → Source: GitHub Actions*.
6. **Enable Actions** if needed: *Settings → Actions → General → Allow all actions*.
   Under *Workflow permissions*, the default read-only token is fine, because the workflows request what they need.
7. **Run the build once:** *Actions → Build calendar → Run workflow* (pushing to `main` also triggers it).
   The site appears at `https://<owner>.github.io/<repository>/`.
8. Update the calendar link in [.github/ISSUE_TEMPLATE/config.yml](.github/ISSUE_TEMPLATE/config.yml).
9. **Set up the scheduling bot** by following [worker/README.md](worker/README.md) (about 30 minutes).
   Without it, organizers add sessions by hand as described above.
10. Delete the demo issues, or start from an empty repository.

To refresh the welcome comments on existing issues (for example after changing the scheduler URL), run *Actions → Welcome new sprints → Run workflow*.

## Local development

Requires Python ≥ 3.11 and PyYAML (`pip install pyyaml`, already present in most DESC environments).

```sh
python -m unittest discover -s tests -t .                       # run the tests
python -m sprintweek build --snapshot demo/snapshot.json         # build _site/ from the offline demo data
python -m sprintweek build                                       # build _site/ from the live issues
python -m http.server -d _site 8000                              # preview at http://localhost:8000
```

`python -m sprintweek build` uses `$GITHUB_TOKEN`, or the token of the [GitHub CLI](https://cli.github.com/) if you are logged in.
Public repositories also work without a token, at a lower rate limit.
`--save-snapshot file.json` saves the downloaded issues for offline work.

The demo content lives in [demo/sprints.yaml](demo/sprints.yaml).
`python demo/seed.py snapshot demo/snapshot.json` regenerates the offline snapshot used by the tests.
`python demo/seed.py create` creates the demo issues in the configured repository.
It disables @mentions and links to other repositories' issues, so seeding never notifies anyone.

Repository layout:

| Path | What it is |
| --- | --- |
| `sprintweek.yaml` | Per-event configuration and organizers' program |
| `sprintweek/` | Build script: GitHub API client, parsers, `.ics` writer, triage bot |
| `site/` | Static frontend: `index.html` (calendar), `present.html` (slides), `assets/`, `vendor/` |
| `tests/` | Unit tests (`unittest`, no dependencies) |
| `worker/` | Scheduling bot (Cloudflare Worker) |
| `site-info/` | Markdown info pages for each site |
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
