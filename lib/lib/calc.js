// Aviqo trusted calculation engine. Pure arithmetic only: no eval, no network, no model.
// Every result carries its formula, units and assumptions so the answer can show them.

export class CalcError extends Error {}

function num(x, name) {
  const n = typeof x === 'string' ? Number(x.replace(/,/g, '')) : x;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new CalcError(name + ' must be a finite number');
  return n;
}

function round(n, d = 4) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

export function percentChange(from, to) {
  const a = num(from, 'Starting value'), b = num(to, 'Ending value');
  if (a === 0) throw new CalcError('A percentage change cannot be calculated from zero');
  return {
    value: round(((b - a) / Math.abs(a)) * 100),
    formula: '(end - start) / |start| x 100',
    units: '%',
    assumptions: ['Start value is the base of the change']
  };
}

export function percentOf(percent, base) {
  const p = num(percent, 'Percentage'), x = num(base, 'Base value');
  return { value: round((p / 100) * x), formula: 'percent / 100 x base', units: 'same as base', assumptions: [] };
}

export function cagr(begin, end, years) {
  const b = num(begin, 'Beginning value'), e = num(end, 'Ending value'), y = num(years, 'Number of years');
  if (b <= 0 || e <= 0) throw new CalcError('CAGR needs positive beginning and ending values');
  if (y <= 0) throw new CalcError('CAGR needs more than zero years');
  return {
    value: round((Math.pow(e / b, 1 / y) - 1) * 100),
    formula: '((end / begin)^(1 / years) - 1) x 100',
    units: '% per year',
    assumptions: ['Growth is compounded once per year', 'Years = end year minus start year']
  };
}

// Units are grouped so only like units are converted (length to length, never length to mass).
const UNIT_GROUPS = {
  length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254 },
  mass: { kg: 1, g: 0.001, t: 1000, lb: 0.45359237, oz: 0.028349523125 },
  volume: { l: 1, ml: 0.001, gal: 3.785411784 },
  data: { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1048576, GiB: 1073741824, TiB: 1099511627776 }
};
const TEMP_UNITS = ['C', 'F', 'K'];

export function convertUnits(value, from, to) {
  const v = num(value, 'Value');
  if (TEMP_UNITS.includes(from) && TEMP_UNITS.includes(to)) {
    const toC = from === 'C' ? v : from === 'F' ? (v - 32) * 5 / 9 : v - 273.15;
    const out = to === 'C' ? toC : to === 'F' ? toC * 9 / 5 + 32 : toC + 273.15;
    return { value: round(out), formula: 'temperature scale conversion', units: to, assumptions: [] };
  }
  for (const [group, table] of Object.entries(UNIT_GROUPS)) {
    if (from in table && to in table) {
      return {
        value: round((v * table[from]) / table[to]),
        formula: 'value x (factor of ' + from + ' / factor of ' + to + ')',
        units: to,
        assumptions: group === 'data' && (from.endsWith('iB') || to.endsWith('iB')) ? ['Binary units (KiB = 1024 B) are used'] : ['Decimal factors, not rounded before conversion']
      };
    }
  }
  throw new CalcError('Cannot convert ' + from + ' to ' + to + ': the units are not the same kind');
}

// Currency needs a rate supplied by the caller. Without one the engine refuses instead of guessing.
export function convertCurrency(amount, rate, from, to) {
  const a = num(amount, 'Amount');
  if (rate === undefined || rate === null || rate === '') {
    throw new CalcError('No exchange rate was provided, so ' + from + ' to ' + to + ' cannot be calculated');
  }
  const r = num(rate, 'Exchange rate');
  if (r <= 0) throw new CalcError('Exchange rate must be positive');
  return {
    value: round(a * r),
    formula: 'amount x rate (' + to + ' per 1 ' + from + ')',
    units: to,
    assumptions: ['Rate is the one supplied with the question, not a live rate', 'Rate date and source must be stated with the result']
  };
}

export function stats(values) {
  const xs = (Array.isArray(values) ? values : []).map((x, i) => num(x, 'Value ' + (i + 1)));
  if (!xs.length) throw new CalcError('Statistics need at least one value');
  const sorted = xs.slice().sort((a, b) => a - b);
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const stdev = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  return {
    value: { n, mean: round(mean), median: round(median), min: sorted[0], max: sorted[n - 1], stdev: stdev === null ? null : round(stdev) },
    formula: 'mean, median, sample standard deviation (n - 1)',
    units: 'same as input',
    assumptions: n > 1 ? [] : ['Only one value: standard deviation is not defined']
  };
}
