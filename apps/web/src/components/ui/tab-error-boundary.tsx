/**
 * Error boundary for tab content — isolates render failures in one tab
 * from crashing other tabs or the entire application.
 *
 * Shows a minimal fallback UI with error info and a retry button.
 * React error boundaries must be class components.
 */

import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

interface TabErrorBoundaryProps {
  readonly children: ReactNode
  /** Tab label for error context. */
  readonly label?: string
}

interface TabErrorBoundaryState {
  readonly error: Error | null
  readonly hasError: boolean
}

class TabErrorBoundary extends Component<
  TabErrorBoundaryProps,
  TabErrorBoundaryState
> {
  constructor(props: TabErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): TabErrorBoundaryState {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(
      `[TabErrorBoundary] Error in tab "${this.props.label ?? 'unknown'}":`,
      error,
      errorInfo
    )
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
          data-testid="tab-error-boundary"
        >
          <AlertTriangle className="size-8 text-destructive" />
          <div className="grid gap-1.5">
            <h3 className="font-medium text-sm">Something went wrong</h3>
            <p className="max-w-sm text-muted-foreground text-xs/relaxed">
              {this.state.error?.message ?? 'An unexpected error occurred'}
              {this.props.label ? ` in "${this.props.label}"` : ''}
            </p>
          </div>
          <Button onClick={this.handleRetry} size="sm" variant="outline">
            <RotateCcw className="size-3.5" />
            Retry
          </Button>
        </div>
      )
    }

    return this.props.children
  }
}

export { TabErrorBoundary }
