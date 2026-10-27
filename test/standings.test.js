'use strict';
process.env.DATA_DIR = require('os').tmpdir() + '/miniforces-test-st-' + process.pid;
const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const { computeStandings, pointsAt } = require('../src/standings');

function setup(type, extra = {}) {
  const start = Date.parse('2026-01-01T10:00:00Z');
  const c = db.prepare(`INSERT INTO contests (name, start_at, end_at, visible, leaderboard_type, penalty_per_wrong, decay_per_minute, wrong_penalty_pts, created_at)
    VALUES ('c', '2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z', 1, ?, ?, ?, ?, 'x')`)
    .run(type, extra.penalty ?? 10, extra.decay ?? 2, extra.wrongPts ?? 0).lastInsertRowid;
  const pA = db.prepare("INSERT INTO problems (contest_id, ord, title, points, created_at) VALUES (?, 0, 'A', 100, 'x')").run(c).lastInsertRowid;
  const pB = db.prepare("INSERT INTO problems (contest_id, ord, title, points, created_at) VALUES (?, 1, 'B', 200, 'x')").run(c).lastInsertRowid;
  const users = {};
  for (const name of ['ann', 'bob', 'cat', 'dan']) {
    users[name] = db.prepare("INSERT INTO users (username, full_name, email, pl_number, password_hash, created_at) VALUES (?, ?, ?, '1', 'h', 'x')")
      .run(name + c, name, name + c + '@x.com').lastInsertRowid;
    db.prepare('INSERT INTO contest_entries (user_id, contest_id, entered_at) VALUES (?, ?, ?)').run(users[name], c, 'x');
  }
  const sub = (user, prob, minute, verdict, opts = {}) => db.prepare(`INSERT INTO submissions (user_id, contest_id, problem_id, language, source, status, verdict, submitted_at, invalidated, admin_test)
    VALUES (?, ?, ?, 'cpp', '', 'done', ?, ?, ?, ?)`).run(users[user], c, prob === 'A' ? pA : pB, verdict, new Date(start + minute * 60000).toISOString(), opts.invalid ? 1 : 0, opts.admin ? 1 : 0);
  return { contest: db.prepare('SELECT * FROM contests WHERE id = ?').get(c), sub, pA, pB };
}

test('short leaderboard', () => {
  const { contest, sub } = setup('short');
  sub('ann', 'A', 10, 'AC'); sub('ann', 'B', 50, 'AC');      // 2 solves, last 50
  sub('bob', 'A', 5, 'WA'); sub('bob', 'A', 20, 'AC'); sub('bob', 'B', 40, 'AC'); // 2 solves, last 40 -> first
  sub('cat', 'A', 3, 'AC'); sub('cat', 'A', 4, 'AC');       // 1 solve (second AC ignored)
  sub('dan', 'A', 1, 'WA', { invalid: false }); sub('dan', 'B', 2, 'AC', { invalid: true }); // 0 solves
  const st = computeStandings(contest);
  assert.deepStrictEqual(st.rows.map((r) => [r.rank, r.full_name, r.solves]), [[1, 'bob', 2], [2, 'ann', 2], [3, 'cat', 1], [4, 'dan', 0]]);
  assert.strictEqual(st.rows[3].cells[st.problems[0].id].attempts, 1);
});

test('long leaderboard with penalties', () => {
  const { contest, sub } = setup('long', { penalty: 10 });
  sub('ann', 'A', 10, 'AC'); sub('ann', 'B', 50, 'AC');                       // penalty 60
  sub('bob', 'A', 5, 'WA'); sub('bob', 'A', 6, 'CE'); sub('bob', 'A', 20, 'AC'); sub('bob', 'B', 25, 'AC'); // 20+10 + 25 = 55 (CE ignored)
  sub('cat', 'B', 1, 'WA'); sub('cat', 'B', 2, 'WA');                         // unsolved wrong attempts: no penalty
  sub('cat', 'A', 30, 'AC');                                                   // 30
  const st = computeStandings(contest);
  assert.deepStrictEqual(st.rows.map((r) => [r.full_name, r.solves, r.penalty]), [['bob', 2, 55], ['ann', 2, 60], ['cat', 1, 30], ['dan', 0, 0]]);
});

test('adaptive leaderboard', () => {
  const { contest, sub } = setup('adaptive', { decay: 2, wrongPts: 5 });
  // A worth 100 - 2/min, B worth 200 - 2/min
  sub('ann', 'A', 10, 'AC');                               // 80
  sub('bob', 'B', 30, 'WA'); sub('bob', 'B', 40, 'AC');    // 200 - 80 - 5 = 115
  sub('cat', 'A', 100, 'AC');                              // 0 (floored)
  const st = computeStandings(contest);
  assert.deepStrictEqual(st.rows.map((r) => [r.full_name, r.points]), [['bob', 115], ['ann', 80], ['cat', 0], ['dan', 0]]);
  assert.strictEqual(pointsAt({ points: 100 }, contest, 61 * 60000), 0);
  assert.strictEqual(pointsAt({ points: 100 }, contest, 30.9 * 60000), 100 - 2 * 30);
});
