// Time-zone helpers shared by the server (require) and the browser (window.TZ).
// Contest times are stored in UTC; admins type them in the contest's own time zone.
(function (root) {
  function isValidZone(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
  }

  // Offset (ms) of time zone `tz` from UTC at the given UTC instant.
  function offsetMs(utcMs, tz) {
    var dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    var p = {};
    dtf.formatToParts(new Date(utcMs)).forEach(function (x) { p[x.type] = x.value; });
    var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  }

  // "YYYY-MM-DDTHH:mm" (wall-clock time in `tz`) -> UTC milliseconds. Returns NaN if invalid.
  function zonedToUtc(local, tz) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(local || ''));
    if (!m || !isValidZone(tz)) return NaN;
    var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +(m[6] || 0);
    var guess = Date.UTC(y, mo - 1, d, h, mi, s);
    var utc = guess;
    for (var i = 0; i < 3; i++) utc = guess - offsetMs(utc, tz);
    return utc;
  }

  // UTC milliseconds -> "YYYY-MM-DDTHH:mm" wall-clock time in `tz` (for <input type=datetime-local>).
  function utcToZonedInput(utcMs, tz) {
    var dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    var p = {};
    dtf.formatToParts(new Date(utcMs)).forEach(function (x) { p[x.type] = x.value; });
    var hour = p.hour === '24' ? '00' : p.hour;
    return p.year + '-' + p.month + '-' + p.day + 'T' + hour + ':' + p.minute;
  }

  // Human-readable date/time in a zone, e.g. "Oct 27, 2026, 6:00 PM EDT".
  function format(utcMs, tz, opts) {
    try {
      return new Intl.DateTimeFormat('en-US', Object.assign({
        timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
      }, opts || {})).format(new Date(utcMs));
    } catch { return new Date(utcMs).toISOString(); }
  }

  function localZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  }

  var api = { isValidZone: isValidZone, offsetMs: offsetMs, zonedToUtc: zonedToUtc, utcToZonedInput: utcToZonedInput, format: format, localZone: localZone };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TZ = api;
})(typeof window !== 'undefined' ? window : globalThis);
