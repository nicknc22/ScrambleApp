"use client";
// Awards tab (after the commissioner finalizes): champions hero, one card per award, the recap
// card (share / download) and the photo gallery (viewer + download-all zip). Before final: a
// teaser plus a collapsed "if it ended now" preview.
import { useMemo, useState } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import { Card, IconLock, SectionHeader } from "@/components/ui";
import { Screen } from "@/components/shell/Screen";
import { AwardCard, ChampionsHero } from "@/components/awards/AwardCards";
import { GalleryWithViewer, toViewerPhotos } from "@/components/awards/Gallery";
import { PhotoViewer } from "@/components/awards/PhotoViewer";
import { collectPhotos } from "@/components/awards/photos";
import { RecapShare, contentKey } from "@/components/awards/RecapShare";

export function AwardsScreen() {
  const store = useTripStore();
  const derived = useClientState((s) => s.derived);
  const view = useClientState((s) => s.view);
  const meId = useClientState((s) => s.meId);
  const code = useClientState((s) => s.code);
  // Re-render when a pending photo finishes uploading (its URL switches from blob: to storage).
  useClientState((s) => s.pendingCount);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [single, setSingle] = useState<string | null>(null);

  const drinks = view?.drinks;
  const entries = view?.contest_entries;
  const feed = view?.feed_events;
  const photos = useMemo(
    () => (drinks && entries && feed ? collectPhotos({ drinks, contest_entries: entries, feed_events: feed }) : []),
    [drinks, entries, feed],
  );

  const version = useMemo(() => {
    if (!derived || !view) return "0";
    return contentKey([
      view.trip.name,
      view.trip.app_name,
      view.trip.status,
      view.trip.finalized_at,
      derived.standings.map((r) => [r.team_id, r.pos_label, r.net, r.net_to_par, r.thru]),
      derived.teams.map((t) => [t.id, t.name]),
      derived.players.map((p) => [p.id, p.name, p.nickname]),
      derived.awards.map((a) => [a.key, a.awarded, a.value_label, a.player_ids, a.team_ids]),
    ]);
  }, [derived, view]);

  if (!derived || !view) return null;
  const final = view.trip.status === "final";
  const champions = derived.awards.find((a) => a.key === "champions");
  const rest = derived.awards.filter((a) => a.key !== "champions");
  const photoUrl = (p: string) => store.photoUrl(p);
  const viewerPhotos = toViewerPhotos(photos, derived, photoUrl);

  const openPhoto = (path: string) => {
    const i = photos.findIndex((p) => p.path === path);
    if (i >= 0) setOpenIndex(i);
    else setSingle(path);
  };

  const awardList = (
    <ul className="space-y-3" data-testid="awards-list">
      {rest.map((a) => (
        <AwardCard
          key={a.key}
          award={a}
          people={derived}
          meId={meId}
          photoUrl={a.photo_path ? store.photoUrl(a.photo_path) : null}
          onPhoto={a.photo_path ? () => openPhoto(a.photo_path!) : undefined}
        />
      ))}
    </ul>
  );

  if (!final) {
    return (
      <Screen className="space-y-5">
        <Card tone="ink" className="text-center">
          <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-full border-2 border-white bg-white/10">
            <IconLock size={32} strokeWidth={3} />
          </div>
          <h2 className="loud text-4xl text-gold">Awards locked</h2>
          <p className="mt-2 text-base font-bold">Awards unlock when the commissioner finalizes. Glory and shame, coming soon.</p>
        </Card>
        <details className="group rounded-2xl border-2 border-ink bg-paper" data-testid="awards-preview">
          <summary className="flex min-h-14 list-none items-center gap-3 px-4 text-lg font-black [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true">👀</span>
            <span className="flex-1">Peek: if it ended now</span>
            <span className="text-sm font-bold text-muted group-open:hidden">Show</span>
            <span className="hidden text-sm font-bold text-muted group-open:inline">Hide</span>
          </summary>
          <div className="space-y-3 border-t-2 border-line p-3">
            <ChampionsHero award={champions} people={derived} meId={meId} />
            {awardList}
          </div>
        </details>
      </Screen>
    );
  }

  const singleViewer = single
    ? [{ path: single, url: store.photoUrl(single), caption: "Award photo", label: "Award photo", fileName: "award-photo.jpg" }]
    : null;

  return (
    <Screen className="space-y-6">
      <ChampionsHero award={champions} people={derived} meId={meId} />
      <section className="space-y-3" aria-labelledby="awards-title">
        <SectionHeader title={<span id="awards-title">The awards</span>} subtitle="Glory and shame, computed. No appeals." />
        {awardList}
      </section>
      <RecapShare code={code} tripName={view.trip.name} version={version} />
      <GalleryWithViewer
        photos={photos}
        viewerPhotos={viewerPhotos}
        tripName={view.trip.name}
        store={store}
        openIndex={openIndex}
        setOpenIndex={setOpenIndex}
      />
      {singleViewer && <PhotoViewer photos={singleViewer} index={0} onIndex={() => {}} onClose={() => setSingle(null)} />}
    </Screen>
  );
}
