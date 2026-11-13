// Pulls the PUBLIC entries of the "B2C master database" from Notion
// and writes them to data/wiki.json (+ downloads Notion-hosted images to media/).
//
// Public = Entry type "Ressources"  OR  (Entry type "Teaching"/"Sermon" AND Document status "1 Final").
// Contacts, Tasks, Meetings, Events and drafts are NEVER exported.
//
// Needs env NOTION_TOKEN (internal integration secret, shared with the database).
// Node 20+, no dependencies.

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.NOTION_DATABASE_ID || '2cc4485380c34b78b457c486a96afc5a';
const OUT_DIR = process.env.OUT_DIR || '.';
const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

if (!TOKEN) {
  console.log('NOTION_TOKEN not set – keeping existing data/wiki.json.');
  process.exit(0);
}

// Builds an "equals" filter that matches the property's real type (select, status, …).
function eq(schema, name, value) {
  const type = schema[name]?.type;
  if (!type) throw new Error(`Property "${name}" not found in the Notion database.`);
  if (type === 'multi_select') return { property: name, multi_select: { contains: value } };
  return { property: name, [type]: { equals: value } };
}

// Notion allows only two levels of nested filters, so Teaching/Sermon get one AND each.
const publicFilter = schema => ({
  or: [
    eq(schema, 'Entry type', 'Ressources'),
    { and: [eq(schema, 'Entry type', 'Teaching'), eq(schema, 'Document status', '1 Final')] },
    { and: [eq(schema, 'Entry type', 'Sermon'), eq(schema, 'Document status', '1 Final')] },
  ],
});

// Properties that may be published. Everything else (Email, Mobile, Address, Birthdate, …) is dropped.
const SAFE_PROPS = ['Entry type', 'Language', 'Series', 'Lesson type', 'Media type', 'Ministry', 'Level', 'Tags', 'URL'];

