#!/usr/bin/env node
// Read-only local viewer over one or more career-ops data roots.
//
//   node tools/people-viewer/server.mjs [--port 4747] [--people ~/career-ops-people]
//
// People are discovered from:
//   1. this checkout's own data root ("me")
//   2. every subfolder of the people dir (env CAREER_OPS_PEOPLE_DIR, --people,
//      default ~/career-ops-people) that holds a tracker
//   3. optional people.json next to this file: [{ "name": "Alice", "path": "/abs/path" }]
//
// Binds to 127.0.0.1 only. Never writes anything.

import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync, realpathSync, createReadStream } from 'node:fs';
import { join, resolve, dirname, basename, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(flag('port', process.env.PORT || 4747));
const PEOPLE_DIR = resolve(
  (flag('people', process.env.CAREER_OPS_PEOPLE_DIR || join(homedir(), 'career-ops-people'))).replace(/^~(?=$|\/)/, homedir()),
);

// ---------- discovery ----------

async function ownDataRoot() {
  try {
    const { getCareerOpsRoot } = await import(join(REPO, 'path-resolver.mjs'));
    return getCareerOpsRoot();
  } catch {
    return REPO;
  }
}

// A person folder may be a full checkout pointing elsewhere via .career-ops-data.
function dataRootOf(dir) {
  const marker = join(dir, '.career-ops-data');
  if (existsSync(marker)) {
    const target = readFileSync(marker, 'utf8').trim();
    if (target) return resolve(dir, target);
  }
  return dir;
}

function trackerOf(root) {
  for (const p of ['data/applications.md', 'applications.md']) {
    if (existsSync(join(root, p))) return join(root, p);
  }
  return null;
}

function nameFromProfile(root, fallback) {
  try {
    const yml = readFileSync(join(root, 'config/profile.yml'), 'utf8');
    const m = yml.match(/^\s*full_name:\s*["']?([^"'\n]+?)["']?\s*$/m);
    if (m && !/your name|jane doe|john doe/i.test(m[1])) return m[1];
  } catch {}
  return fallback;
}

const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'person';

async function discoverPeople() {
  const candidates = [{ path: await ownDataRoot(), fallback: 'Me' }];

  if (existsSync(PEOPLE_DIR)) {
    for (const entry of readdirSync(PEOPLE_DIR)) {
      const dir = join(PEOPLE_DIR, entry);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      candidates.push({ path: dataRootOf(dir), fallback: entry });
    }
  }

  const listFile = join(HERE, 'people.json');
  if (existsSync(listFile)) {
    try {
      for (const p of JSON.parse(readFileSync(listFile, 'utf8'))) {
        if (p?.path) candidates.push({ path: dataRootOf(resolve(HERE, p.path.replace(/^~(?=$|\/)/, homedir()))), fallback: p.name, name: p.name });
      }
    } catch (e) {
      console.warn(`people.json ignored: ${e.message}`);
    }
  }

  const seen = new Set();
  const people = [];
  for (const c of candidates) {
    let real;
    try { real = realpathSync(c.path); } catch { continue; }
    if (seen.has(real) || !trackerOf(real)) continue;
    seen.add(real);
    const name = c.name || nameFromProfile(real, c.fallback);
    let id = slugify(name);
    while (people.some((p) => p.id === id)) id += '-2';
    people.push({ id, name, root: real, isMe: people.length === 0 && c === candidates[0] });
  }
  return people;
}

// ---------- parsing ----------

const cellsOf = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function parseTracker(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const headerIdx = lines.findIndex((l) => /^\s*\|\s*#\s*\|/.test(l));
  if (headerIdx < 0) return [];
  const header = cellsOf(lines[headerIdx]).map((h) => h.toLowerCase());
  const rows = [];
  for (const line of lines.slice(headerIdx + 2)) {
    if (!line.trim().startsWith('|')) continue;
    let cells = cellsOf(line);
    // Notes may contain a stray pipe: fold overflow back into the last column.
    if (cells.length > header.length) {
      cells = [...cells.slice(0, header.length - 1), cells.slice(header.length - 1).join(' | ')];
    }
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    rows.push(row);
  }
  return rows;
}

function within(root, p) {
  const abs = resolve(p);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

function reportMeta(file) {
  const text = readFileSync(file, 'utf8');
  const head = text.slice(0, 6000);
  const field = (label) => head.match(new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, 'mi'))?.[1].trim() || '';
  const yaml = (key) => head.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm'))?.[1].trim() || '';
  return {
    url: field('URL'),
    legitimacy: field('Legitimacy') || yaml('legitimacy_tier'),
    archetype: field('Archetype'),
    workAuth: field('Work Auth'),
    applicants: field('Applicants'),
    decision: yaml('final_decision'),
  };
}

function findPdf(root, reportFile) {
  const out = join(root, 'output');
  if (!reportFile || !existsSync(out)) return '';
  const slug = basename(reportFile, '.md').replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const pdfs = readdirSync(out).filter((f) => f.endsWith('.pdf') && (f.includes(`-${slug}-`) || f.endsWith(`-${slug}.pdf`)));
  return pdfs.sort().at(-1) ? `output/${pdfs.sort().at(-1)}` : '';
}

function parsePipeline(root) {
  const file = join(root, 'data/pipeline.md');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n')
    .map((l) => l.match(/^- \[( |!)\]\s+(.*)$/))
    .filter(Boolean)
    .map(([, mark, rest]) => {
      const [url = '', company = '', role = '', ...note] = rest.split(' | ');
      return { blocked: mark === '!', url: url.trim(), company: company.trim(), role: role.trim(), note: note.join(' | ').trim() };
    });
}

function personData(person) {
  const tracker = trackerOf(person.root);
  const rows = parseTracker(tracker).map((r) => {
    const link = (r.report || '').match(/\]\(([^)]+)\)/)?.[1] || '';
    const reportAbs = link ? within(person.root, resolve(dirname(tracker), link)) : null;
    const reportPath = reportAbs && existsSync(reportAbs) ? reportAbs.slice(person.root.length + 1) : '';
    const meta = reportPath ? reportMeta(reportAbs) : {};
    const score = parseFloat(r.score);
    return {
      num: r['#'],
      date: r.date || '',
      company: r.company || '',
      role: r.role || '',
      score: Number.isFinite(score) ? score : null,
      status: (r.status || '').replace(/\*/g, '').trim(),
      notes: r.notes || '',
      via: r.via || '',
      location: r.location || '',
      report: reportPath,
      pdf: findPdf(person.root, reportPath),
      ...meta,
      url: r.url || meta.url || '',
    };
  });
  return {
    id: person.id,
    name: person.name,
    root: person.root,
    isMe: person.isMe,
    rows,
    pipeline: parsePipeline(person.root),
  };
}

