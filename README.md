# back2church.org

Static website for **back2church.org**: landing page, Good News & Truth app link (gospel.back2church.org) and a searchable wiki fed from the Notion "B2C master database". Hosted free on GitHub Pages.

## How the wiki works
- `scripts/sync-notion.mjs` runs in GitHub Actions on every push and daily (~04:17 CH time).
- It exports **only** public entries to `data/wiki.json`:
  - Entry type **Ressources**, or
  - Entry type **Teaching / Sermon** with Document status **1 Final**.
- Contacts, Tasks, Meetings, Events, drafts and private fields (Email, Mobile, Address, Birthdate) are never exported. Pages titled "…template…" are skipped.
- To publish a teaching: set its Document status to **1 Final** in Notion. It appears after the next daily run (or run the workflow manually: Actions → "Sync Notion wiki & deploy" → Run workflow).

## One-time setup
1. **Repo:** push this folder to `back2church/website` (branch `main`).
2. **Pages:** Settings → Pages → Source: **GitHub Actions**. Custom domain: `back2church.org` → Save → tick **Enforce HTTPS** once available.
3. **Notion key** (free):
   - https://www.notion.so/profile/integrations → New integration → name "back2church website", type Internal, capability **Read content only** → copy the secret.
   - In Notion open **B2C master database** → ••• → Connections → add "back2church website".
   - GitHub repo → Settings → Secrets and variables → Actions → New repository secret: `NOTION_TOKEN` = the secret.
4. **DNS** (WordPress.com, domain back2church.org): apex A records → 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153; `www` CNAME → `back2church.github.io`. Google mail records (MX/SPF) stay unchanged.

## Local preview
`python3 -m http.server` in this folder, open http://localhost:8000. Optional: `NOTION_TOKEN=… node scripts/sync-notion.mjs` to refresh `data/wiki.json`.