async function notion(method, url, body, attempt = 0) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Notion-Version': VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 && attempt < 5) {
    const wait = Number(res.headers.get('retry-after') || 1) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return notion(method, url, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (/^(https?:|mailto:)/i.test(u || '') ? u : (u && /^[\w.-]+\.[a-z]{2,}/i.test(u) ? 'https://' + u : null));

function richText(arr = []) {
  return arr.map(t => {
    let s = esc(t.plain_text);
    const a = t.annotations || {};
    if (a.code) s = `<code>${s}</code>`;
    if (a.bold) s = `<strong>${s}</strong>`;
    if (a.italic) s = `<em>${s}</em>`;
    if (a.strikethrough) s = `<s>${s}</s>`;
    if (a.underline) s = `<u>${s}</u>`;
    const href = t.href && safeUrl(t.href) && !t.href.includes('notion.so') ? t.href : null;
    if (href) s = `<a href="${esc(href)}" target="_blank" rel="noopener">${s}</a>`;
    return s;
  }).join('');
}
const plain = (arr = []) => arr.map(t => t.plain_text).join('');

let mediaCount = 0;
async function saveMedia(block) {
  const f = block[block.type];
  if (f.type === 'external') return safeUrl(f.external.url);
  try {
    const res = await fetch(f.file.url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = (path.extname(new URL(f.file.url).pathname) || '.bin').toLowerCase().slice(0, 6);
    const name = createHash('sha1').update(block.id).digest('hex').slice(0, 16) + ext;
    await writeFile(path.join(OUT_DIR, 'media', name), buf);
    mediaCount++;
    return 'media/' + name;
  } catch { return null; }
}

async function children(id) {
  const out = [];
  let cursor;
  do {
    const r = await notion('GET', `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

async function renderBlocks(blocks) {
  let html = '';
  let list = null; // 'ul' | 'ol'
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const b of blocks) {
    const d = b[b.type] || {};
    const kids = b.has_children && !['child_page', 'child_database'].includes(b.type)
      ? await renderBlocks(await children(b.id)) : '';
    const li = b.type === 'bulleted_list_item' ? 'ul' : b.type === 'numbered_list_item' ? 'ol' : null;
    if (li) {
      if (list !== li) { close(); html += `<${li}>`; list = li; }
      html += `<li>${richText(d.rich_text)}${kids}</li>`;
      continue;
    }
    close();
    switch (b.type) {
      case 'paragraph': html += `<p>${richText(d.rich_text)}</p>${kids}`; break;
      case 'heading_1': html += `<h2>${richText(d.rich_text)}</h2>${kids}`; break;
      case 'heading_2': html += `<h3>${richText(d.rich_text)}</h3>${kids}`; break;
      case 'heading_3': html += `<h4>${richText(d.rich_text)}</h4>${kids}`; break;
      case 'quote': html += `<blockquote>${richText(d.rich_text)}${kids}</blockquote>`; break;
      case 'callout': html += `<aside class="callout">${d.icon?.emoji ? esc(d.icon.emoji) + ' ' : ''}${richText(d.rich_text)}${kids}</aside>`; break;
      case 'toggle': html += `<details><summary>${richText(d.rich_text)}</summary>${kids}</details>`; break;
      case 'to_do': html += `<p>${d.checked ? '☑' : '☐'} ${richText(d.rich_text)}</p>${kids}`; break;
      case 'code': html += `<pre><code>${esc(plain(d.rich_text))}</code></pre>`; break;
      case 'divider': html += '<hr>'; break;
      case 'column_list': case 'column': case 'synced_block': html += kids; break;
      case 'image': {
        const src = await saveMedia(b);
        if (src) html += `<figure><img src="${esc(src)}" alt="${esc(plain(d.caption))}" loading="lazy">${d.caption?.length ? `<figcaption>${richText(d.caption)}</figcaption>` : ''}</figure>`;
        break;
      }
      case 'bookmark': case 'embed': case 'link_preview': {
        const u = safeUrl(d.url); if (u) html += `<p><a href="${esc(u)}" target="_blank" rel="noopener">${esc(plain(d.caption) || u)}</a></p>`; break;
      }
      case 'video': case 'audio': case 'pdf': case 'file': {
        const u = d.type === 'external' ? safeUrl(d.external.url) : await saveMedia(b);
        if (u) html += `<p><a href="${esc(u)}" target="_blank" rel="noopener">▶ ${esc(plain(d.caption) || d.name || b.type)}</a></p>`; break;
      }
      case 'table': {
        const rows = await children(b.id);
        html += '<table>' + rows.map((r, i) => '<tr>' + r.table_row.cells.map(c => {
          const tag = i === 0 && d.has_column_header ? 'th' : 'td';
          return `<${tag}>${richText(c)}</${tag}>`;
        }).join('') + '</tr>').join('') + '</table>';
        break;
      }
      default: break; // child_page, child_database, link_to_page, unsupported → skipped (may be private)
    }
  }
  close();
  return html;
}

function propValue(p) {
  if (!p) return null;
  switch (p.type) {
    case 'select': return p.select?.name ?? null;
    case 'status': return p.status?.name ?? null;
    case 'multi_select': return p.multi_select.map(o => o.name);
    case 'url': return safeUrl(p.url);
    case 'rich_text': return plain(p.rich_text) || null;
    default: return null;
  }
}

const stripHtml = h => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

async function main() {
  await rm(path.join(OUT_DIR, 'media'), { recursive: true, force: true });
  await mkdir(path.join(OUT_DIR, 'media'), { recursive: true });
  await mkdir(path.join(OUT_DIR, 'data'), { recursive: true });

  const db = await notion('GET', `/databases/${DATABASE_ID}`);
  const filter = publicFilter(db.properties);

  const pages = [];
  let cursor;
  do {
    const r = await notion('POST', `/databases/${DATABASE_ID}/query`, {
      filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);

  const entries = [];
  for (const pg of pages) {
    if (pg.archived || pg.in_trash) continue;
    const titleProp = Object.values(pg.properties).find(p => p.type === 'title');
    const title = plain(titleProp?.title).trim();
    if (!title || /template/i.test(title)) continue;
    const props = {};
    for (const k of SAFE_PROPS) {
      const v = propValue(pg.properties[k]);
      if (v && (!Array.isArray(v) || v.length)) props[k] = v;
    }
    const html = await renderBlocks(await children(pg.id));
    entries.push({
      id: pg.id.replace(/-/g, ''),
      title,
      icon: pg.icon?.type === 'emoji' ? pg.icon.emoji : null,
      updated: pg.last_edited_time,
      props,
      html,
      text: stripHtml(html).slice(0, 20000),
    });
    process.stdout.write('.');
  }
  entries.sort((a, b) => a.title.localeCompare(b.title));
  await writeFile(path.join(OUT_DIR, 'data', 'wiki.json'),
    JSON.stringify({ generated: new Date().toISOString(), count: entries.length, entries }));
  console.log(`\nExported ${entries.length} public entries, ${mediaCount} media files.`);
}

main().catch(e => { console.error(e); process.exit(1); });
