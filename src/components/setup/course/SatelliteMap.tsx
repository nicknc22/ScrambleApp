"use client";
// Leaflet satellite map for placing a hole's tee and green. CLIENT ONLY: Leaflet touches `window`
// at import time, so this module is only ever loaded through next/dynamic with ssr: false (see
// MapSheet). Markers are L.divIcon badges (no Leaflet image icons).
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { Fragment, useEffect, useMemo, useRef } from "react";
import { MapContainer, Marker, Polyline, TileLayer, useMap, useMapEvents } from "react-leaflet";
import type { LatLng, MapView, PointKind } from "./courseModel";

export const ESRI_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const ESRI_ATTRIBUTION =
  'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community';

export interface MapApi {
  zoomIn(): void;
  zoomOut(): void;
  panTo(p: LatLng): void;
  /** Fit the given points (or recenter on one). */
  show(points: LatLng[]): void;
}

export interface OtherHolePoints {
  hole: number;
  tee: LatLng | null;
  green: LatLng | null;
}

export interface SatelliteMapProps {
  hole: number;
  tee: LatLng | null;
  green: LatLng | null;
  mode: PointKind;
  others: OtherHolePoints[];
  /** Applied whenever viewKey changes (e.g. moving to another hole). */
  view: MapView;
  viewKey: string | number;
  onPlace: (kind: PointKind, p: LatLng) => void;
  onReady?: (api: MapApi | null) => void;
  /** true when satellite tiles keep failing (no signal). */
  onTileTrouble?: (bad: boolean) => void;
}

const MARKER_FONT = "-apple-system, BlinkMacSystemFont, system-ui, sans-serif";

function badgeHtml(kind: PointKind, hole: number, size: number, active: boolean, faint: boolean): string {
  const tee = kind === "tee";
  const bg = tee ? "#ffffff" : "#e5262d";
  const fg = tee ? "#0b0f0c" : "#ffffff";
  const ring = active ? "0 0 0 4px #ffd60a, 0 3px 0 4px #0b0f0c" : faint ? "none" : "0 3px 0 0 #0b0f0c";
  const label = faint
    ? ""
    : `<span style="position:absolute;left:50%;top:${size + 2}px;transform:translateX(-50%);background:#0b0f0c;color:#fff;font:900 10px/1 ${MARKER_FONT};letter-spacing:.06em;padding:3px 5px;border-radius:6px;white-space:nowrap">${tee ? "TEE" : "GREEN"}</span>`;
  return `<div style="position:relative;width:${size}px;height:${size}px;opacity:${faint ? 0.7 : 1}">
    <div style="width:${size}px;height:${size}px;border-radius:${tee ? "50%" : "50% 50% 50% 4px"};background:${bg};color:${fg};border:${faint ? 2 : 3}px solid #0b0f0c;box-shadow:${ring};display:flex;align-items:center;justify-content:center;font:900 ${Math.round(size * 0.46)}px/1 ${MARKER_FONT};box-sizing:border-box">${hole}</div>${label}
  </div>`;
}

function badgeIcon(kind: PointKind, hole: number, opts: { active?: boolean; faint?: boolean } = {}): L.DivIcon {
  const size = opts.faint ? 24 : 40;
  return L.divIcon({
    className: "scramble-pin",
    html: badgeHtml(kind, hole, size, !!opts.active, !!opts.faint),
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const toLL = (p: LatLng): L.LatLngExpression => [p.lat, p.lng];

/** Keep fitted pins clear of the overlays: GPS button (top left), zoom buttons (top right), attribution (bottom). */
const FIT_OPTIONS: L.FitBoundsOptions = { paddingTopLeft: [28, 76], paddingBottomRight: [76, 36], maxZoom: 18 };

function Controller({ view, viewKey, onReady }: Pick<SatelliteMapProps, "view" | "viewKey" | "onReady">) {
  const map = useMap();
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  });

  useEffect(() => {
    const api: MapApi = {
      zoomIn: () => map.zoomIn(),
      zoomOut: () => map.zoomOut(),
      panTo: (p) => map.panTo(toLL(p), { animate: true }),
      show: (points) => {
        if (points.length >= 2) map.fitBounds(L.latLngBounds(points.map(toLL)), FIT_OPTIONS);
        else if (points.length === 1) map.setView(toLL(points[0]), Math.max(map.getZoom(), 17));
      },
    };
    onReady?.(api);
    return () => onReady?.(null);
  }, [map, onReady]);

  // Re-apply the hole's view when the hole changes.
  useEffect(() => {
    const v = viewRef.current;
    if (v.fit && v.fit.length >= 2) map.fitBounds(L.latLngBounds(v.fit.map(toLL)), FIT_OPTIONS);
    else map.setView(toLL(v.center), v.zoom);
  }, [map, viewKey]);

  // The sheet slides in: Leaflet must re-measure once the layout settles (and on any resize).
  useEffect(() => {
    const el = map.getContainer();
    const fix = () => map.invalidateSize({ pan: false });
    const timers = [setTimeout(fix, 0), setTimeout(fix, 320)];
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(fix);
      ro.observe(el);
    }
    return () => {
      timers.forEach(clearTimeout);
      ro?.disconnect();
    };
  }, [map]);
  return null;
}

