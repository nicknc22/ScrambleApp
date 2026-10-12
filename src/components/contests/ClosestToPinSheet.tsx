"use client";
// Contract: bottom-sheet flow for "Closest to pin" on a par 3 (photo -> feet/inches -> drag marker around pin -> submit).
// Opened from the Play screen and the Contests tab. Implemented by the contests agent.
export interface ClosestToPinSheetProps {
  open: boolean;
  onClose: () => void;
  /** Hole number (a closest-to-pin hole). */
  hole: number;
}

export function ClosestToPinSheet(props: ClosestToPinSheetProps) {
  void props;
  return null;
}
