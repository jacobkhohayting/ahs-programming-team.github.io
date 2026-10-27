'use strict';
const express = require('express');
const config = require('../config');
const { db, nowIso, transaction } = require('../db');
const auth = require('../auth');
const judge = require('../judge');
const { HttpError, bad, str, num, bool, EMAIL_RE, USERNAME_RE, contestStatus, problemLabel, LANGUAGES, VERDICTS, TZ } = require('../util');
const langName = (k) => (judge.getLanguages()[k] || LANGUAGES[k] || {}).name || k;

const router = express.Router();

// ---------------------------------------------------------------------------
// admin session
// ---------------------------------------------------------------------------
router.post('/login', (req, res) => {
  if (!config.adminPassword) throw new HttpError(503, 'The admin area is disabled: set ADMIN_PASSWORD in the .env file and restart the server.');
  if (!auth.rateLimit('admin:' + req.ip, 10, 15 * 60e3)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  if (!auth.safeEqual(String(req.body?.password || ''), config.adminPassword)) throw new HttpError(401, 'Wrong admin password.');
  req.session.admin = true;
  req.saveSession();
  res.json({ ok: true });
});
router.post('/logout', (req, res) => { req.session.admin = false; req.saveSession(); res.json({ ok: true }); });

router.use(auth.requireAdmin);

router.get('/status', (req, res) => {
  res.json({
    judge: judge.getStatus(),
    counts: {
      users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      contests: db.prepare('SELECT COUNT(*) AS n FROM contests').get().n,
      submissions: db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
      pending: db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status != 'done'").get().n,
    },
    config: { siteName: config.siteName, judgeWorkers: config.judgeWorkers, timeFactorPython: config.timeFactorPython, timeFactorJava: config.timeFactorJava, dataDir: config.dataDir },
    languages: judge.getLanguages(), verdicts: VERDICTS, timezones: safeTimezones(),
  });
});
router.post('/selftest', async (req, res) => { await judge.selfTest(); res.json(judge.getStatus()); });

function safeTimezones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC']; }
}

// ---------------------------------------------------------------------------
// contests
// ---------------------------------------------------------------------------
const LB_TYPES = ['short', 'long', 'adaptive'];

function parseContestBody(b, existing) {
  const out = {};
  out.name = str(b.name, { min: 1, max: 200, name: 'Contest name' });
  out.description = str(b.description, { max: 20000, name: 'Description', trim: false });
  out.timezone = str(b.timezone || existing?.timezone || 'UTC', { min: 1, max: 100, name: 'Time zone' });
  if (!TZ.isValidZone(out.timezone)) throw bad(`Unknown time zone "${out.timezone}". Use an IANA name such as America/New_York.`);
  const parseTime = (iso, local, label) => {
    if (iso) { const t = Date.parse(iso); if (Number.isNaN(t)) throw bad(`${label} is not a valid date/time.`); return new Date(t).toISOString(); }
    const t = TZ.zonedToUtc(local, out.timezone);
    if (Number.isNaN(t)) throw bad(`${label} is not a valid date/time (expected YYYY-MM-DDTHH:mm).`);
    return new Date(t).toISOString();
  };
  out.start_at = parseTime(b.start_at, b.start_local, 'Start time');
  out.end_at = parseTime(b.end_at, b.end_local, 'End time');
  if (Date.parse(out.end_at) <= Date.parse(out.start_at)) throw bad('The end time must be after the start time.');
  out.visible = bool(b.visible) ? 1 : 0;
  out.leaderboard_type = String(b.leaderboard_type || 'short');
  if (!LB_TYPES.includes(out.leaderboard_type)) throw bad('Leaderboard type must be short, long or adaptive.');
  out.penalty_per_wrong = num(b.penalty_per_wrong, { min: 0, max: 100000, name: 'Penalty per wrong submission', integer: true, def: 10 });
  out.decay_per_minute = num(b.decay_per_minute, { min: 0, max: 1e9, name: 'Points lost per minute', def: 1 });
  out.wrong_penalty_pts = num(b.wrong_penalty_pts, { min: 0, max: 1e9, name: 'Points lost per wrong submission', def: 0 });
  out.show_code_after = bool(b.show_code_after) ? 1 : 0;
  out.show_editorial = b.show_editorial === undefined ? 1 : (bool(b.show_editorial) ? 1 : 0);
  return out;
}

