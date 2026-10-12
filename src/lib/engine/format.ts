/** 0 -> "E", 3 -> "+3", -2 -> "-2" */
export function formatToPar(n: number): string {
  void n;
  throw new Error("not implemented");
}

/** 1250 -> "$12.50"; 1200 -> "$12"; -500 -> "-$5" */
export function formatCents(cents: number): string {
  void cents;
  throw new Error("not implemented");
}

/** 12.5 -> `12' 6"`; 0.75 -> `9"` (rounded to the nearest inch) */
export function formatFeetInches(feet: number): string {
  void feet;
  throw new Error("not implemented");
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 23 -> "23rd" */
export function ordinal(n: number): string {
  void n;
  throw new Error("not implemented");
}