// ---------- http ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf', '.json': 'application/json' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/') return send(res, 200, readFileSync(join(HERE, 'index.html')), TYPES['.html']);

    if (parts[0] === 'api' && parts[1] === 'people') {
      const people = await discoverPeople();
      if (parts.length === 2) {
        return send(res, 200, people.map((p) => {
          const rows = parseTracker(trackerOf(p.root));
          const scores = rows.map((r) => parseFloat(r.score)).filter(Number.isFinite);
          return {
            id: p.id, name: p.name, isMe: p.isMe, count: rows.length,
            best: scores.length ? Math.max(...scores) : null,
          };
        }));
      }
      const person = people.find((p) => p.id === parts[2]);
      if (!person) return send(res, 404, { error: 'unknown person' });
      if (parts.length === 3) return send(res, 200, personData(person));

      // /api/people/:id/file?path=reports/x.md|output/x.pdf
      if (parts[3] === 'file') {
        const rel = url.searchParams.get('path') || '';
        if (!/^(reports|output)\//.test(rel) || !['.md', '.pdf'].includes(extname(rel))) return send(res, 400, { error: 'bad path' });
        const abs = within(person.root, join(person.root, rel));
        if (!abs || !existsSync(abs)) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': TYPES[extname(abs)], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return createReadStream(abs).pipe(res);
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', async () => {
  const people = await discoverPeople();
  console.log(`career-ops people viewer → http://127.0.0.1:${PORT}`);
  console.log(`people dir: ${PEOPLE_DIR}${existsSync(PEOPLE_DIR) ? '' : ' (not created yet)'}`);
  for (const p of people) console.log(`  · ${p.name}  ${p.root}`);
});