function contestRow(id) {
  const c = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM problems p WHERE p.contest_id = c.id) AS problem_count,
    (SELECT COUNT(*) FROM submissions s WHERE s.contest_id = c.id AND s.admin_test = 0) AS submission_count,
    (SELECT COUNT(*) FROM contest_entries e WHERE e.contest_id = c.id) AS participant_count FROM contests c WHERE c.id = ?`).get(Number(id));
  if (!c) throw new HttpError(404, 'Contest not found.');
  return { ...c, status: contestStatus(c), start_local: TZ.utcToZonedInput(Date.parse(c.start_at), c.timezone), end_local: TZ.utcToZonedInput(Date.parse(c.end_at), c.timezone) };
}

router.get('/contests', (req, res) => {
  const ids = db.prepare('SELECT id FROM contests ORDER BY start_at DESC, id DESC').all();
  res.json({ now: Date.now(), contests: ids.map((r) => contestRow(r.id)) });
});

router.post('/contests', (req, res) => {
  const c = parseContestBody(req.body || {});
  const r = db.prepare(`INSERT INTO contests (name, description, start_at, end_at, timezone, visible, leaderboard_type, penalty_per_wrong, decay_per_minute, wrong_penalty_pts, show_code_after, show_editorial, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(c.name, c.description, c.start_at, c.end_at, c.timezone, c.visible, c.leaderboard_type, c.penalty_per_wrong, c.decay_per_minute, c.wrong_penalty_pts, c.show_code_after, c.show_editorial, nowIso());
  res.json(contestRow(r.lastInsertRowid));
});

router.get('/contests/:id', (req, res) => {
  const c = contestRow(req.params.id);
  const problems = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM tests t WHERE t.problem_id = p.id) AS test_count,
    (SELECT COUNT(*) FROM tests t WHERE t.problem_id = p.id AND t.is_example = 1) AS example_count,
    (SELECT COUNT(*) FROM submissions s WHERE s.problem_id = p.id AND s.admin_test = 0) AS submission_count,
    (SELECT COUNT(DISTINCT s.user_id) FROM submissions s WHERE s.problem_id = p.id AND s.verdict = 'AC' AND s.admin_test = 0 AND s.invalidated = 0) AS solver_count
    FROM problems p WHERE p.contest_id = ? ORDER BY p.ord, p.id`).all(c.id).map((p, i) => ({ ...p, label: problemLabel(i) }));
  res.json({ ...c, problems });
});

router.put('/contests/:id', (req, res) => {
  const existing = contestRow(req.params.id);
  const c = parseContestBody(req.body || {}, existing);
  db.prepare(`UPDATE contests SET name = ?, description = ?, start_at = ?, end_at = ?, timezone = ?, visible = ?, leaderboard_type = ?, penalty_per_wrong = ?,
    decay_per_minute = ?, wrong_penalty_pts = ?, show_code_after = ?, show_editorial = ? WHERE id = ?`)
    .run(c.name, c.description, c.start_at, c.end_at, c.timezone, c.visible, c.leaderboard_type, c.penalty_per_wrong, c.decay_per_minute, c.wrong_penalty_pts, c.show_code_after, c.show_editorial, existing.id);
  res.json(contestRow(existing.id));
});

router.post('/contests/:id/visibility', (req, res) => {
  const c = contestRow(req.params.id);
  db.prepare('UPDATE contests SET visible = ? WHERE id = ?').run(bool(req.body?.visible) ? 1 : 0, c.id);
  res.json(contestRow(c.id));
});

// Deleting a contest permanently deletes its problems, tests, entries and submissions.
router.delete('/contests/:id', (req, res) => {
  const c = contestRow(req.params.id);
  db.prepare('DELETE FROM contests WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

router.post('/contests/:id/duplicate', (req, res) => {
  const c = contestRow(req.params.id);
  const copy = transaction(() => {
    const r = db.prepare(`INSERT INTO contests (name, description, start_at, end_at, timezone, visible, leaderboard_type, penalty_per_wrong, decay_per_minute, wrong_penalty_pts, show_code_after, show_editorial, created_at)
      SELECT name || ' (copy)', description, start_at, end_at, timezone, 0, leaderboard_type, penalty_per_wrong, decay_per_minute, wrong_penalty_pts, show_code_after, show_editorial, ? FROM contests WHERE id = ?`).run(nowIso(), c.id);
    const newId = r.lastInsertRowid;
    for (const p of db.prepare('SELECT * FROM problems WHERE contest_id = ? ORDER BY ord, id').all(c.id)) {
      const pr = db.prepare(`INSERT INTO problems (contest_id, ord, title, statement, editorial, solution_code, solution_language, time_limit_ms, memory_limit_mb, points, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newId, p.ord, p.title, p.statement, p.editorial, p.solution_code, p.solution_language, p.time_limit_ms, p.memory_limit_mb, p.points, nowIso());
      db.prepare('INSERT INTO tests (problem_id, ord, input, expected_output, is_example) SELECT ?, ord, input, expected_output, is_example FROM tests WHERE problem_id = ? ORDER BY ord, id').run(pr.lastInsertRowid, p.id);
    }
    return newId;
  });
  res.json(contestRow(copy));
});

