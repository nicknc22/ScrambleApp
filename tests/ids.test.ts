import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveId, murmur3x86_128, newId, newTripCode, TRIP_CODE_ALPHABET } from "@/lib/ids";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newId", () => {
  it("returns a lowercase v4 uuid", () => {
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(UUID_V4);
  });

  it("is unique", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId()));
    expect(ids.size).toBe(5000);
  });

  it("uses crypto.randomUUID when available", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", {
      randomUUID: () => "11111111-2222-4333-8444-555555555555",
      getRandomValues: real.getRandomValues.bind(real),
    });
    expect(newId()).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("falls back to getRandomValues when randomUUID is missing (old iOS over http)", () => {
    const real = globalThis.crypto;
    let calls = 0;
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends ArrayBufferView | null>(a: T) => {
        calls++;
        return real.getRandomValues(a as unknown as Uint8Array) as unknown as T;
      },
    });
    const ids = Array.from({ length: 200 }, () => newId());
    expect(calls).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(200);
  });

  it("sets version and variant bits even when the random bytes are all 0xff or 0x00", () => {
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => a.fill(0xff) });
    expect(newId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => a.fill(0) });
    expect(newId()).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("still works with no crypto at all", () => {
    vi.stubGlobal("crypto", undefined);
    const id = newId();
    expect(id).toMatch(UUID_V4);
  });
});

describe("murmur3x86_128", () => {
  // SMHasher's VerifyHash: hash keys {}, {0}, {0,1}, ... {0..254} with seed 256-i, hash the
  // concatenated little-endian outputs with seed 0, and take the first 32-bit word.
  it("matches the reference implementation (SMHasher verification 0xB3ECE62A)", () => {
    const key = new Uint8Array(256);
    const hashes = new Uint8Array(256 * 16);
    for (let i = 0; i < 256; i++) {
      key[i] = i;
      const h = murmur3x86_128(key.subarray(0, i), 256 - i);
      for (let w = 0; w < 4; w++) for (let b = 0; b < 4; b++) hashes[i * 16 + w * 4 + b] = (h[w] >>> (8 * b)) & 0xff;
    }
    expect(murmur3x86_128(hashes, 0)[0]).toBe(0xb3ece62a);
  });

  it("hashes the empty input with seed 0 to zero (reference behavior)", () => {
    expect(murmur3x86_128(new Uint8Array(0), 0)).toEqual([0, 0, 0, 0]);
  });
});

describe("deriveId", () => {
  it("is deterministic and uuid-formatted (v5, RFC 4122 variant)", () => {
    const a = deriveId("team-1", "5");
    expect(a).toMatch(UUID_V5);
    expect(deriveId("team-1", "5")).toBe(a);
  });

  it("is pinned: client and server builds must agree forever", () => {
    expect(deriveId()).toBe("cb24a82e-41d1-5a25-81d1-8a2541d18a25");
    expect(deriveId("")).toBe("24d5d1ca-2897-56fe-a897-96fe289796fe");
    expect(deriveId("a", "b")).toBe("7846dbe0-96f0-510d-9852-3ad2051a59fe");
    expect(deriveId("2f0c6b8e-6a4b-4f8e-9d2a-0b7c1e3f5a71", "7")).toBe("c5514da8-ad38-5977-a5d7-53bafd92cd15");
    expect(deriveId("🍺", "groom")).toBe("b8d0b07b-ead0-57df-b606-a1c0835ec96b");
  });

  it("never collides across part boundaries", () => {
    const groups: string[][] = [
      ["a", "bc"],
      ["ab", "c"],
      ["abc"],
      ["a", "b", "c"],
      ["a|b", "c"],
      ["a", "b|c"],
      ["", "abc"],
      ["abc", ""],
      [],
      [""],
      ["", ""],
      ["1", "23"],
      ["12", "3"],
    ];
    const ids = groups.map((g) => deriveId(...g));
    expect(new Set(ids).size).toBe(groups.length);
  });

  it("differs by order and by case", () => {
    expect(deriveId("x", "y")).not.toBe(deriveId("y", "x"));
    expect(deriveId("Team")).not.toBe(deriveId("team"));
  });

  it("produces no collisions over many realistic inputs and every free nibble varies", () => {
    const seen = new Set<string>();
    const nibbles: Array<Set<string>> = Array.from({ length: 36 }, () => new Set());
    for (let t = 0; t < 2000; t++) {
      const team = `9b1c${t.toString(16).padStart(4, "0")}-aaaa-4bbb-8ccc-0123456789ab`;
      for (let hole = 1; hole <= 18; hole++) {
        const id = deriveId(team, String(hole));
        expect(seen.has(id)).toBe(false);
        seen.add(id);
        for (let i = 0; i < 36; i++) nibbles[i].add(id[i]);
      }
    }
    expect(seen.size).toBe(36000);
    for (let i = 0; i < 36; i++) {
      if ([8, 13, 18, 23].includes(i)) expect([...nibbles[i]]).toEqual(["-"]);
      else if (i === 14) expect([...nibbles[i]]).toEqual(["5"]);
      else if (i === 19) expect([...nibbles[i]].sort()).toEqual(["8", "9", "a", "b"]);
      else expect(nibbles[i].size).toBe(16);
    }
  });

  it("handles unicode and long inputs", () => {
    const long = "x".repeat(10_000);
    expect(deriveId(long)).toMatch(UUID_V5);
    expect(deriveId(long)).not.toBe(deriveId(long + "x"));
    expect(deriveId("🍺")).not.toBe(deriveId("🍻"));
  });

  it("is a pure function (no crypto needed)", () => {
    const before = deriveId("op-1", "team-1");
    vi.stubGlobal("crypto", undefined);
    expect(deriveId("op-1", "team-1")).toBe(before);
  });
});

