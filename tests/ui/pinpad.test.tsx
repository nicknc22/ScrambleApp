// The commissioner unlock pad accepts every PIN the app lets you set (4-12 digits), by tap and by
// keyboard, and the 12 dots still fit a 360px phone.
import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PinPad, type PinPadProps } from "@/components/ui/PinPad";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/pin";

type Props = Record<string, unknown> & { children?: ReactNode; onClick?: () => void; onKeyDown?: (e: unknown) => void };

/** Every element in a (non-rendered) element tree matching `pred`. PinPad has no hooks, so calling it is safe. */
function findAll(node: ReactNode, pred: (el: ReactElement<Props>) => boolean, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (Array.isArray(node)) for (const n of node) findAll(n, pred, out);
  else if (isValidElement<Props>(node)) {
    if (pred(node)) out.push(node);
    findAll(node.props.children, pred, out);
  }
  return out;
}

/** A tiny controlled harness around PinPad. */
function pad(extra: Partial<PinPadProps> = {}) {
  let value = "";
  let submitted: string | null = null;
  const tree = () => PinPad({ value, onChange: (v) => (value = v), onSubmit: (p) => (submitted = p), ...extra }) as ReactElement<Props>;
  return {
    tap(digits: string) {
      for (const d of digits) {
        const [key] = findAll(tree(), (el) => el.props.children === d && typeof el.props.onClick === "function");
        key.props.onClick!();
      }
    },
    type(keys: string) {
      for (const key of keys) tree().props.onKeyDown!({ key, preventDefault() {} });
    },
    submit() {
      tree().props.onKeyDown!({ key: "Enter", preventDefault() {} });
    },
    html: () => renderToStaticMarkup(<PinPad value={value} onChange={() => {}} onSubmit={() => {}} {...extra} />),
    get value() {
      return value;
    },
    get submitted() {
      return submitted;
    },
  };
}

describe("PinPad", () => {
  it("defaults to the app's PIN limits (4 to 12 digits)", () => {
    expect([PIN_MIN_LENGTH, PIN_MAX_LENGTH]).toEqual([4, 12]);
  });

  it("takes a 12-digit PIN by tapping and submits all of it", () => {
    const p = pad();
    p.tap("555123456789");
    expect(p.value).toBe("555123456789");
    p.tap("0"); // a 13th digit is ignored
    expect(p.value).toBe("555123456789");
    expect(p.html()).toContain('aria-label="12 digits entered"');
    p.submit();
    expect(p.submitted).toBe("555123456789");
  });

  it("takes a 12-digit PIN from a hardware keyboard", () => {
    const p = pad();
    p.type("1234567890123");
    expect(p.value).toBe("123456789012");
    p.submit();
    expect(p.submitted).toBe("123456789012");
  });

  it("won't submit fewer than 4 digits", () => {
    const p = pad();
    p.tap("123");
    p.submit();
    expect(p.submitted).toBeNull();
  });

  it("shrinks the dots past 8 so 12 of them fit a 360px phone", () => {
    const p = pad();
    p.tap("1234567"); // 7 digits + the next empty slot = 8 dots: full size
    expect(p.html()).not.toContain("h-4 w-4");
    p.tap("89012");
    const html = p.html();
    expect(html.split("h-4 w-4").length - 1).toBe(12);
    expect(html).toContain("gap-2");
    // 12 x 16px dots + 11 x 8px gaps = 280px, inside 360 - 2 x 16px gutters.
    expect(12 * 16 + 11 * 8).toBeLessThanOrEqual(360 - 32);
  });
});