router.post('/contests/:id/rejudge', (req, res) => {
  const c = contestRow(req.params.id);
  const ids = db.prepare('SELECT id FROM submissions WHERE contest_id = ? ORDER BY id').all(c.id);
  for (const r of ids) judge.requeue(r.id);
  res.json({ ok: true, count: ids.length });
});

// ---------------------------------------------------------------------------
// problems
// ---------------------------------------------------------------------------
function parseProblemBody(b) {
  return {
    title: str(b.title, { min: 1, max: 200, name: 'Title' }),
    statement: str(b.statement, { max: 200000, name: 'Statement', trim: false }),
    editorial: str(b.editorial, { max: 200000, name: 'Editorial', trim: false }),
    solution_code: str(b.solution_code, { max: 200000, name: 'Reference solution', trim: false }),
    solution_language: LANGUAGES[b.solution_language] ? b.solution_language : 'cpp',
    time_limit_ms: num(b.time_limit_ms, { min: 100, max: 60000, name: 'Time limit (ms)', integer: true, def: 1000 }),
    memory_limit_mb: num(b.memory_limit_mb, { min: 16, max: 4096, name: 'Memory limit (MB)', integer: true, def: 256 }),
    points: num(b.points, { min: 0, max: 1e9, name: 'Points', def: 100 }),
  };
}

function problemRow(id) {
  const p = db.prepare('SELECT * FROM problems WHERE id = ?').get(Number(id));
  if (!p) throw new HttpError(404, 'Problem not found.');
  const all = db.prepare('SELECT id FROM problems WHERE contest_id = ? ORDER BY ord, id').all(p.contest_id);
  p.label = problemLabel(all.findIndex((x) => x.id === p.id));
  return p;
}

