"use client";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Card } from "@/components/ui";

interface Props {
  children: ReactNode;
  /** Custom fallback. Default: a "this screen shanked it" card with retry. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Shown in the default fallback. */
  where?: string;
}

interface State {
  error: Error | null;
}

/** Keeps one broken screen from taking down the whole app on the course. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[scramble] ${this.props.where ?? "screen"} crashed`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return <ScreenCrash error={error} where={this.props.where} onRetry={this.reset} />;
  }
}

export function ScreenCrash({ error, where, onRetry }: { error: Error; where?: string; onRetry: () => void }) {
  return (
    <div className="mx-auto w-full max-w-xl px-4 pt-6">
      <Card tone="flag" className="space-y-3">
        <div className="text-5xl leading-none" aria-hidden="true">
          🏌️‍♂️💥
        </div>
        <h2 className="text-2xl font-black">This {where ?? "screen"} shanked it.</h2>
        <p className="text-base font-bold text-ink">
          Your scores and drinks are safe on this phone. Try again, or reload the app.
        </p>
        <p className="break-words font-mono text-xs font-semibold text-muted">{error.message}</p>
        <div className="flex flex-col gap-2 pt-1">
          <Button variant="primary" size="lg" full onClick={onRetry}>
            Try again
          </Button>
          <Button variant="secondary" size="lg" full onClick={() => window.location.reload()}>
            Reload the app
          </Button>
        </div>
      </Card>
    </div>
  );
}
