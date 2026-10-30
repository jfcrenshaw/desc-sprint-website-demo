# Scheduling bot

A small [Cloudflare Worker](https://developers.cloudflare.com/workers/) that lets people schedule, edit and cancel Sprint Week sessions through a web form instead of editing comments by hand.

1. A new sprint issue gets a welcome comment with a **📅 Schedule a session** link (posted by the triage workflow).
2. The link opens a form served by this Worker, after a "Sign in with GitHub".
3. The Worker checks that the person may schedule for that sprint, then the bot (a GitHub App) posts one comment per session on the issue, with an **✏️ Edit or cancel** link.
4. The comment triggers the build workflow, and the calendar updates a minute or two later.

The session comments are the record: the Worker stores nothing.
It costs nothing at Sprint Week scale (Cloudflare's free plan allows 100,000 requests per day).

## Who may do what

- **Edit or cancel** a sprint's sessions: the issue author, its assignees, the people @mentioned under *Contact person(s)*, the person who created the session, and repository collaborators.
- **Add** sessions: all of the above, plus members of the organization set in `scheduler.org` of `sprintweek.yaml` (private members are only visible if the App is installed on that organization with *Members: read*).

Everyone else gets a polite "ask the sprint's contacts" page.

The form suggests the rooms configured for the chosen site and day, and the bot refuses a session in a listed room outside the availability set in `sprintweek.yaml` (see [Rooms and their availability](../README.md#rooms-and-their-availability)).
The bot reads the published calendar configuration and refreshes it every minute, so changes to rooms reach it about two minutes after they are committed.

## Security design

- People sign in with GitHub only to prove who they are.
  The Worker reads their login and immediately revokes their GitHub token; it never stores or uses it.
- All writes are made with a short-lived GitHub App installation token that is restricted to the sprint repository.
  The App only needs *Issues: read and write*, so even a bug in the Worker could at worst edit issue comments in that one repository.
- The Worker only ever creates or edits session comments; it never passes request data through to arbitrary API paths.
- Sessions are kept in a signed, `HttpOnly`, `Secure`, `SameSite=Lax` cookie that expires after 8 hours.
  Forms carry a CSRF token and the Worker checks the `Origin` header.
  The GitHub sign-in uses a `state` value and PKCE.
- User text is length-limited, stripped of control characters, Markdown-escaped and @mention-defanged before it is posted, and links must be `https://`.
  Pages are rendered with escaping everywhere and a strict Content Security Policy.
- Secrets live in Cloudflare's encrypted secret store, never in this repository.
- The Worker has no npm dependencies; JWT signing and HMACs use the built-in Web Crypto API.

## Setup (about 30 minutes, once per Sprint Week repository)

You need [Node.js](https://nodejs.org/) (for Cloudflare's `wrangler` command-line tool), a free [Cloudflare account](https://dash.cloudflare.com/sign-up), and admin rights on the sprint repository.

### 1. Deploy the Worker once to get its URL

```sh
cd worker
npx wrangler@4 login     # opens the browser
npm run deploy           # prints https://sprintweek-scheduler.<your-subdomain>.workers.dev
```

Edit `REPO` and `SITE_URL` in [wrangler.toml](wrangler.toml) first if this is not the demo repository.
Until the secrets are set, the Worker answers "Not configured yet".

### 2. Create the GitHub App

On GitHub: *Settings → Developer settings → GitHub Apps → New GitHub App* (for an organization: *Organization settings → Developer settings → GitHub Apps*).

| Setting | Value |
| --- | --- |
| GitHub App name | e.g. `DESC Sprint Week bot` (its "slug" becomes the bot's name) |
| Homepage URL | the calendar URL |
| Callback URL | `https://<worker-url>/callback` |
| Expire user authorization tokens | ✅ |
| Request user authorization (OAuth) during installation | ☐ |
| Webhook → Active | ☐ (not needed) |
| Repository permissions | **Issues: Read and write** (Metadata: Read-only is added automatically) |
| Organization permissions | Members: Read-only (only if installed on an organization and you want the org-member rule) |
| Where can this GitHub App be installed? | Only on this account |

After creating it:

1. Note the **App ID** and **Client ID** at the top of the settings page.
2. *Generate a new client secret* and copy it.
3. *Generate a private key*: a `.pem` file downloads.
4. *Install App* → choose **Only select repositories** → the sprint repository.

### 3. Give the Worker its secrets

```sh
npx wrangler@4 secret put GITHUB_APP_ID          # the App ID
npx wrangler@4 secret put GITHUB_CLIENT_ID       # the Client ID
npx wrangler@4 secret put GITHUB_CLIENT_SECRET   # the client secret
npx wrangler@4 secret put GITHUB_APP_PRIVATE_KEY < ~/Downloads/<app-name>.<date>.private-key.pem
openssl rand -base64 32 | npx wrangler@4 secret put SESSION_SECRET
```

Then delete the downloaded `.pem` file (you can always generate a new key).

Open `https://<worker-url>/status` to check the setup: it reports whether the App is installed on the repository and which bot account it posts as.

### 4. Point the calendar at the bot

In [sprintweek.yaml](../sprintweek.yaml):

```yaml
scheduler:
  url: https://sprintweek-scheduler.<your-subdomain>.workers.dev
  bot_login: <app-slug>[bot]
```

Push the change: the calendar shows *Schedule a session* and *Edit or cancel* links, and only comments by `bot_login` (or by collaborators) count as sessions.
Finally run *Actions → Welcome new sprints → Run workflow* to add the scheduling link to the welcome comments of existing issues.

### Optional: deploy from GitHub Actions

Create a Cloudflare API token with the *Edit Cloudflare Workers* template, then add the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and the repository variable `DEPLOY_WORKER=true`.
The [Scheduling bot workflow](../.github/workflows/worker.yml) then tests and deploys the Worker on every push that changes `worker/`.

## Development

```sh
cd worker
npm test                  # unit tests (Node's built-in test runner, no dependencies)
npx wrangler@4 dev        # local server; put secrets in worker/.dev.vars (git-ignored)
```

For local sign-in, add `http://localhost:8787/callback` as a second callback URL of the GitHub App.
[src/lib.js](src/lib.js) holds everything testable without network access (validation, time zones, comment format, signing).
[src/index.js](src/index.js) holds the routes and GitHub calls.
The comment format must stay identical to [sprintweek/sessions.py](../sprintweek/sessions.py); a test compares the two.