router.post('/contests/:id/problems', (req, res) => {
  const c = contestRow(req.params.id);
  const p = parseProblemBody(req.body || {});
  const ord = (db.prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM problems WHERE contest_id = ?').get(c.id).m) + 1;
  const r = db.prepare(`INSERT INTO problems (contest_id, ord, title, statement, editorial, solution_code, solution_language, time_limit_ms, memory_limit_mb, points, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.id, ord, p.title, p.statement, p.editorial, p.solution_code, p.solution_language, p.time_limit_ms, p.memory_limit_mb, p.points, nowIso());
  res.json(problemRow(r.lastInsertRowid));
});

router.post('/contests/:id/problems/reorder', (req, res) => {
  const c = contestRow(req.params.id);
  const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : [];
  transaction(() => {
    order.forEach((pid, i) => db.prepare('UPDATE problems SET ord = ? WHERE id = ? AND contest_id = ?').run(i, pid, c.id));
  });
  res.json({ ok: true });
});

router.get('/problems/:pid', (req, res) => {
  const p = problemRow(req.params.pid);
  const tests = db.prepare('SELECT * FROM tests WHERE problem_id = ? ORDER BY ord, id').all(p.id);
  const contest = contestRow(p.contest_id);
  res.json({ ...p, tests, contest: { id: contest.id, name: contest.name, leaderboard_type: contest.leaderboard_type, status: contest.status } });
});

router.put('/problems/:pid', (req, res) => {
  const existing = problemRow(req.params.pid);
  const p = parseProblemBody(req.body || {});
  db.prepare(`UPDATE problems SET title = ?, statement = ?, editorial = ?, solution_code = ?, solution_language = ?, time_limit_ms = ?, memory_limit_mb = ?, points = ? WHERE id = ?`)
    .run(p.title, p.statement, p.editorial, p.solution_code, p.solution_language, p.time_limit_ms, p.memory_limit_mb, p.points, existing.id);
  res.json(problemRow(existing.id));
});

// Deleting a problem deletes its tests and all submissions to it.
router.delete('/problems/:pid', (req, res) => {
  const p = problemRow(req.params.pid);
  db.prepare('DELETE FROM problems WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

router.post('/problems/:pid/rejudge', (req, res) => {
  const p = problemRow(req.params.pid);
  const ids = db.prepare('SELECT id FROM submissions WHERE problem_id = ? ORDER BY id').all(p.id);
  for (const r of ids) judge.requeue(r.id);
  res.json({ ok: true, count: ids.length });
});

// Admin test run: judge some code against the problem without it counting anywhere.
router.post('/problems/:pid/test-run', (req, res) => {
  const p = problemRow(req.params.pid);
  const language = String(req.body?.language || '');
  if (!LANGUAGES[language]) throw bad('Unknown language.');
  const source = String(req.body?.source || '');
  if (!source.trim()) throw bad('Source is empty.');
  const r = db.prepare(`INSERT INTO submissions (user_id, contest_id, problem_id, language, source, status, submitted_at, admin_test) VALUES (NULL, ?, ?, ?, ?, 'queued', ?, 1)`)
    .run(p.contest_id, p.id, language, source, nowIso());
  judge.enqueue(Number(r.lastInsertRowid));
  res.json({ id: Number(r.lastInsertRowid) });
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
function parseTest(t) {
  return {
    input: str(t.input, { max: 20 * 1024 * 1024, name: 'Input', trim: false }),
    expected_output: str(t.expected_output, { max: 20 * 1024 * 1024, name: 'Expected output', trim: false }),
    is_example: bool(t.is_example) ? 1 : 0,
  };
}

router.post('/problems/:pid/tests', (req, res) => {
  const p = problemRow(req.params.pid);
  const list = Array.isArray(req.body?.tests) ? req.body.tests : [req.body || {}];
  if (!list.length) throw bad('No tests given.');
  const ids = transaction(() => {
    let ord = (db.prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM tests WHERE problem_id = ?').get(p.id).m) + 1;
    return list.map((raw) => {
      const t = parseTest(raw);
      return Number(db.prepare('INSERT INTO tests (problem_id, ord, input, expected_output, is_example) VALUES (?, ?, ?, ?, ?)').run(p.id, ord++, t.input, t.expected_output, t.is_example).lastInsertRowid);
    });
  });
  res.json({ ids });
});

router.put('/tests/:tid', (req, res) => {
  const existing = db.prepare('SELECT * FROM tests WHERE id = ?').get(Number(req.params.tid));
  if (!existing) throw new HttpError(404, 'Test not found.');
  const t = parseTest({ ...existing, ...(req.body || {}) });
  db.prepare('UPDATE tests SET input = ?, expected_output = ?, is_example = ? WHERE id = ?').run(t.input, t.expected_output, t.is_example, existing.id);
  res.json(db.prepare('SELECT * FROM tests WHERE id = ?').get(existing.id));
});

router.delete('/tests/:tid', (req, res) => {
  db.prepare('DELETE FROM tests WHERE id = ?').run(Number(req.params.tid));
  res.json({ ok: true });
});

router.post('/problems/:pid/tests/reorder', (req, res) => {
  const p = problemRow(req.params.pid);
  const order = Array.isArray(req.body?.order) ? req.body.order.map(Number) : [];
  transaction(() => { order.forEach((tid, i) => db.prepare('UPDATE tests SET ord = ? WHERE id = ? AND problem_id = ?').run(i, tid, p.id)); });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
router.get('/users', (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const rows = db.prepare(`SELECT u.id, u.username, u.full_name, u.email, u.pl_number, u.created_at,
    (SELECT COUNT(*) FROM submissions s WHERE s.user_id = u.id) AS submission_count,
    (SELECT COUNT(*) FROM contest_entries e WHERE e.user_id = u.id) AS contest_count
    FROM users u WHERE u.username LIKE ? OR u.full_name LIKE ? OR u.email LIKE ? OR u.pl_number LIKE ? ORDER BY u.id DESC LIMIT 2000`).all(q, q, q, q);
  res.json({ users: rows });
});

router.put('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) throw new HttpError(404, 'User not found.');
  const b = req.body || {};
  const full_name = str(b.full_name ?? u.full_name, { min: 1, max: 100, name: 'Full name' });
  const username = str(b.username ?? u.username, { min: 3, max: 32, name: 'Username' });
  if (!USERNAME_RE.test(username)) throw bad('Invalid username.');
  const email = str(b.email ?? u.email, { min: 3, max: 200, name: 'Email' }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad('Invalid email.');
  const pl_number = str(b.pl_number ?? u.pl_number, { min: 1, max: 50, name: 'PL number' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, u.id)) throw new HttpError(409, 'Another account uses this email.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, u.id)) throw new HttpError(409, 'This username is taken.');
  const hash = b.new_password ? auth.hashPassword(str(b.new_password, { min: 6, max: 200, name: 'New password', trim: false })) : u.password_hash;
  db.prepare('UPDATE users SET full_name = ?, username = ?, email = ?, pl_number = ?, password_hash = ? WHERE id = ?').run(full_name, username, email, pl_number, hash, u.id);
  res.json(db.prepare('SELECT id, username, full_name, email, pl_number, created_at FROM users WHERE id = ?').get(u.id));
});

// Deleting a user permanently deletes their submissions and contest entries.
router.delete('/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// submissions
// ---------------------------------------------------------------------------
const SUB_SELECT = `SELECT s.id, s.user_id, s.contest_id, s.problem_id, s.language, s.status, s.verdict, s.failed_test, s.tests_passed, s.tests_total,
  s.time_ms, s.memory_kb, s.submitted_at, s.judged_at, s.invalidated, s.admin_test, u.username, u.full_name, p.title AS problem_title, p.ord AS problem_ord,
  c.name AS contest_name FROM submissions s LEFT JOIN users u ON u.id = s.user_id JOIN problems p ON p.id = s.problem_id JOIN contests c ON c.id = s.contest_id`;

function labelFor(problemId) {
  const p = db.prepare('SELECT contest_id FROM problems WHERE id = ?').get(problemId);
  if (!p) return '?';
  const all = db.prepare('SELECT id FROM problems WHERE contest_id = ? ORDER BY ord, id').all(p.contest_id);
  return problemLabel(all.findIndex((x) => x.id === problemId));
}

router.get('/submissions', (req, res) => {
  const where = [], params = [];
  if (req.query.contest) { where.push('s.contest_id = ?'); params.push(Number(req.query.contest)); }
  if (req.query.problem) { where.push('s.problem_id = ?'); params.push(Number(req.query.problem)); }
  if (req.query.user) { where.push('s.user_id = ?'); params.push(Number(req.query.user)); }
  if (req.query.verdict) { where.push('s.verdict = ?'); params.push(String(req.query.verdict)); }
  if (req.query.q) { where.push('(u.username LIKE ? OR u.full_name LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const page = Math.max(0, Number(req.query.page || 0)), limit = 100;
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM submissions s LEFT JOIN users u ON u.id = s.user_id ${w}`).get(...params).n;
  const rows = db.prepare(`${SUB_SELECT} ${w} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...params, limit, page * limit)
    .map((s) => ({ ...s, label: labelFor(s.problem_id), verdict_name: s.verdict ? VERDICTS[s.verdict] : null, language_name: langName(s.language) }));
  res.json({ total, page, limit, submissions: rows });
});

router.get('/submissions/:id', (req, res) => {
  const s = db.prepare(`${SUB_SELECT.replace('SELECT s.id,', 'SELECT s.source, s.compile_output, s.judge_log, s.id,')} WHERE s.id = ?`).get(Number(req.params.id));
  if (!s) throw new HttpError(404, 'Submission not found.');
  res.json({ ...s, label: labelFor(s.problem_id), verdict_name: s.verdict ? VERDICTS[s.verdict] : null, language_name: langName(s.language),
    tests: s.judge_log ? JSON.parse(s.judge_log) : [] });
});

router.post('/submissions/:id/rejudge', (req, res) => {
  const s = db.prepare('SELECT id FROM submissions WHERE id = ?').get(Number(req.params.id));
  if (!s) throw new HttpError(404, 'Submission not found.');
  judge.requeue(s.id);
  res.json({ ok: true });
});

router.post('/submissions/:id/invalidate', (req, res) => {
  const s = db.prepare('SELECT id FROM submissions WHERE id = ?').get(Number(req.params.id));
  if (!s) throw new HttpError(404, 'Submission not found.');
  db.prepare('UPDATE submissions SET invalidated = ? WHERE id = ?').run(bool(req.body?.invalidated) ? 1 : 0, s.id);
  res.json({ ok: true });
});

router.delete('/submissions/:id', (req, res) => {
  db.prepare('DELETE FROM submissions WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
