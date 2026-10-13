// First-run copy matches the steps actually shown (finding: "Three quick things" with two steps).
import { describe, expect, it } from "vitest";
import { onboardingIntro, onboardingSteps } from "@/components/join/Onboarding";

describe("onboarding intro", () => {
  it("counts the steps this device will see", () => {
    // Home Screen launch: install is skipped, so two steps.
    expect(onboardingIntro("Tom", onboardingSteps(true).length)).toBe("You're in, Tom. Two quick things, then golf.");
    expect(onboardingIntro("Tom", onboardingSteps(false).length)).toBe("You're in, Tom. Three quick things, then golf.");
    expect(onboardingIntro("Tom", 1)).toBe("You're in, Tom. One quick thing, then golf.");
  });
});
