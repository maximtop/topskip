import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button, Stack, Text } from '@mantine/core';

interface ErrorBoundaryProps {
    children: ReactNode;
}

interface ErrorBoundaryState {
    error: Error | null;
}

/**
 * Catches React render errors and shows a recovery UI instead of a blank
 * screen. Especially important for the popup where users cannot see DevTools.
 */
export class ErrorBoundary extends Component<
    ErrorBoundaryProps,
    ErrorBoundaryState
> {
    /**
     * @param props - Component props.
     */
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { error: null };
    }

    /**
     * Derives error state from a caught render error.
     *
     * @param error - The thrown error.
     * @returns Updated state with the captured error.
     */
    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    /**
     * Lifecycle hook called after an error is caught. Intentionally empty —
     * `src/shared/` must not perform I/O (no `console` calls per AGENTS.md).
     *
     * @param _error - The thrown error.
     * @param _info - React error info with component stack.
     */
    componentDidCatch(_error: Error, _info: ErrorInfo): void {
        // no-op: getDerivedStateFromError handles state; avoid console I/O here
        // per AGENTS.md shared/ purity rules.
    }

    /**
     * Renders children or a fallback error UI.
     *
     * @returns The component tree or an error alert.
     */
    render(): ReactNode {
        if (this.state.error) {
            return (
                <Stack gap="md" p="md" maw={520}>
                    <Alert
                        color="error"
                        title="Something went wrong"
                        role="alert"
                    >
                        <Text size="sm">{this.state.error.message}</Text>
                    </Alert>
                    <Button
                        variant="light"
                        size="sm"
                        onClick={() => {
                            this.setState({ error: null });
                        }}
                    >
                        Try again
                    </Button>
                </Stack>
            );
        }
        return this.props.children;
    }
}
