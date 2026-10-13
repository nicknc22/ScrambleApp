"use client";
// Small pieces shared by the contest sheets and the Contests tab.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Player, UUID } from "@/lib/types";
import type { Derived } from "@/lib/engine/types";
import { Avatar, Chip, IconCamera, cx, displayName } from "@/components/ui";

/** "Measuring for": one chip per teammate (defaults to me; one phone per cart is common). */
export function EntrantPicker({
  label,
  choices,
  value,
  onChange,
  meId,
  derived,
}: {
  label: string;
  choices: readonly Player[];
  value: UUID | null;
  onChange: (id: UUID) => void;
  meId: UUID | null;
  derived: Pick<Derived, "teamOfPlayer" | "teamById">;
}) {
  if (choices.length === 0) {
    return (
      <p className="rounded-2xl bg-flag-soft px-3 py-3 text-base font-bold text-ink">
        Nobody on a team to enter for. The commissioner has to build teams first.
      </p>
    );
  }
  return (
    <fieldset className="space-y-2" data-testid="entrant-picker">
      <legend className="text-xs font-extrabold tracking-widest text-muted uppercase">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {choices.map((p) => {
          const team = derived.teamById[derived.teamOfPlayer[p.id] ?? ""];
          const selected = p.id === value;
          return (
            <Chip
              key={p.id}
              selected={selected}
              tone="ink"
              onClick={() => onChange(p.id)}
              leading={<Avatar player={p} teamSortOrder={team?.sort_order ?? null} size="sm" showCrown={false} />}
              aria-label={`${displayName(p)}${p.id === meId ? " (you)" : ""}`}
              data-testid="entrant-chip"
            >
              {displayName(p)}
              {p.is_groom ? " 👑" : ""}
              {p.id === meId ? <span className="font-semibold opacity-80"> (you)</span> : null}
            </Chip>
          );
        })}
      </div>
    </fieldset>
  );
}

export interface PhotoDraft {
  file: Blob;
  url: string | null;
}

/** A picked photo kept in memory (uploaded only on submit) with a revocable preview URL. */
function revokeUrl(ref: { current: string | null }): void {
  if (!ref.current) return;
  try {
    URL.revokeObjectURL(ref.current);
  } catch {
    /* ignore */
  }
  ref.current = null;
}

export function usePhotoDraft(): { photo: PhotoDraft | null; set: (file: Blob) => void; clear: () => void } {
  const [photo, setPhoto] = useState<PhotoDraft | null>(null);
  const current = useRef<string | null>(null);
  useEffect(() => () => revokeUrl(current), []);
  const set = useCallback((file: Blob) => {
    revokeUrl(current);
    let url: string | null = null;
    try {
      url = URL.createObjectURL(file);
    } catch {
      url = null;
    }
    current.current = url;
    setPhoto({ file, url });
  }, []);
  const clear = useCallback(() => {
    revokeUrl(current);
    setPhoto(null);
  }, []);
  return { photo, set, clear };
}

function CameraInput({ testId, onFile }: { testId: string; onFile: (file: Blob) => void }) {
  return (
    <input
      type="file"
      accept="image/*"
      capture="environment"
      className="sr-only"
      data-testid={testId}
      onChange={(e) => {
        const file = e.currentTarget.files?.[0] ?? null;
        e.currentTarget.value = "";
        if (file) onFile(file);
      }}
    />
  );
}

/**
 * The big camera button: a <label> wrapping the file input, so iOS opens the camera on the tap
 * itself (a programmatic click from a handler isn't trusted everywhere). Lives in the sheet footer.
 */
export function CameraButton({ cta, onFile, testId }: { cta: string; onFile: (file: Blob) => void; testId: string }) {
  return (
    <label className="btn btn-xl w-full border-ink bg-hazard text-ink shadow-hard active:bg-hazard-dark">
      <IconCamera size={28} strokeWidth={2.5} />
      {cta}
      <CameraInput testId={testId} onFile={onFile} />
    </label>
  );
}

/** The picked photo with a Retake button. */
export function PhotoPreview({ photo, onFile, testId }: { photo: PhotoDraft; onFile: (file: Blob) => void; testId: string }) {
  return <PhotoFrame url={photo.url} badge="✓ Got it" onFile={onFile} testId={`${testId}-preview`} retakeTestId={`${testId}-retake`} />;
}

/** The entry's current photo while editing: it stays with the edit unless a new one is taken. */
export function KeptPhoto({ url, onFile, testId }: { url: string | null; onFile: (file: Blob) => void; testId: string }) {
  return <PhotoFrame url={url} badge="✓ Current photo, kept" onFile={onFile} testId={`${testId}-kept`} retakeTestId={`${testId}-retake`} />;
}

function PhotoFrame({
  url,
  badge,
  onFile,
  testId,
  retakeTestId,
}: {
  url: string | null;
  badge: string;
  onFile: (file: Blob) => void;
  testId: string;
  retakeTestId: string;
}) {
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="relative overflow-hidden rounded-2xl border-2 border-ink bg-sand">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element -- local preview blob / stored photo
          <img src={url} alt="Your photo" className="block max-h-[30dvh] w-full object-cover" />
        ) : (
          <p className="px-4 py-8 text-center text-base font-bold text-muted">Photo attached (no preview on this phone).</p>
        )}
        <span className="absolute top-2 left-2 rounded-full border-2 border-ink bg-fairway px-2.5 py-1 text-xs font-black tracking-wide text-white uppercase">
          {badge}
        </span>
      </div>
      <label className="btn w-full border-ink bg-paper text-ink active:bg-sand">
        <IconCamera size={22} strokeWidth={2.5} />
        Retake
        <CameraInput testId={retakeTestId} onFile={onFile} />
      </label>
    </div>
  );
}

/** Placeholder where the photo will go, pointing at the camera button below. */
export function PhotoSlot({ title, hint }: { title: string; hint: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border-2 border-dashed border-ink bg-hazard-soft px-3 py-3">
      <span className="text-4xl leading-none" aria-hidden="true">
        📸
      </span>
      <div className="min-w-0">
        <p className="text-lg leading-tight font-black">{title}</p>
        <p className="text-[15px] leading-snug font-semibold text-muted">{hint}</p>
      </div>
    </div>
  );
}

/** "1 · 2 · 3" step progress for the wizard. */
export function StepDots({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label={`Step ${current + 1} of ${steps.length}`}>
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i === current ? "step" : undefined}
          className={cx(
            "flex min-w-0 flex-1 items-center justify-center gap-1 rounded-full border-2 px-2 py-1 text-[12px] font-black tracking-wide uppercase",
            i < current && "border-fairway-dark bg-fairway text-white",
            i === current && "border-ink bg-ink text-white",
            i > current && "border-line bg-sand text-muted",
          )}
        >
          <span className="num">{i < current ? "✓" : i + 1}</span>
          <span className="truncate">{s}</span>
        </li>
      ))}
    </ol>
  );
}
