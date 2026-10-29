# Visual snapshots on GitHub pull requests

Workflows that run `qunitx record --compare` on every pull request and leave one comment: each
changed snapshot's diff, before and after side by side with every change boxed, or "No visual
changes in this PR, good job", with a link to download the full report.

## Set up

1. Describe the pages in `package.json` and commit nothing but the baselines:

   ```json
   "qunitx": {
     "record": {
       "inputs": ["http://localhost:4200/", "http://localhost:4200/pricing"],
       "width": 1280,
       "height": 800,
       "wait": "[data-ready]",
       "mask": ["[data-testid=clock]"],
       "output": "snapshots"
     }
   }
   ```

   ```gitignore
   snapshots/*.new.png
   snapshots/*.diff.png
   snapshots/report.html
   snapshots/comment.md
   ```

2. Copy the workflows into `.github/workflows/`:
   - **Private repository:** `private/visual-snapshots.yml`
   - **Public repository:** `public/visual-snapshots.yml` and `public/visual-snapshots-comment.yml`.
     They are two on purpose: a fork's PR runs with a read-only token, so the half that runs its
     code has no write access, and the half that comments never runs its code.
   - **Both:** `update-snapshots.yml` and `cleanup-snapshots.yml`

   Edit the build and serve steps to match your app.

3. Make the first baselines: run **Update visual snapshots** from the Actions tab on `main`.
   Baselines must come from CI, not a laptop: fonts and rendering differ between machines.

## Day to day

- A PR that changes how a page looks gets a comment and a red check.
- If the change is intended, run **Update visual snapshots** on the PR's branch. It commits the
  new baselines. Give it a `SNAPSHOTS_TOKEN` secret (a GitHub App token or a fine-grained personal
  access token with _Contents: read and write_) so that commit re-runs the check; commits made
  with the default token do not start workflows.
- When the PR closes, its image branch (`visual/pr-<number>`) is deleted.

## How the images get into the comment

A comment cannot carry images, so each run pushes the changed snapshots' diffs to a bot-only
`visual/pr-<number>` branch, and `--pr-comment --images-url <its URL>` writes `comment.md` with
links into it. In a public repository anyone can see them; in a private one, only people who can see the
repository. The full report (`report.html` with every snapshot) is the run's `visual-report`
artifact.
