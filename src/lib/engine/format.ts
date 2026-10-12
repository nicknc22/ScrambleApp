// Display formatting shared by every screen. Pure and locale-independent.

/** 0 -> "E", 3 -> "+3", -2 -> "-2" */
export function formatToPar(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "E";
  return n > 0 ? `+${n}` : String(n);
}

/** Groups digits with commas: 1234567 -> "1,234,567". */
function withCommas(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 1250 -> "$12.50"; 1200 -> "$12"; -500 -> "-$5" */
export function formatCents(cents: number): string {
  const c = Number.isFinite(cents) ? Math.round(cents) : 0;
  const abs = Math.abs(c);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const body = rem === 0 ? withCommas(dollars) : `${withCommas(dollars)}.${String(rem).padStart(2, "0")}`;
  return c < 0 ? `-$${body}` : `$${body}`;
}

/** 12.5 -> `12' 6"`; 0.75 -> `9"` (rounded to the nearest inch) */
export function formatFeetInches(feet: number): string {
  const totalInches = Number.isFinite(feet) ? Math.max(0, Math.round(feet * 12)) : 0;
  const ft = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return ft === 0 ? `${inches}"` : `${ft}' ${inches}"`;
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 23 -> "23rd" */
export function ordinal(n: number): string {
  const abs = Math.abs(Math.trunc(n));
  const lastTwo = abs % 100;
  let suffix = "th";
  if (lastTwo < 11 || lastTwo > 13) {
    const last = abs % 10;
    if (last === 1) suffix = "st";
    else if (last === 2) suffix = "nd";
    else if (last === 3) suffix = "rd";
  }
  return `${Math.trunc(n)}${suffix}`;
}
