"use client";
// Contract: bottom-sheet flow for "Measure drive" on a par 5 (GPS -> rank preview -> required photo -> submit).
// Opened from the Play screen. Implemented by the contests agent.
export interface LongDriveSheetProps {
  open: boolean;
  onClose: () => void;
  /** Hole number (a long-drive hole, the team's current hole). */
  hole: number;
}

export function LongDriveSheet(props: LongDriveSheetProps) {
  void props;
  return null;
}
