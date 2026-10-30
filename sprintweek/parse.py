"""Turn the Markdown body of a sprint issue into named fields.

The sprint issue form (``.github/ISSUE_TEMPLATE/sprint.yml``) produces bodies like::

    ### Short pitch

    One or two sentences.

    ### Contact person(s)

    @someone, Another Person

    ### Wrap-up

    _No response_

Hand-written issues and the older SprintWeek2026 templates (``Contacts:`` lines,
``## Goals and deliverable`` headings) are understood on a best-effort basis.
"""

from __future__ import annotations

import re

# Field name -> accepted headings, compared after `_norm`.
FIELDS = {
    "pitch": ["short pitch", "pitch", "summary", "one sentence description"],
    "contacts": ["contact person", "contact persons", "contacts", "contact"],
    "type": ["sprint type", "type of sprint"],
    "working_groups": ["working groups", "working group", "working groups topical teams", "topics"],
    "goals": ["goals and deliverables", "goals and deliverable", "goals", "deliverables"],
    "prerequisites": [
        "prerequisites",
        "prerequisites and skills",
        "skills needed",
        "resources and skills needed",
    ],
    "links": ["communication channel and links", "links", "communication channel"],
    "details": ["detailed description", "details", "more details"],
    "options": ["options", "accessibility"],
    "wrapup": ["wrap up", "wrapup", "accomplishments", "wrap up accomplishments"],
}
_HEADING_TO_FIELD = {}  # filled below

# "Key: value" lines used by the 2026 Markdown templates.
LEGACY_KEYS = {
    "contacts": "contacts",
    "contact": "contacts",
    "day time": "schedule_note",
    "main communication channel": "links",
    "github repo": "links",
    "github repos": "links",
    "location": "schedule_note",
}

NO_RESPONSE = "_No response_"
HANDLE_RE = re.compile(r"(?<![\w.@/])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\b")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_FENCE_RE = re.compile(r"^\s*(```|~~~)")
_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
_LEGACY_RE = re.compile(r"^\s*[*_]*\s*([A-Za-z][A-Za-z /]{1,40}?)\s*[*_]*\s*:\s*[*_]*\s*(.*)$")
_CHECKBOX_RE = re.compile(r"^\s*[-*]\s*\[([ xX])\]\s*(.+)$")
_WRAPUP_RE = re.compile(r"^\s*(?:#{1,6}\s*|\*\*\s*)(?:\W\s*)?wrap[\s-]?up\b([^\n]*)(?:\n|$)", re.I)
# A wrap-up's date: an ISO date or a weekday name, on the line under the heading or in it.
_DATE_WORD = (
    r"\d{4}-\d{1,2}-\d{1,2}|monday|mon|tuesday|tues|tue|wednesday|weds|wed|"
    r"thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun"
)
_DATE_LINE_RE = re.compile(rf"^[\s*_(\[]*({_DATE_WORD})\.?[\s*_)\]]*$", re.I)
_DATE_IN_HEADING_RE = re.compile(rf"(?<![\w-])({_DATE_WORD})(?![\w-])", re.I)


def _norm(text: str) -> str:
    """Normalize a heading for comparison: lowercase, no parentheses or punctuation."""
    text = re.sub(r"\([^)]*\)", " ", text.lower())
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


for _field, _headings in FIELDS.items():
    for _h in _headings:
        _HEADING_TO_FIELD[_norm(_h)] = _field


def _clean(text: str) -> str:
    """Strip whitespace, form placeholders and template instructions from a field value."""
    lines = [ln for ln in text.strip().splitlines() if not re.fullmatch(r"\s*\[[^\]]*\]\s*", ln)]
    text = "\n".join(lines).strip()
    return "" if text == NO_RESPONSE else text


def split_sections(body: str) -> dict[str, str]:
    """Split an issue body into known fields.

    Parameters
    ----------
    body : str
        Raw Markdown body of the issue.

    Returns
    -------
    dict of str to str
        Keys are field names from `FIELDS` plus ``"preamble"`` (text before the first
        recognized heading). Values are raw Markdown with surrounding whitespace removed.
        Headings that are not recognized stay inside the section that contains them,
        so people can use their own sub-headings freely.
    """
    body = _COMMENT_RE.sub("", (body or "").replace("\r\n", "\n"))
    sections: dict[str, list[str]] = {"preamble": []}
    current = "preamble"
    in_fence = False
    for line in body.split("\n"):
        if _FENCE_RE.match(line):
            in_fence = not in_fence
        elif not in_fence and (m := _HEADING_RE.match(line)):
            field = _HEADING_TO_FIELD.get(_norm(m.group(2)))
            if field and field not in sections:
                current = field
                sections[current] = []
                continue
        sections[current].append(line)
    return {k: "\n".join(v).strip() for k, v in sections.items()}


def _parse_legacy_preamble(preamble: str, title: str) -> dict[str, str]:
    """Extract ``Key: value`` lines and the pitch from an old-style template preamble."""
    found: dict[str, list[str]] = {}
    rest: list[str] = []
    key = None
    for line in preamble.split("\n"):
        m = _LEGACY_RE.match(line)
        target = LEGACY_KEYS.get(_norm(m.group(1))) if m else None
        if target:
            key = target
            value = m.group(2).strip()
            label = m.group(1).strip()
            if value:
                prefix = f"{label}: " if target in ("links", "schedule_note") else ""
                found.setdefault(target, []).append(prefix + value)
            continue
        if key and line.strip().startswith(("-", "*")):
            found.setdefault(key, []).append(line.strip())  # continuation bullet under "Day/Time:"
            continue
        key = None
        h = _HEADING_RE.match(line)
        if h and (h.group(2).strip("[] ").lower() == title.strip().lower() or len(h.group(1)) == 1):
            continue  # "# [Your Sprint Title]" repeated at the top of the body
        rest.append(line)
    out = {k: "\n".join(v).strip() for k, v in found.items()}
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", "\n".join(rest)) if p.strip()]
    if paragraphs:
        out["pitch"] = paragraphs[0]
        if len(paragraphs) > 1:
            out["intro_rest"] = "\n\n".join(paragraphs[1:])
    return out


