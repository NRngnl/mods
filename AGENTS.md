# AGENTS.md

## PII and secret scrub before every commit and push

Before every `git commit` and every `git push`, scan for personally identifiable
information (PII) and secrets, and remove them. Do not commit or push until the
scan is clean.

### Where to scan

Everything that will be committed or pushed:

- Staged and unstaged diffs, and new untracked files
- Source code, comments, docstrings, TODOs
- Unit tests, e2e tests, fixtures, snapshots, mocks, seed data
- Docs, README, config, `.env*` samples, CI files, scripts
- Logs, HTML, JSON, CSV, SQL dumps, screenshots and other images
- The commit message (subject and body), tag messages, branch names
- For `push`: every commit not yet on the remote (`git log @{u}..HEAD`)
  including their messages and diffs

### What counts as PII

- Real names of people (other than the exemption below), usernames, handles
- Email addresses, phone numbers, postal/home addresses
- Government, tax, passport, driver-licence, national ID numbers
- Bank, card and payment details; crypto wallet addresses tied to a person
- IP addresses, device IDs, MAC addresses, precise location/coordinates
- Dates of birth, health, biometric, or other sensitive personal data
- Credentials and secrets: passwords, API keys, tokens, private keys, cookies,
  session IDs, connection strings with passwords
- Personal absolute paths such as `/home/<name>/...`, `C:\Users\<name>\...`,
  and machine hostnames that reveal an identity
- Personal URLs: social profiles, private repos, internal/company domains
- Real user data pasted into tests, fixtures or bug reports

### What counts as a secret

- API keys, access/refresh/bearer/JWT tokens, OAuth client secrets, webhook secrets
- Cloud keys (AWS `AKIA...`, GCP service-account JSON, Azure keys, Cloudflare tokens)
- Git host tokens (`ghp_`, `gho_`, `github_pat_`, `glpat-`), npm/PyPI/Docker tokens
- Private keys and certs (`BEGIN ... PRIVATE KEY`, `.pem`, `.p12`, `.pfx`, SSH keys)
- Passwords, DB/Redis/AMQP URLs with credentials (`scheme://user:pass@host`)
- Slack/Stripe/Twilio/SendGrid-style keys (`xox[bpas]-`, `sk_live_`, `SG.`)
- Session cookies, `.env` files, `.npmrc`/`.netrc`/`.pypirc` auth lines, kubeconfigs
- High-entropy strings assigned to key/secret/token/password variables
- Secrets in git history, commit messages, test fixtures and CI config, not just the latest tree

Never commit real secret files; ensure `.env*`, `*.pem`, `*.key`, credentials
files are in `.gitignore`.

### Exemption

The git author/committer **name and email** in commit metadata are allowed.
Upstream author names and emails in the `authors` field, copyright headers
and `LICENSE` files of vendored third-party code (`vendor/`) are also allowed.
Keep them unmodified; licenses require it. Still scan everything else there.
Do not rewrite or strip them. Everything else in the commit, including the
message body and `Co-authored-by:` or `Signed-off-by:` trailers naming
other people, is subject to the scan.

### How to scan

1. Read the full diff yourself:
   `git diff --cached`, `git diff`, `git status --porcelain` (check untracked files),
   and the planned commit message.
2. Run quick pattern checks over the changed content, for example:

   ```sh
   git diff --cached -U0 | grep -nEi \
     '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b([0-9]{1,3}\.){3}[0-9]{1,3}\b|\+?[0-9][0-9 ()-]{8,}[0-9]|/home/[^/ ]+|/Users/[^/ ]+|C:\\Users\\|(api|secret|token|passw(or)?d|key)[a-z_]*\s*[:=]|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}'
   ```

   `gitleaks` (8.30+, installed with `mise use -g gitleaks@latest`) is required. Run
   `scripts/install-hooks.sh` once per clone: the pre-commit hook then runs
   `gitleaks git --staged` on every commit. Before push run
   `gitleaks git --config .gitleaks.toml` over the history. CI repeats the full scan
   (`.github/workflows/secrets.yml`). Never edit `.gitleaks.toml` to silence a real finding;
   its allowlist covers only fake test fixtures.
   Also check `git ls-files -o --exclude-standard` for untracked secret files.
3. Review each hit by hand. Patterns miss names and addresses, so read the diff
   even when the grep is empty.
4. Before push, repeat for the whole unpushed range:
   `git log -p @{u}..HEAD` (or `origin/main..HEAD` when no upstream).

### How to fix

- Replace with neutral placeholders: `user@example.com`, `Jane Doe`,
  `192.0.2.1` (documentation range), `+1-555-0100`, `<API_KEY>`, `/path/to/project`.
- Use fake or generated data in tests and fixtures, never real records.
- Read secrets from environment variables or a secret store; keep real values in
  git-ignored files (add `.env` and similar to `.gitignore`).
- Remove PII from the commit message before committing. If a commit already made
  locally contains PII, rewrite it before pushing (`git commit --amend`,
  `git rebase -i`), keeping the author name and email unchanged.
- If PII or a secret was already pushed, stop and tell the user. A pushed secret
  is compromised: it must be revoked/rotated, and history rewrite and
  force-push need their explicit approval.

### Rules

- Never skip the scan, never use `--no-verify` to bypass hooks.
- Never print found PII values back in chat or logs; refer to `file:line` and the
  type of data only.
- When unsure whether something is PII, treat it as PII and ask the user.
- Report at the end: what was scanned, what was removed or replaced, and anything
  that needs the user's decision.

