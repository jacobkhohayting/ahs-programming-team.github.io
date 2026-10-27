'use strict';
const express = require('express');
const config = require('../config');
const { db, nowIso } = require('../db');
const auth = require('../auth');
const judge = require('../judge');
const { computeStandings, standingsCsv, pointsAt } = require('../standings');
const { HttpError, bad, str, num, EMAIL_RE, USERNAME_RE, contestStatus, problemLabel, LANGUAGES, VERDICTS } = require('../util');
const langName = (k) => (judge.getLanguages()[k] || LANGUAGES[k] || {}).name || k;

const router = express.Router();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function publicUser(u) {
  return u ? { id: u.id, username: u.username, full_name: u.full_name, email: u.email, pl_number: u.pl_number, created_at: u.created_at } : null;
}

function serializeContest(c, extra = {}) {
  const status = contestStatus(c);
  return {
    id: c.id, name: c.name, description: c.description, start_at: c.start_at, end_at: c.end_at, timezone: c.timezone,
    duration_min: Math.round((Date.parse(c.end_at) - Date.parse(c.start_at)) / 60000), status, visible: !!c.visible,
    leaderboard_type: c.leaderboard_type, penalty_per_wrong: c.penalty_per_wrong, decay_per_minute: c.decay_per_minute,
    wrong_penalty_pts: c.wrong_penalty_pts, show_code_after: !!c.show_code_after, show_editorial: !!c.show_editorial,
    ...extra,
  };
}

// Loads a contest the viewer is allowed to know about (hidden contests are invisible to non-admins).
function loadContest(req, id) {
  const c = db.prepare('SELECT * FROM contests WHERE id = ?').get(Number(id));
  if (!c || (!c.visible && !req.isAdmin)) throw new HttpError(404, 'Contest not found.');
  return c;
}

// Problems are visible once the contest has started. During the contest you need an account.
function assertCanViewProblems(req, c) {
  const status = contestStatus(c);
  if (req.isAdmin) return status;
  if (status === 'upcoming') throw new HttpError(403, 'This contest has not started yet.');
  if (status === 'running' && !req.user) throw new HttpError(401, 'Log in to enter this contest.');
  return status;
}

function recordEntry(req, c) {
  if (req.user && contestStatus(c) === 'running') {
    db.prepare('INSERT OR IGNORE INTO contest_entries (user_id, contest_id, entered_at) VALUES (?, ?, ?)').run(req.user.id, c.id, nowIso());
  }
}

function problemsOf(contestId) {
  return db.prepare('SELECT * FROM problems WHERE contest_id = ? ORDER BY ord, id').all(contestId).map((p, i) => ({ ...p, label: problemLabel(i) }));
}

function canViewCode(req, sub, contest) {
  if (req.isAdmin) return true;
  if (req.user && sub.user_id === req.user.id) return true;
  return contestStatus(contest) === 'ended' && !!contest.show_code_after && !sub.admin_test;
}

function serializeSubmission(s, req, contest, labels) {
  return {
    id: s.id, user: s.user_id ? { id: s.user_id, username: s.username, full_name: s.full_name } : null,
    problem: { id: s.problem_id, label: labels.get(s.problem_id) || '?', title: s.problem_title },
    contest_id: s.contest_id, language: s.language, language_name: langName(s.language),
    status: s.status, verdict: s.verdict, verdict_name: s.verdict ? VERDICTS[s.verdict] : null,
    failed_test: s.failed_test, tests_passed: s.tests_passed, tests_total: s.tests_total,
    time_ms: s.time_ms, memory_kb: s.memory_kb, submitted_at: s.submitted_at, judged_at: s.judged_at,
    invalidated: !!s.invalidated, can_view_code: canViewCode(req, s, contest),
  };
}

const SUB_SELECT = `SELECT s.*, u.username, u.full_name, p.title AS problem_title FROM submissions s
  LEFT JOIN users u ON u.id = s.user_id JOIN problems p ON p.id = s.problem_id`;

// ---------------------------------------------------------------------------
// site / session
// ---------------------------------------------------------------------------
router.get('/site', (req, res) => {
  res.json({ name: config.siteName, now: Date.now(), languages: judge.getLanguages(), verdicts: VERDICTS, user: publicUser(req.user), isAdmin: req.isAdmin });
});
router.get('/time', (req, res) => res.json({ now: Date.now() }));