def parse_list(value: str) -> list[str]:
    """Split a dropdown value such as ``"PZ (Photometric redshifts), CL (Clusters)"``.

    Parenthetical explanations are dropped so the values match the repository labels.
    """
    items = []
    for part in re.split(r"[,\n]", value or ""):
        part = re.sub(r"\([^)]*\)", "", part).strip(" -*\t")
        if part and part != NO_RESPONSE and part.lower() != "none":
            items.append(part)
    return items


def parse_checkboxes(value: str) -> list[str]:
    """Return the labels of ticked ``- [x] label`` checkboxes."""
    return [
        m.group(2).strip() for ln in (value or "").splitlines() if (m := _CHECKBOX_RE.match(ln)) and m.group(1) in "xX"
    ]


def parse_contacts(text: str) -> list[dict]:
    """Parse a free-form contacts field.

    Parameters
    ----------
    text : str
        For example ``"@alice, Bob Smith (@bsmith); Carol Jones"``.

    Returns
    -------
    list of dict
        One ``{"login": str or None, "name": str or None}`` per person, in order.
    """
    people = []
    text = (text or "").replace("`", "")
    for chunk in re.split(r"[,;\n]|\s+and\s+|\s+&\s+", text):
        chunk = re.sub(r"^\s*[-*]\s+", "", chunk).strip()
        handles = HANDLE_RE.findall(chunk)
        name = HANDLE_RE.sub("", chunk)
        name = re.sub(r"\([^)]*\)", "", name)  # "(find me on Slack)", "(@handle)"
        name = re.sub(r"\S+@\S+", "", name)  # e-mail addresses
        name = " ".join(re.sub(r"[*_\[\]()]", "", name).split()) or None
        if name and len(handles) <= 1:
            people.append({"login": handles[0] if handles else None, "name": name})
        else:
            people.extend({"login": h, "name": None} for h in handles)
    return people


def parse_wrapup_comment(body: str) -> dict | None:
    """Parse a comment that starts with a "Wrap-up" heading.

    The website's "Add a wrap-up" template is::

        ## Wrap-up
        2026-10-30

        What we did...

    Parameters
    ----------
    body : str
        Comment body. Accepted openings include ``## Wrap-up``, ``# 📝 Wrap up`` and
        ``**Wrap-up**``. The date may be on the first line under the heading or in the
        heading itself (``## Wrap-up: Thursday``), as an ISO date or a weekday name.

    Returns
    -------
    dict or None
        ``{"date_hint": str or None, "text": str}``, where ``text`` excludes the date
        line; None if the comment is not a wrap-up or has nothing written yet.
    """
    body = (body or "").replace("\r\n", "\n")
    m = _WRAPUP_RE.match(body)
    if not m:
        return None
    rest = body[m.end() :].strip()
    first, _, remainder = rest.partition("\n")
    hint = None
    if dm := _DATE_LINE_RE.match(first.strip()):
        hint, rest = dm.group(1), remainder.strip()
    elif hm := _DATE_IN_HEADING_RE.search(m.group(1)):
        hint = hm.group(1)
    return {"date_hint": hint, "text": rest} if rest else None


def wrapup_from_comment(body: str) -> str | None:
    """Return just the text of a wrap-up comment (see `parse_wrapup_comment`), or None."""
    parsed = parse_wrapup_comment(body)
    return parsed["text"] if parsed else None


def parse_issue_body(body: str, title: str = "") -> dict:
    """Extract all sprint fields from an issue body.

    Parameters
    ----------
    body : str
        Raw Markdown body.
    title : str, optional
        Issue title, used to drop a repeated title heading in old-style bodies.

    Returns
    -------
    dict
        Keys ``pitch``, ``contacts``, ``type``, ``working_groups`` (list), ``goals``,
        ``prerequisites``, ``links``, ``details``, ``wrapup``, ``options`` (list of
        ticked checkboxes) and ``schedule_note`` (free-text scheduling remarks from
        old-style issues). Missing fields are empty.
    """
    sec = split_sections(body)
    legacy = _parse_legacy_preamble(sec.get("preamble", ""), title)

    def field(name: str) -> str:
        return _clean(sec.get(name, "")) or _clean(legacy.get(name, ""))

    details = field("details")
    if not sec.get("pitch") and legacy.get("intro_rest"):
        details = "\n\n".join(x for x in (legacy["intro_rest"], details) if x)

    types = parse_list(field("type"))
    return {
        "pitch": field("pitch"),
        "contacts": field("contacts"),
        "type": types[0] if types else "",
        "working_groups": parse_list(field("working_groups")),
        "goals": field("goals"),
        "prerequisites": field("prerequisites"),
        "links": field("links"),
        "details": details,
        "wrapup": field("wrapup"),
        "options": parse_checkboxes(sec.get("options", "")),
        "schedule_note": _clean(legacy.get("schedule_note", "")),
    }


def plain_text(markdown: str, limit: int | None = None) -> str:
    """Reduce Markdown to plain text for calendar feeds and previews."""
    text = _COMMENT_RE.sub("", markdown or "")
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)  # images
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", text)  # links
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.M)
    text = re.sub(r"[*_`]{1,3}([^*_`]+)[*_`]{1,3}", r"\1", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if limit and len(text) > limit:
        text = text[: limit - 1].rsplit(" ", 1)[0] + "…"
    return text