function ClickToPlace({ mode, onPlace }: Pick<SatelliteMapProps, "mode" | "onPlace">) {
  const ref = useRef({ mode, onPlace });
  useEffect(() => {
    ref.current = { mode, onPlace };
  });
  useMapEvents({
    click(e) {
      ref.current.onPlace(ref.current.mode, { lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

function DraggablePoint({ kind, hole, at, active, onPlace }: { kind: PointKind; hole: number; at: LatLng; active: boolean; onPlace: SatelliteMapProps["onPlace"] }) {
  const icon = useMemo(() => badgeIcon(kind, hole, { active }), [kind, hole, active]);
  const handlers = useMemo<L.LeafletEventHandlerFnMap>(
    () => ({
      dragend: (e) => {
        const ll = (e.target as L.Marker).getLatLng();
        onPlace(kind, { lat: ll.lat, lng: ll.lng });
      },
    }),
    [kind, onPlace],
  );
  return (
    <Marker
      position={toLL(at)}
      icon={icon}
      draggable
      autoPan
      keyboard={false}
      zIndexOffset={active ? 1000 : 500}
      eventHandlers={handlers}
      title={`Hole ${hole} ${kind}: drag to adjust`}
      alt={`Hole ${hole} ${kind}`}
    />
  );
}

function FaintPoint({ kind, hole, at }: { kind: PointKind; hole: number; at: LatLng }) {
  const icon = useMemo(() => badgeIcon(kind, hole, { faint: true }), [kind, hole]);
  return <Marker position={toLL(at)} icon={icon} interactive={false} keyboard={false} />;
}

export function SatelliteMap({ hole, tee, green, mode, others, view, viewKey, onPlace, onReady, onTileTrouble }: SatelliteMapProps) {
  const tiles = useRef({ ok: 0, bad: 0, reported: false });
  const troubleRef = useRef(onTileTrouble);
  useEffect(() => {
    troubleRef.current = onTileTrouble;
  });
  const tileHandlers = useMemo<L.LeafletEventHandlerFnMap>(
    () => ({
      tileload: () => {
        tiles.current.ok++;
        if (tiles.current.reported) {
          tiles.current.reported = false;
          troubleRef.current?.(false);
        }
      },
      tileerror: () => {
        tiles.current.bad++;
        if (!tiles.current.reported && tiles.current.bad >= 4 && tiles.current.bad > tiles.current.ok) {
          tiles.current.reported = true;
          troubleRef.current?.(true);
        }
      },
    }),
    [],
  );

  return (
    <MapContainer
      center={toLL(view.center)}
      zoom={view.zoom}
      minZoom={13}
      maxZoom={20}
      zoomControl={false}
      attributionControl
      doubleClickZoom={false}
      className="h-full w-full"
      style={{ height: "100%", width: "100%", background: "#26332b" }}
    >
      <TileLayer url={ESRI_TILES} attribution={ESRI_ATTRIBUTION} maxNativeZoom={19} maxZoom={20} eventHandlers={tileHandlers} />
      <Controller view={view} viewKey={viewKey} onReady={onReady} />
      <ClickToPlace mode={mode} onPlace={onPlace} />
      {others.map((o) => (
        <Fragment key={o.hole}>
          {o.tee && <FaintPoint kind="tee" hole={o.hole} at={o.tee} />}
          {o.green && <FaintPoint kind="green" hole={o.hole} at={o.green} />}
        </Fragment>
      ))}
      {tee && green && (
        <Polyline positions={[toLL(tee), toLL(green)]} pathOptions={{ color: "#ffd60a", weight: 4, dashArray: "10 8", interactive: false }} />
      )}
      {tee && <DraggablePoint kind="tee" hole={hole} at={tee} active={mode === "tee"} onPlace={onPlace} />}
      {green && <DraggablePoint kind="green" hole={hole} at={green} active={mode === "green"} onPlace={onPlace} />}
    </MapContainer>
  );
}

export default SatelliteMap;
