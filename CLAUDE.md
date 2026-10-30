# Notes for Claude

## Commands

- Tests: `python3 -m unittest discover -s tests -t .`
- Offline build: `python3 -m sprintweek build --snapshot demo/snapshot.json --out _site`, then `python3 -m http.server -d _site 8765`.
- Regenerate the demo snapshot after editing `demo/sprints.toml` or the session comment format: `python3 demo/seed.py snapshot demo/snapshot.json`.
- Format Python with `black` (line length 120, configured in `pyproject.toml`).

## Conventions

- Python is standard library only; NumPy-style docstrings.
- The frontend has no build step: ES modules in `site/assets/`, vendored libraries in `site/vendor/` (versions in `site/vendor/VERSIONS.md`).
- Never insert issue content with `innerHTML` except through `markdown()` in `site/assets/common.js` (DOMPurify).
- Markdown files: one sentence per line.

## Contracts to keep in sync

- The session comment format (`<!-- sprintweek:session {json} -->`) is written by `sprintweek/sessions.py` and by the scheduling bot (`worker/`), and read by `sprintweek/build.py`.
- Issue form headings in `.github/ISSUE_TEMPLATE/sprint.yml` must stay recognizable by `FIELDS` in `sprintweek/parse.py`.
- Sprint types in the form must match `[types]` in `sprintweek.toml`.

## Cautions

- `LSSTDESC/SprintWeek2026` is a read-only reference: never modify it.
- Never link to other repositories' issues or PRs, or @mention people, from content posted to GitHub: it notifies them or adds backlinks to their timelines (`demo/seed.py` defangs both).
- Headless Chrome on macOS will not go below a 500 px viewport; render phone layouts inside a 375 px `<iframe>` instead.