router.post('/register', (req, res) => {
  const b = req.body || {};
  const full_name = str(b.full_name, { min: 1, max: 100, name: 'Full name' });
  const username = str(b.username, { min: 3, max: 32, name: 'Username' });
  if (!USERNAME_RE.test(username)) throw bad('Username may only contain letters, numbers, dots, dashes and underscores (3-32 characters).');
  const email = str(b.email, { min: 3, max: 200, name: 'Email' }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad('Please enter a valid email address.');
  const pl_number = str(b.pl_number, { min: 1, max: 50, name: 'PL number' });
  const password = str(b.password, { min: 6, max: 200, name: 'Password', trim: false });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with this email already exists.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'This username is taken.');
  const r = db.prepare('INSERT INTO users (username, full_name, email, pl_number, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, full_name, email, pl_number, auth.hashPassword(password), nowIso());
  req.session.userId = Number(r.lastInsertRowid);
  req.saveSession();
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)) });
});

router.post('/login', (req, res) => {
  if (!auth.rateLimit('login:' + req.ip, 20, 15 * 60e3)) throw new HttpError(429, 'Too many login attempts. Try again in a few minutes.');
  const b = req.body || {};
  const login = str(b.login, { min: 1, max: 200, name: 'Username or email' });
  const password = String(b.password || '');
  const u = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login, login.toLowerCase());
  if (!u || !auth.verifyPassword(password, u.password_hash)) throw new HttpError(401, 'Wrong username/email or password.');
  req.session.userId = u.id;
  req.saveSession();
  res.json({ user: publicUser(u) });
});

router.post('/logout', (req, res) => {
  req.session.userId = null;
  req.saveSession();
  res.json({ ok: true });
});

router.get('/me', (req, res) => res.json({ user: publicUser(req.user), isAdmin: req.isAdmin }));

