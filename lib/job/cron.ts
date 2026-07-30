/**
 * A minimal standard-cron matcher for {@link Job.queue}'s recurring jobs — five fields
 * `minute hour day-of-month month day-of-week`, each supporting a star, a number, a `a-b` range, a
 * `,` list, and a `/n` step (e.g. `9-17/2`, or a star-slash-15 for every 15 minutes). Evaluated in
 * **UTC** (so a server's timezone can't shift a schedule), the common convention for backend work.
 *
 * ```ts
 * cronMatch('30 9 * * *', new Date('2020-01-02T09:30:00Z')); // true — 09:30 UTC daily
 * cronMatch('30 9 * * *', new Date('2020-01-02T09:31:00Z')); // false
 * cronMatch(['*' + '/15', '*', '*', '*', '*'].join(' '), new Date('2020-01-02T09:45:00Z')); // true
 * ```
 */
export function cronMatch(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`invalid cron expression: "${expr}"`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  return (
    matchField(minute, date.getUTCMinutes(), 0, 59) &&
    matchField(hour, date.getUTCHours(), 0, 23) &&
    matchField(dayOfMonth, date.getUTCDate(), 1, 31) &&
    matchField(month, date.getUTCMonth() + 1, 1, 12) &&
    matchField(dayOfWeek, date.getUTCDay(), 0, 6)
  );
}

// One field: any comma-part matches. A part is `*` | `n` | `a-b`, each optionally `/step`.
function matchField(spec: string, value: number, min: number, max: number): boolean {
  for (const part of spec.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      lo = hi = Number(range);
    }
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
  }
  return false;
}
