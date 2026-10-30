# Notes for Claude

## Commands

- Python env: `.venv/` (git-ignored) has PyYAML; use `.venv/bin/python` (Homebrew Python refuses global pip installs).
- Tests: `.venv/bin/python -m unittest discover -s tests -t .`; Worker tests: `cd worker && npm test`.
- Offline build: `.venv/bin/python -m sprintweek build --snapshot demo/snapshot.json --out _site`, then `python3 -m http.server -d _site 8765`.
- Regenerate the demo snapshot after editing `demo/sprints.yaml` or the session comment format: `.venv/bin/python demo/seed.py snapshot demo/snapshot.json`.
- Format Python with `black` (line length 120, configured in `pyproject.toml`).

## Conventions

- Python is standard library plus PyYAML; NumPy-style docstrings.
- YAML is read with `yaml.BaseLoader` (everything stays text; `config.py` validates and converts). Never switch to `safe_load`: unquoted `10:30` would become 630.
- The frontend has no build step: ES modules in `site/assets/`, vendored libraries in `site/vendor/` (versions in `site/vendor/VERSIONS.md`).
- Never insert issue content with `innerHTML` except through `markdown()` in `site/assets/common.js` (DOMPurify).
- `site/index.html` and `site/present.html` have a Content-Security-Policy meta tag whose `sha256-…` allows the inline theme script; recompute it (base64 SHA-256 of the script text) whenever that script changes.
- Markdown files: one sentence per line.

## Contracts to keep in sync

- The session comment format (`<!-- sprintweek:session {json} -->`) is written by `sprintweek/sessions.py` and by the scheduling bot (`worker/`), and read by `sprintweek/build.py`.
- Issue form headings in `.github/ISSUE_TEMPLATE/sprint.yml` must stay recognizable by `FIELDS` in `sprintweek/parse.py`.
- Sprint types in the form must match `types` in `sprintweek.yaml`.
- Room availability rules exist twice: `sprintweek/rooms.py` (`room_problem`) and `worker/src/lib.js` (`roomProblem`); a test in each checks the same message.
- `pyproject.toml` and `worker/wrangler.toml` stay TOML because their tools require it.

## Cautions

- `LSSTDESC/SprintWeek2026` is a read-only reference: never modify it.
- Never link to other repositories' issues or PRs, or @mention people, from content posted to GitHub: it notifies them or adds backlinks to their timelines (`demo/seed.py` defangs both).
- Headless Chrome on macOS will not go below a 500 px viewport; render phone layouts inside a 375 px `<iframe>` instead.
