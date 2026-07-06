import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** Names the guarded subtree in the fallback and the error report. */
  label: string;
  onError?(error: unknown): void;
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
      return (
        <div className="plugin-error" role="alert">
          {this.props.label} crashed — see the log
        </div>
      );
    }
    return this.props.children;
  }
}
