import { Component, type ComponentChildren } from 'preact';

// Ported from oss-autopilot's error-boundary.tsx. Top-level boundary around
// <App />: a render-time throw (e.g. an unexpected server payload shape)
// would otherwise unmount the whole SPA tree with no user-visible message.

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ComponentChildren }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, errorInfo: unknown): void {
    console.error('[simon-dash] uncaught render error:', error, errorInfo);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div class="shell-center" role="alert" aria-live="assertive">
        <p class="shell-status shell-error">Dashboard crashed</p>
        <p class="shell-detail">{error.message}</p>
        <button class="shell-retry" type="button" onClick={this.retry}>
          Retry
        </button>
        <button class="shell-retry" type="button" onClick={() => location.reload()}>
          Reload page
        </button>
      </div>
    );
  }
}
