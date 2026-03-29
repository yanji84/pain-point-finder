# GapScout

Market intelligence engine that maps competitors, mines weaknesses across 11+ sources, identifies whitespace, and scores opportunities. Runs as a Claude Code skill.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- Node.js >= 18
- npm

## Setup

```bash
git clone https://github.com/yanji84/gapscout.git
cd gapscout
npm install
```

### Configure environment (optional)

```bash
cp .env.example .env
# Edit .env with your settings (all have sensible defaults)
```

### Start the web server (optional)

The web server provides a dashboard for viewing scans, managing team LinkedIn connections, and API key management. It's optional — the `/gapscout` skill works without it.

```bash
npm start
# Open http://localhost:3000
```

On first launch, you'll be prompted to create an admin account.

## Usage as a Claude Code Skill

In Claude Code, from the gapscout directory:

```
/gapscout pokemon TCG market
/gapscout project management tools
/gapscout Jira, Asana, Linear, Monday
/gapscout                              # suggests markets from HN frontpage
/gapscout ideas                        # generate team-fit ideas from trending signals
/gapscout ideas --auto                 # generate + auto-scan top idea
```

## Team LinkedIn Connections (Optional)

Upload your team's LinkedIn connections for personalized outreach suggestions in every report.

1. Export your connections from LinkedIn ([instructions](https://www.linkedin.com/help/linkedin/answer/a566336))
2. Start the server (`npm start`) and log in
3. Click **Connections** in the nav bar
4. Enter your name and upload the CSV
5. Repeat for each team member

Alternatively, place CSV exports in a `team/` directory at the project root.

## How It Works

The `/gapscout` skill spawns an orchestrator agent that coordinates ~225 sub-agents across 5 stages:

1. **Planning** — Scopes the market, generates search queries
2. **Discovery** — Maps competitors from multiple sources
3. **Scanning** — Mines 11+ sources (Reddit, HN, Trustpilot, G2, Product Hunt, Google, app stores, etc.)
4. **Synthesis** — Extracts pain themes, unmet needs, switching signals, and scores opportunities
5. **Reporting** — Generates JSON + HTML reports with citations

Reports go through iterative refinement: critique, debate, strategic review, and targeted re-scanning.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DATA_DIR` | `./data` | Directory for SQLite DB, scans, and ideas |
| `BASE_PATH` | (empty) | URL prefix for reverse proxy setups |
| `SESSION_SECRET` | (random) | Session cookie secret — set for persistent sessions |
| `MAX_CONCURRENT_SCANS` | `3` | Max parallel scans |
| `NODE_ENV` | `development` | Set to `production` for stricter security |

## CLI (used internally by agents)

```bash
node scripts/cli.mjs <source> <command> [options]
```

Sources: `api`, `browser`, `hn`, `google`, `ph`, `reviews`, `kickstarter`, `appstore`, `trustpilot`, `all`

For sources that require a browser (`browser`, `google`, `ph`, `reviews`, `kickstarter`, `appstore`), Chrome must be running with remote debugging enabled.

## Available Sources

| Source | Alias | Data | Requires Browser |
|--------|-------|------|-----------------|
| `reddit-api` | `api` | Historical Reddit via PullPush API | No |
| `reddit-browser` | `browser` | Real-time Reddit via old.reddit.com | Yes |
| `hackernews` | `hn` | Hacker News via Algolia API | No |
| `google-autocomplete` | `google` | Google autocomplete + People Also Ask | Yes |
| `producthunt` | `ph` | Product Hunt launches + comments | Yes |
| `reviews` | `reviews` | G2/Capterra 1-3 star reviews | Yes |
| `crowdfunding` | `kickstarter` | Kickstarter projects + backer comments | Yes |
| `appstore` | `appstore` | Google Play Store 1-2 star reviews | Yes |
| `coordinator` | `all` | Runs all sources in parallel | Depends |

## License

MIT
