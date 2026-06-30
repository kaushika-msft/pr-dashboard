# PR Command Center

A polished PR analytics dashboard with a friendly kanban board for tracking GitHub pull requests across repositories.

## What It Does

- Starts with one repository (`microsoft/vscode`) and lets you add more repositories to the portfolio.
- Pulls PR data directly from the GitHub REST API.
- Shows a dashboard with KPI tiles, a status chart, and team status updates.
- Organizes PRs into drag-and-drop workflow columns: On Track, Blocked, Needs Attention, and Done.
- Lets you assign a PR to someone, post local comments, and update workflow status from the card.
- Filters by workflow status, label, search text, and user-specific views.
- Supports quick actions for each PR: Open, Files, Checks, Copy URL.
- Auto-detects your GitHub username from local GitHub CLI auth, with manual override.
- Pins the repo-specific label set in the dashboard so the CPM/SME workflow labels stay visible in filters and summary cards.

## Run Locally

This project is intentionally no-build.

1. Run the VS Code task `Run PR Dashboard`.
2. The task starts a local static server and opens `http://localhost:5500/index.html`.
3. For public repositories, no credentials are required.
4. For private/internal repositories, sign in once via GitHub CLI in terminal:
   `gh auth login -w -s repo,read:org`
5. Refresh the dashboard. The local server reuses your GitHub CLI session.

## Share With The Team

The app is set up for GitHub Pages deployment through `.github/workflows/deploy.yml`.

Live URL: https://kaushika-msft.github.io/pr-dashboard/

1. Push the repo to GitHub.
2. Enable GitHub Pages in repository settings using the GitHub Actions source.
3. Push to `main` or run the `Deploy PR Command Center` workflow manually.
4. Share the Pages URL with the team so they can open the dashboard without running it locally.

## Notes

- Board status, assignees, comments, team updates, and tracked repositories are saved locally in browser storage.
- If a repo fails refresh, the dashboard shows the API error details in the Filters panel.
- PAT entry is not required in the app.
