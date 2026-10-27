'use strict';
// Leaderboards.
//
//  short    : most solves first; tie-break = earlier time of last accepted submission.
//  long     : ICPC style. Most solves first, then lowest penalty. Penalty = for each
//             solved problem, minutes from contest start to the accepted submission,
//             plus `penalty_per_wrong` for every rejected attempt before it (CE ignored).
//  adaptive : each problem is worth `points` at the start and loses `decay_per_minute`
//             every full minute (never below 0); optionally `wrong_penalty_pts` is
//             subtracted per rejected attempt. Highest total first, then earlier last AC.
//
// Everyone who entered the contest appears, even with no submissions. Submissions
// after a problem is solved, invalidated submissions and admin test runs never count.
const { db } = require('./db');
const { problemLabel } = require('./util');

function pointsAt(problem, contest, elapsedMs, wrongAttempts = 0) {
  const minutes = Math.max(0, Math.floor(elapsedMs / 60000));
  const pts = problem.points - contest.decay_per_minute * minutes - contest.wrong_penalty_pts * wrongAttempts;
  return Math.max(0, Math.round(pts * 100) / 100);
}

function computeStandings(contest) {
  const problems = db.prepare('SELECT id, title, points FROM problems WHERE contest_id = ? ORDER BY ord, id').all(contest.id)
    .map((p, i) => ({ ...p, label: problemLabel(i) }));
  const byProblem = new Map(problems.map((p) => [p.id, p]));
  const start = Date.parse(contest.start_at);
  const type = contest.leaderboard_type;
  const participants = new Map();

  const getP = (u) => {
    let p = participants.get(u.user_id);
    if (!p) {
      p = { user_id: u.user_id, username: u.username, full_name: u.full_name, cells: {}, solves: 0, penalty: 0, points: 0, last_ac: null };
      participants.set(u.user_id, p);
    }
    return p;
  };

  for (const e of db.prepare('SELECT e.user_id, u.username, u.full_name FROM contest_entries e JOIN users u ON u.id = e.user_id WHERE e.contest_id = ?').all(contest.id)) getP(e);

  const subs = db.prepare(`SELECT s.id, s.user_id, s.problem_id, s.status, s.verdict, s.submitted_at, u.username, u.full_name
    FROM submissions s JOIN users u ON u.id = s.user_id
    WHERE s.contest_id = ? AND s.invalidated = 0 AND s.admin_test = 0 ORDER BY s.submitted_at ASC, s.id ASC`).all(contest.id);

  for (const s of subs) {
    if (!byProblem.has(s.problem_id)) continue;
    const p = getP(s);
    const cell = p.cells[s.problem_id] || (p.cells[s.problem_id] = { attempts: 0, pending: 0, solved: false, time_s: null, points: 0 });
    if (cell.solved) continue;
    if (s.status !== 'done') { cell.pending++; continue; }
    if (s.verdict === 'CE' || s.verdict === 'IE') continue;
    if (s.verdict === 'AC') {
      cell.solved = true;
      cell.time_s = Math.max(0, Math.floor((Date.parse(s.submitted_at) - start) / 1000));
      if (type === 'adaptive') cell.points = pointsAt(byProblem.get(s.problem_id), contest, cell.time_s * 1000, cell.attempts);
    } else cell.attempts++;
  }

  for (const p of participants.values()) {
    for (const [pid, cell] of Object.entries(p.cells)) {
      if (!cell.solved) continue;
      p.solves++;
      p.last_ac = p.last_ac == null ? cell.time_s : Math.max(p.last_ac, cell.time_s);
      p.penalty += Math.floor(cell.time_s / 60) + cell.attempts * contest.penalty_per_wrong;
      p.points += cell.points;
      void pid;
    }
    p.points = Math.round(p.points * 100) / 100;
  }

  const rows = [...participants.values()];
  const byLast = (a, b) => (a.last_ac ?? Infinity) - (b.last_ac ?? Infinity);
  const byName = (a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' });
  const cmp = {
    short: (a, b) => b.solves - a.solves || byLast(a, b) || byName(a, b),
    long: (a, b) => b.solves - a.solves || a.penalty - b.penalty || byLast(a, b) || byName(a, b),
    adaptive: (a, b) => b.points - a.points || byLast(a, b) || byName(a, b),
  }[type] || ((a, b) => b.solves - a.solves || byLast(a, b) || byName(a, b));
  rows.sort(cmp);

  // Competition ranking: equal scores share a rank (1, 1, 3, ...).
  const sameScore = (a, b) => type === 'adaptive' ? a.points === b.points && a.last_ac === b.last_ac
    : type === 'long' ? a.solves === b.solves && a.penalty === b.penalty && a.last_ac === b.last_ac
      : a.solves === b.solves && a.last_ac === b.last_ac;
  rows.forEach((r, i) => { r.rank = i > 0 && sameScore(rows[i - 1], r) ? rows[i - 1].rank : i + 1; });

  return { type, problems, rows };
}

function standingsCsv(st) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['rank', 'username', 'full_name', 'solves', st.type === 'long' ? 'penalty' : st.type === 'adaptive' ? 'points' : 'last_ac_seconds',
    ...st.problems.map((p) => p.label)];
  const lines = [head.map(esc).join(',')];
  for (const r of st.rows) {
    const score = st.type === 'long' ? r.penalty : st.type === 'adaptive' ? r.points : (r.last_ac ?? '');
    const cells = st.problems.map((p) => {
      const c = r.cells[p.id];
      if (!c) return '';
      if (c.solved) return st.type === 'adaptive' ? `${c.points} (${c.time_s}s${c.attempts ? `, ${c.attempts} wrong` : ''})` : `+${c.attempts || ''} (${c.time_s}s)`;
      return c.attempts ? `-${c.attempts}` : '';
    });
    lines.push([r.rank, r.username, r.full_name, r.solves, score, ...cells].map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = { computeStandings, standingsCsv, pointsAt };