describe("newTripCode", () => {
  it("is 10 chars from the lookalike-free alphabet", () => {
    for (let i = 0; i < 500; i++) {
      const code = newTripCode();
      expect(code).toHaveLength(10);
      expect(code).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/);
    }
    expect(TRIP_CODE_ALPHABET).toBe("abcdefghjkmnpqrstuvwxyz23456789");
    expect(TRIP_CODE_ALPHABET).not.toMatch(/[01ilo]/);
  });

  it("is unique", () => {
    const codes = new Set(Array.from({ length: 5000 }, () => newTripCode()));
    expect(codes.size).toBe(5000);
  });

  it("rejection-samples: bytes >= 248 are skipped, others map to byte % 31", () => {
    // First buffer: every byte biased (>= 248) except a few; the generator must skip them.
    const buffers = [
      [255, 0, 248, 30, 249, 31, 250, 62, 251, 247, 252, 253, 254, 1, 2, 3, 4, 5, 6, 7],
      [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27],
    ];
    let call = 0;
    vi.stubGlobal("crypto", {
      getRandomValues: (a: Uint8Array) => {
        const src = buffers[call++] ?? [];
        for (let i = 0; i < a.length; i++) a[i] = src[i] ?? 0;
        return a;
      },
    });
    const A = TRIP_CODE_ALPHABET;
    // Accepted bytes in order: 0, 30, 31, 62, 247, 1, 2, 3, 4, 5 -> indexes 0, 30, 0, 0, 30, 1, 2, 3, 4, 5
    expect(newTripCode()).toBe([0, 30, 0, 0, 30, 1, 2, 3, 4, 5].map((i) => A[i]).join(""));
  });

  it("asks for more randomness when a whole buffer is rejected", () => {
    let call = 0;
    vi.stubGlobal("crypto", {
      getRandomValues: (a: Uint8Array) => {
        a.fill(call++ === 0 ? 255 : 3);
        return a;
      },
    });
    expect(newTripCode()).toBe(TRIP_CODE_ALPHABET[3].repeat(10));
    expect(call).toBe(2);
  });

  it("refuses to make a guessable code without crypto", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => newTripCode()).toThrow(/getRandomValues/);
  });

  it("is roughly uniform over the alphabet", () => {
    const counts = new Map<string, number>();
    const n = 3000;
    for (let i = 0; i < n; i++) for (const ch of newTripCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(31);
    const expected = (n * 10) / 31; // ~968
    for (const c of counts.values()) {
      expect(c).toBeGreaterThan(expected * 0.8);
      expect(c).toBeLessThan(expected * 1.2);
    }
  });
});
