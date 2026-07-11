import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** Names the guarded subtree in the fallback and the error report. */
  label: string;
  onError?(error: unknown): void;
  /** What a tripped boundary renders. Defaults to the inline "crashed" note;
   * pass `null` for surfaces whose failure is reported elsewhere — an
   * INVISIBLE overlay's fallback would otherwise show up as stray text
   * wherever the mount slot happens to sit. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * The fault line around third-party render trees: a plugin tab that throws
 * during render must not take the deck down with it. A class on purpose —
 * React has no hook equivalent of `componentDidCatch`. The boundary stays
 * broken once tripped (no retry): a render that threw once will throw again;
 * disabling and re-enabling the plugin remounts a fresh boundary.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  render(): ReactNode {
    if (this.state.failed) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div className="plugin-error" role="alert">
          {this.props.label} crashed — see the log
        </div>
      );
    }
    return this.props.children;
  }
}
