"use client";
// Copy text to the clipboard: the async Clipboard API when allowed, else the old hidden-textarea
// + execCommand("copy") trick (iOS standalone PWAs, http on a LAN IP, older WebViews).

export interface ClipboardEnv {
  navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } | null;
  document?: Document | null;
}

function defaultEnv(): ClipboardEnv {
  return {
    navigator: typeof navigator === "undefined" ? null : navigator,
    document: typeof document === "undefined" ? null : document,
  };
}

/** true when the text made it to the clipboard. Never throws. */
export async function copyText(text: string, env: ClipboardEnv = defaultEnv()): Promise<boolean> {
  try {
    const write = env.navigator?.clipboard?.writeText;
    if (typeof write === "function") {
      await write.call(env.navigator!.clipboard, text);
      return true;
    }
  } catch {
    /* permission denied / insecure context: fall back */
  }
  const doc = env.document;
  if (!doc?.body) return false;
  let ta: HTMLTextAreaElement | null = null;
  try {
    ta = doc.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.setAttribute("aria-hidden", "true");
    // 16px so iOS doesn't zoom; off-screen but still selectable.
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;";
    doc.body.appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    return doc.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    try {
      ta?.remove();
    } catch {
      /* ignore */
    }
  }
}
