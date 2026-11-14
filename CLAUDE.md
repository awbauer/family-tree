# CLAUDE.md

@AGENTS.md

Claude Code specifics:
- Skills in `.claude/skills/`: `research` (work a to-do into a validated batch) and `publish` (build → check → load D1 → deploy, with the owner's OK at each remote step).
- `.claude/settings.json` asks before remote D1 loads, deploys, R2 writes and pushes, and denies `--no-verify` and force-pushes. Don't work around it.
- For several branches in parallel, give each subagent one branch and have it write its own batch file; merge them yourself afterwards (see "Multiple agents at once" in AGENTS.md).
