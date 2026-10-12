// Id helpers shared by client and server.
import type { UUID } from "./types";

/** Random v4 uuid (crypto.randomUUID). */
export function newId(): UUID {
  void 0;
  throw new Error("not implemented");
}

/**
 * Deterministic uuid-formatted id from string parts (so the client's optimistic row and the
 * server's row get the same id when both derive it from the same op). Not cryptographic.
 */
export function deriveId(...parts: string[]): UUID {
  void parts;
  throw new Error("not implemented");
}

/** Unguessable trip code: 10 chars from "abcdefghjkmnpqrstuvwxyz23456789" via crypto.getRandomValues. */
export function newTripCode(): string {
  throw new Error("not implemented");
}
