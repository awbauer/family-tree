// Nightly backup (Cron Trigger) of every table to the private R2 bucket: backups/YYYY-MM-DD.json.
// Keeps 30 daily copies plus the 1st of each month for a year. D1 Time Travel covers the last 30 days as well.
// Restore runbook: docs/agents/operations.md → "Backups and restore".

const TABLES = ["meta", "config", "people", "families", "sources", "media", "findings", "statuses", "stories",
  "research_log", "todos", "todo_events", "proposals", "members", "trees", "views", "grants", "changes"];

export async function exportAll(env) {
  const out = { exported_at: new Date().toISOString(), format: "family-tree-backup/1", tables: {} };
  for (const t of TABLES) out.tables[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  return out;
}

export async function runBackup(env, today = new Date()) {
  if (!env.MEDIA) return { skipped: "no R2 binding" };
  const day = today.toISOString().slice(0, 10);
  const data = await exportAll(env);
  await env.MEDIA.put(`backups/${day}.json`, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
  // prune
  const keep = (key) => {
    const m = key.match(/backups\/(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) return true;
    const age = (today - new Date(m[1] + "T00:00:00Z")) / 86400000;
    return age <= 30 || (m[1].endsWith("-01") && age <= 366);
  };
  let cursor, deleted = 0;
  do {
    const list = await env.MEDIA.list({ prefix: "backups/", cursor });
    const old = list.objects.map((o) => o.key).filter((k) => !keep(k));
    if (old.length) { await env.MEDIA.delete(old); deleted += old.length; }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return { key: `backups/${day}.json`, deleted };
}