router.put('/me', auth.requireUser, (req, res) => {
  const b = req.body || {};
  const full_name = str(b.full_name, { min: 1, max: 100, name: 'Full name' });
  const username = str(b.username, { min: 3, max: 32, name: 'Username' });
  if (!USERNAME_RE.test(username)) throw bad('Username may only contain letters, numbers, dots, dashes and underscores (3-32 characters).');
  const email = str(b.email, { min: 3, max: 200, name: 'Email' }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad('Please enter a valid email address.');
  const pl_number = str(b.pl_number, { min: 1, max: 50, name: 'PL number' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, req.user.id)) throw new HttpError(409, 'Another account already uses this email.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, req.user.id)) throw new HttpError(409, 'This username is taken.');
  const full = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const current = String(b.current_password || '');
  if (!auth.verifyPassword(current, full.password_hash)) throw new HttpError(401, 'Your current password is incorrect.');
  let hash = full.password_hash;
  if (b.new_password) hash = auth.hashPassword(str(b.new_password, { min: 6, max: 200, name: 'New password', trim: false }));
  db.prepare('UPDATE users SET full_name = ?, username = ?, email = ?, pl_number = ?, password_hash = ? WHERE id = ?')
    .run(full_name, username, email, pl_number, hash, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// ---------------------------------------------------------------------------
// contests
// ---------------------------------------------------------------------------
router.get('/contests', (req, res) => {
  const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM problems p WHERE p.contest_id = c.id) AS problem_count,
    (SELECT COUNT(*) FROM contest_entries e WHERE e.contest_id = c.id) AS participant_count
    FROM contests c ${req.isAdmin ? '' : 'WHERE c.visible = 1'} ORDER BY c.start_at DESC, c.id DESC`).all();
  res.json({ now: Date.now(), contests: rows.map((c) => serializeContest(c, { problem_count: c.problem_count, participant_count: c.participant_count })) });
});

router.get('/archive', (req, res) => {
  const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM problems p WHERE p.contest_id = c.id) AS problem_count,
    (SELECT COUNT(*) FROM contest_entries e WHERE e.contest_id = c.id) AS participant_count
    FROM contests c WHERE c.visible = 1 AND c.end_at <= ? ORDER BY c.end_at DESC`).all(nowIso());
  res.json({ now: Date.now(), contests: rows.map((c) => serializeContest(c, { problem_count: c.problem_count, participant_count: c.participant_count })) });
});

router.get('/contests/:id', (req, res) => {
  const c = loadContest(req, req.params.id);
  const status = contestStatus(c);
  const out = serializeContest(c, { now: Date.now(), problems: null, entered: false,
    participant_count: db.prepare('SELECT COUNT(*) AS n FROM contest_entries WHERE contest_id = ?').get(c.id).n });
  if (req.user) out.entered = !!db.prepare('SELECT 1 FROM contest_entries WHERE user_id = ? AND contest_id = ?').get(req.user.id, c.id);
  const canView = req.isAdmin || status === 'ended' || (status === 'running' && req.user);
  if (canView) {
    const mine = req.user ? db.prepare(`SELECT problem_id, verdict, status FROM submissions WHERE user_id = ? AND contest_id = ? AND invalidated = 0`).all(req.user.id, c.id) : [];
    const solved = new Set(mine.filter((s) => s.verdict === 'AC').map((s) => s.problem_id));
    const attempted = new Set(mine.filter((s) => s.status === 'done' && s.verdict !== 'AC' && s.verdict !== 'CE').map((s) => s.problem_id));
    const solvers = new Map(db.prepare(`SELECT problem_id, COUNT(DISTINCT user_id) AS n FROM submissions WHERE contest_id = ? AND verdict = 'AC' AND invalidated = 0 AND admin_test = 0 GROUP BY problem_id`).all(c.id).map((r) => [r.problem_id, r.n]));
    const elapsed = Date.now() - Date.parse(c.start_at);
    out.problems = problemsOf(c.id).map((p) => ({
      id: p.id, label: p.label, title: p.title, time_limit_ms: p.time_limit_ms, memory_limit_mb: p.memory_limit_mb,
      points: p.points, current_points: c.leaderboard_type === 'adaptive' ? pointsAt(p, c, status === 'running' ? elapsed : status === 'upcoming' ? 0 : Infinity) : null,
      solved: solved.has(p.id), attempted: attempted.has(p.id), solver_count: solvers.get(p.id) || 0,
      has_tests: !!db.prepare('SELECT 1 FROM tests WHERE problem_id = ? LIMIT 1').get(p.id),
    }));
  }
  res.json(out);
});

router.post('/contests/:id/enter', auth.requireUser, (req, res) => {
  const c = loadContest(req, req.params.id);
  if (contestStatus(c) !== 'running') throw new HttpError(403, 'This contest is not running right now.');
  recordEntry(req, c);
  res.json({ ok: true });
});

router.get('/contests/:id/problems/:pid', (req, res) => {
  const c = loadContest(req, req.params.id);
  const status = assertCanViewProblems(req, c);
  const problems = problemsOf(c.id);
  const p = problems.find((x) => x.id === Number(req.params.pid));
  if (!p) throw new HttpError(404, 'Problem not found.');
  recordEntry(req, c);
  const examples = db.prepare('SELECT input, expected_output FROM tests WHERE problem_id = ? AND is_example = 1 ORDER BY ord, id').all(p.id);
  const testCount = db.prepare('SELECT COUNT(*) AS n FROM tests WHERE problem_id = ?').get(p.id).n;
  const out = {
    id: p.id, label: p.label, title: p.title, statement: p.statement, time_limit_ms: p.time_limit_ms, memory_limit_mb: p.memory_limit_mb,
    points: p.points, examples, test_count: testCount, contest: serializeContest(c), status,
    current_points: c.leaderboard_type === 'adaptive' ? pointsAt(p, c, status === 'running' ? Date.now() - Date.parse(c.start_at) : status === 'upcoming' ? 0 : Infinity) : null,
    all_problems: problems.map((x) => ({ id: x.id, label: x.label, title: x.title })),
    editorial: null, solution_code: null, solution_language: null,
  };
  if (status === 'ended' && c.show_editorial) { out.editorial = p.editorial; out.solution_code = p.solution_code; out.solution_language = p.solution_language; }
  if (req.user) {
    out.my_submissions = db.prepare('SELECT id, status, verdict, language, submitted_at, time_ms, memory_kb, failed_test FROM submissions WHERE user_id = ? AND problem_id = ? ORDER BY id DESC LIMIT 20').all(req.user.id, p.id)
      .map((s) => ({ ...s, verdict_name: s.verdict ? VERDICTS[s.verdict] : null, language_name: langName(s.language) }));
  }
  res.json(out);
});

const lastSubmit = new Map(); // user id -> timestamp (double-click protection)
router.post('/contests/:id/submit', auth.requireUser, (req, res) => {
  const c = loadContest(req, req.params.id);
  if (contestStatus(c) !== 'running') throw new HttpError(403, 'Submissions are only accepted while the contest is running.');
  const b = req.body || {};
  const problem_id = num(b.problem_id, { name: 'problem', integer: true });
  const p = db.prepare('SELECT * FROM problems WHERE id = ? AND contest_id = ?').get(problem_id, c.id);
  if (!p) throw new HttpError(404, 'Problem not found in this contest.');
  const language = String(b.language || '');
  if (!LANGUAGES[language]) throw bad('Choose a language: C++, Python or Java.');
  const source = String(b.source || '');
  if (!source.trim()) throw bad('Your code is empty.');
  if (Buffer.byteLength(source) > config.maxSourceBytes) throw bad(`Source code is too large (max ${config.maxSourceBytes / 1024} KB).`);
  if (!db.prepare('SELECT 1 FROM tests WHERE problem_id = ? LIMIT 1').get(p.id)) throw new HttpError(409, 'This problem has no tests yet - please tell an organizer.');
  const last = lastSubmit.get(req.user.id) || 0;
  if (Date.now() - last < config.submitCooldownMs) throw new HttpError(429, `Please wait ${Math.ceil(config.submitCooldownMs / 1000)} seconds between submissions.`);
  lastSubmit.set(req.user.id, Date.now());
  recordEntry(req, c);
  const r = db.prepare(`INSERT INTO submissions (user_id, contest_id, problem_id, language, source, status, submitted_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)`)
    .run(req.user.id, c.id, p.id, language, source, nowIso());
  judge.enqueue(Number(r.lastInsertRowid));
  res.json({ id: Number(r.lastInsertRowid) });
});

router.get('/contests/:id/submissions', (req, res) => {
  const c = loadContest(req, req.params.id);
  const mine = req.query.user === 'me';
  if (mine && !req.user) throw new HttpError(401, 'Log in to see your submissions.');
  if (!mine && contestStatus(c) === 'upcoming' && !req.isAdmin) throw new HttpError(403, 'The contest has not started yet.');
  const labels = new Map(problemsOf(c.id).map((p) => [p.id, p.label]));
  const page = Math.max(0, Number(req.query.page || 0));
  const limit = 100;
  const where = ['s.contest_id = ?', 's.admin_test = 0'];
  const params = [c.id];
  if (mine) { where.push('s.user_id = ?'); params.push(req.user.id); }
  if (req.query.problem) { where.push('s.problem_id = ?'); params.push(Number(req.query.problem)); }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM submissions s WHERE ${where.join(' AND ')}`).get(...params).n;
  const rows = db.prepare(`${SUB_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...params, limit, page * limit);
  res.json({ total, page, limit, submissions: rows.map((s) => serializeSubmission(s, req, c, labels)) });
});

router.get('/submissions/:id', (req, res) => {
  const s = db.prepare(`${SUB_SELECT} WHERE s.id = ?`).get(Number(req.params.id));
  if (!s || (s.admin_test && !req.isAdmin)) throw new HttpError(404, 'Submission not found.');
  const c = loadContest(req, s.contest_id);
  const labels = new Map(problemsOf(c.id).map((p) => [p.id, p.label]));
  const out = serializeSubmission(s, req, c, labels);
  out.contest = serializeContest(c);
  if (out.can_view_code) {
    out.source = s.source;
    out.compile_output = s.compile_output;
    out.tests = s.judge_log ? JSON.parse(s.judge_log) : [];
  } else {
    out.tests = s.judge_log ? JSON.parse(s.judge_log).map((t) => ({ test: t.test, verdict: t.verdict })) : [];
  }
  res.json(out);
});

router.get('/contests/:id/standings', (req, res) => {
  const c = loadContest(req, req.params.id);
  if (contestStatus(c) === 'upcoming' && !req.isAdmin) throw new HttpError(403, 'The contest has not started yet.');
  const st = computeStandings(c);
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="standings-${c.id}.csv"`);
    return res.send(standingsCsv(st));
  }
  res.json({ contest: serializeContest(c), now: Date.now(), me: req.user ? req.user.id : null, ...st });
});

router.get('/me/submissions', auth.requireUser, (req, res) => {
  const rows = db.prepare(`${SUB_SELECT} JOIN contests c ON c.id = s.contest_id WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 500`).all(req.user.id);
  const contests = new Map();
  const out = rows.map((s) => {
    if (!contests.has(s.contest_id)) {
      const c = db.prepare('SELECT * FROM contests WHERE id = ?').get(s.contest_id);
      contests.set(s.contest_id, { contest: c, labels: new Map(problemsOf(c.id).map((p) => [p.id, p.label])) });
    }
    const { contest, labels } = contests.get(s.contest_id);
    return { ...serializeSubmission(s, req, contest, labels), contest_name: contest.name };
  });
  res.json({ submissions: out });
});

module.exports = router;
