// Commissioner PIN rules, shared by the UI (unlock pad, create-trip form, change PIN) and the
// server (trip creation, PIN change), so a PIN the app accepts can always be typed on the pad.
// Pure: safe to import from client and server code.

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 12;

/** A valid new PIN: 4 to 12 digits. */
export const PIN_RE = new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`);

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_RE.test(pin);
}
