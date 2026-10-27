'use strict';
const TZ = require('../public/tz.js');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

const str = (v, { min = 0, max = 1000, name = 'value', trim = true } = {}) => {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(`${name} must be text.`);
  if (trim) v = v.trim();
  if (v.length < min) throw bad(min === 1 ? `${name} is required.` : `${name} must be at least ${min} characters.`);
  if (v.length > max) throw bad(`${name} must be at most ${max} characters.`);
  return v;
};
const num = (v, { min = -Infinity, max = Infinity, name = 'value', integer = false, def } = {}) => {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${name} must be a number.`);
  if (integer && !Number.isInteger(n)) throw bad(`${name} must be a whole number.`);
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}.`);
  return n;
};
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

function contestStatus(contest, now = Date.now()) {
  const s = Date.parse(contest.start_at), e = Date.parse(contest.end_at);
  if (now < s) return 'upcoming';
  if (now < e) return 'running';
  return 'ended';
}

function problemLabel(index) { // 0 -> A, 25 -> Z, 26 -> AA
  let s = '', i = index;
  do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
  return s;
}

const LANGUAGES = {
  cpp: { name: 'C++17 (g++)', ext: 'cpp' },
  python: { name: 'Python 3', ext: 'py' },
  java: { name: 'Java 21', ext: 'java' },
};

const VERDICTS = {
  AC: 'Accepted', WA: 'Wrong Answer', CE: 'Compilation Error', RE: 'Runtime Error',
  TLE: 'Time Limit Exceeded', MLE: 'Memory Limit Exceeded', IE: 'Judge Error',
};

module.exports = { HttpError, bad, str, num, bool, EMAIL_RE, USERNAME_RE, contestStatus, problemLabel, LANGUAGES, VERDICTS, TZ };
