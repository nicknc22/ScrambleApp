// Scramble UI primitives. Import from "@/components/ui".
// Design rules: light theme, ink on white, 48px+ tap targets, 16px gutters, loud copy.
export { cx } from "./cx";
export { teamColor, TEAM_PALETTE, NO_TEAM_COLOR, type TeamColor } from "./teamColors";
export * from "./icons";
export { Button, IconButton, buttonClasses, type ButtonProps, type ButtonVariant, type ButtonSize, type IconButtonProps } from "./Button";
export { Card, cardClasses, type CardProps, type CardTone } from "./Card";
export { Chip, type ChipProps, type ChipTone } from "./Chip";
export { Badge, type BadgeProps, type BadgeTone } from "./Badge";
export { Stepper, type StepperProps } from "./Stepper";
export { SegmentedControl, type SegmentOption } from "./SegmentedControl";
export { BottomSheet, useIsClient, type BottomSheetProps } from "./BottomSheet";
export { ConfirmSheet, ConfirmProvider, useConfirm, type ConfirmOptions, type ConfirmSheetProps, type ConfirmTone } from "./ConfirmSheet";
export {
  ToastProvider,
  useToast,
  toastDuration,
  UNDO_MS,
  type ToastApi,
  type ToastOptions,
  type ToastTone,
  type ToastAction,
} from "./Toast";
export { FanfareProvider, useFanfare, type FanfareApi, type FanfareOptions, type FanfareTone } from "./Fanfare";
export { PlayerName, displayName, type NamedPlayer } from "./PlayerName";
export { Avatar, initials } from "./Avatar";
export { TeamPill } from "./TeamPill";
export { EmptyState } from "./EmptyState";
export { Spinner } from "./Spinner";
export { PinPad, type PinPadProps } from "./PinPad";
export { OfflineBadge, offlineBadgeText, type SyncStatus } from "./OfflineBadge";
export { SectionHeader } from "./SectionHeader";
export { StatTile, type StatTone } from "./StatTile";
export { Countdown, formatCountdown } from "./Countdown";
export { Toggle } from "./Toggle";
export { TextField, type TextFieldProps } from "./TextField";
