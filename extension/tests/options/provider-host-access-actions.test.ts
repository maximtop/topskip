import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ProviderHostAccessActions,
    type ProviderHostAccessActionEffects,
    type ProviderHostAccessActionInput,
} from '@/options/provider-host-access-actions';
import {
    PROVIDER_CONNECTION_FAILURE_CODE,
    type TestConnectionKeyResponse,
} from '@/shared/messages';
import {
    PROVIDER_HOST_ACCESS_REQUEST_OUTCOME,
    PROVIDER_HOST_ACCESS_STATUS,
    type ProviderHostAccessRequestOutcome,
} from '@/shared/provider-host-permissions';
import { PROVIDER_ID } from '@/shared/providers';

const VALID_RESPONSE: TestConnectionKeyResponse = { ok: true, valid: true };

type EffectsHarness = {
    effects: ProviderHostAccessActionEffects;
    events: string[];
    resolveRequest(outcome: ProviderHostAccessRequestOutcome): void;
    request: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    sendTest: ReturnType<typeof vi.fn>;
    showKeyRequired: ReturnType<typeof vi.fn>;
    showRequestOutcome: ReturnType<typeof vi.fn>;
    applyTestResponse: ReturnType<typeof vi.fn>;
    showTestUnavailable: ReturnType<typeof vi.fn>;
    showReloadUnavailable: ReturnType<typeof vi.fn>;
    clearFeedback: ReturnType<typeof vi.fn>;
    markAccessMissing: ReturnType<typeof vi.fn>;
};

function createInput(
    overrides: Partial<ProviderHostAccessActionInput> = {},
): ProviderHostAccessActionInput {
    return {
        providerId: PROVIDER_ID.OpenRouter,
        hasCredential: true,
        hostAccessStatus: PROVIDER_HOST_ACCESS_STATUS.Missing,
        ...overrides,
    };
}

function createEffectsHarness(): EffectsHarness {
    const events: string[] = [];
    let resolvePermission:
        | ((outcome: ProviderHostAccessRequestOutcome) => void)
        | undefined;
    const request = vi.fn(
        () =>
            new Promise<ProviderHostAccessRequestOutcome>((resolve) => {
                events.push('request');
                resolvePermission = resolve;
            }),
    );
    const reload = vi.fn(() => {
        events.push('reload');
        return Promise.resolve(true);
    });
    const sendTest = vi.fn(() => {
        events.push('send-test');
        return Promise.resolve(VALID_RESPONSE);
    });
    const showKeyRequired = vi.fn(() => {
        events.push('key-required');
    });
    const showRequestOutcome = vi.fn(() => {
        events.push('request-outcome');
    });
    const applyTestResponse = vi.fn(() => {
        events.push('apply-test');
    });
    const showTestUnavailable = vi.fn(() => {
        events.push('test-unavailable');
    });
    const showReloadUnavailable = vi.fn(() => {
        events.push('reload-unavailable');
    });
    const clearFeedback = vi.fn(() => {
        events.push('clear-feedback');
    });
    const markAccessMissing = vi.fn(() => {
        events.push('mark-missing');
    });

    return {
        effects: {
            request,
            reload,
            sendTest,
            showKeyRequired,
            showRequestOutcome,
            applyTestResponse,
            showTestUnavailable,
            showReloadUnavailable,
            clearFeedback,
            markAccessMissing,
        },
        events,
        resolveRequest(outcome) {
            resolvePermission?.(outcome);
        },
        request,
        reload,
        sendTest,
        showKeyRequired,
        showRequestOutcome,
        applyTestResponse,
        showTestUnavailable,
        showReloadUnavailable,
        clearFeedback,
        markAccessMissing,
    };
}

describe('ProviderHostAccessActions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('requests access before any grant state or reload work', async () => {
        const harness = createEffectsHarness();

        const result = ProviderHostAccessActions.grant(
            createInput(),
            harness.effects,
        );

        expect(result).toBeUndefined();
        expect(harness.events).toEqual(['request']);
        harness.resolveRequest(PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Granted);
        await vi.waitFor(() => {
            expect(harness.events).toEqual([
                'request',
                'clear-feedback',
                'reload',
            ]);
        });
        expect(harness.reload).toHaveBeenCalledOnce();
    });

    it('clears stale feedback after a denied grant retry succeeds', async () => {
        const harness = createEffectsHarness();
        const input = createInput();

        ProviderHostAccessActions.grant(input, harness.effects);
        harness.resolveRequest(PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Denied);
        await vi.waitFor(() => {
            expect(harness.showRequestOutcome).toHaveBeenCalledOnce();
        });

        ProviderHostAccessActions.grant(input, harness.effects);
        harness.resolveRequest(PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Granted);

        await vi.waitFor(() => {
            expect(harness.clearFeedback).toHaveBeenCalledWith(
                PROVIDER_ID.OpenRouter,
            );
        });
        expect(harness.reload).toHaveBeenCalledOnce();
        expect(harness.showReloadUnavailable).not.toHaveBeenCalled();
    });

    it('uses safe reload feedback for an unsuccessful settings response', async () => {
        const harness = createEffectsHarness();
        harness.reload.mockResolvedValue(false);

        ProviderHostAccessActions.grant(createInput(), harness.effects);
        harness.resolveRequest(PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Granted);

        await vi.waitFor(() => {
            expect(harness.showReloadUnavailable).toHaveBeenCalledWith(
                PROVIDER_ID.OpenRouter,
            );
        });
        expect(harness.clearFeedback).toHaveBeenCalledWith(
            PROVIDER_ID.OpenRouter,
        );
    });

    it('uses safe reload feedback and skips testing after rejection', async () => {
        const harness = createEffectsHarness();
        harness.reload.mockRejectedValue(new Error('raw runtime failure'));

        ProviderHostAccessActions.test(createInput(), harness.effects);
        harness.resolveRequest(PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Granted);

        await vi.waitFor(() => {
            expect(harness.showReloadUnavailable).toHaveBeenCalledWith(
                PROVIDER_ID.OpenRouter,
            );
        });
        expect(harness.sendTest).not.toHaveBeenCalled();
        expect(harness.applyTestResponse).not.toHaveBeenCalled();
    });

    it('deduplicates repeated grant clicks until the request settles', async () => {
        const first = createEffectsHarness();
        const repeated = createEffectsHarness();
        const input = createInput();

        ProviderHostAccessActions.grant(input, first.effects);
        ProviderHostAccessActions.grant(input, repeated.effects);

        expect(first.request).toHaveBeenCalledOnce();
        expect(repeated.request).not.toHaveBeenCalled();
        first.resolveRequest(PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Denied);
        await vi.waitFor(() => {
            expect(first.showRequestOutcome).toHaveBeenCalledOnce();
        });

        ProviderHostAccessActions.grant(input, repeated.effects);
        expect(repeated.request).toHaveBeenCalledOnce();
        repeated.resolveRequest(PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Denied);
        await vi.waitFor(() => {
            expect(repeated.showRequestOutcome).toHaveBeenCalledOnce();
        });
    });

    it.each([
        PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Denied,
        PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Failed,
    ] as const)('keeps settings intact after %s grant outcome', async (outcome) => {
        const harness = createEffectsHarness();

        ProviderHostAccessActions.grant(createInput(), harness.effects);
        harness.resolveRequest(outcome);

        await vi.waitFor(() => {
            expect(harness.showRequestOutcome).toHaveBeenCalledWith(
                PROVIDER_ID.OpenRouter,
                outcome,
            );
        });
        expect(harness.reload).not.toHaveBeenCalled();
        expect(harness.sendTest).not.toHaveBeenCalled();
    });

    it('requires a credential without requesting permission or testing', () => {
        const harness = createEffectsHarness();

        ProviderHostAccessActions.test(
            createInput({ hasCredential: false }),
            harness.effects,
        );

        expect(harness.events).toEqual(['key-required']);
        expect(harness.request).not.toHaveBeenCalled();
        expect(harness.sendTest).not.toHaveBeenCalled();
    });

    it('requests missing access in the test gesture before other effects', async () => {
        const harness = createEffectsHarness();

        const result = ProviderHostAccessActions.test(
            createInput(),
            harness.effects,
        );

        expect(result).toBeUndefined();
        expect(harness.events).toEqual(['request']);
        harness.resolveRequest(PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Granted);
        await vi.waitFor(() => {
            expect(harness.events).toEqual([
                'request',
                'clear-feedback',
                'reload',
                'send-test',
                'apply-test',
            ]);
        });
        expect(harness.reload).toHaveBeenCalledOnce();
        expect(harness.sendTest).toHaveBeenCalledWith(
            PROVIDER_ID.OpenRouter,
        );
    });

    it('deduplicates repeated tests while access is being requested', async () => {
        const first = createEffectsHarness();
        const repeated = createEffectsHarness();
        const input = createInput();

        ProviderHostAccessActions.test(input, first.effects);
        ProviderHostAccessActions.test(input, repeated.effects);

        expect(first.request).toHaveBeenCalledOnce();
        expect(repeated.request).not.toHaveBeenCalled();
        expect(repeated.sendTest).not.toHaveBeenCalled();
        first.resolveRequest(PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Denied);
        await vi.waitFor(() => {
            expect(first.showRequestOutcome).toHaveBeenCalledOnce();
        });
    });

    it.each([
        PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Denied,
        PROVIDER_HOST_ACCESS_REQUEST_OUTCOME.Failed,
    ] as const)('does not test after a %s permission outcome', async (outcome) => {
        const harness = createEffectsHarness();

        ProviderHostAccessActions.test(createInput(), harness.effects);
        harness.resolveRequest(outcome);

        await vi.waitFor(() => {
            expect(harness.showRequestOutcome).toHaveBeenCalledWith(
                PROVIDER_ID.OpenRouter,
                outcome,
            );
        });
        expect(harness.reload).not.toHaveBeenCalled();
        expect(harness.sendTest).not.toHaveBeenCalled();
    });

    it('tests immediately when the displayed access state is granted', async () => {
        const harness = createEffectsHarness();

        ProviderHostAccessActions.test(
            createInput({
                providerId: PROVIDER_ID.OpenAI,
                hostAccessStatus: PROVIDER_HOST_ACCESS_STATUS.Granted,
            }),
            harness.effects,
        );

        expect(harness.events[0]).toBe('send-test');
        expect(harness.request).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(harness.applyTestResponse).toHaveBeenCalledWith(
                PROVIDER_ID.OpenAI,
                VALID_RESPONSE,
            );
        });
    });

    it('deduplicates repeated tests while the provider reply is pending', async () => {
        const first = createEffectsHarness();
        const repeated = createEffectsHarness();
        let resolveTest:
            | ((value: TestConnectionKeyResponse) => void)
            | undefined;
        const pendingTest = new Promise<TestConnectionKeyResponse>(
            (resolve) => {
                resolveTest = resolve;
            },
        );
        first.sendTest.mockReturnValue(pendingTest);
        const input = createInput({
            hostAccessStatus: PROVIDER_HOST_ACCESS_STATUS.Granted,
        });

        ProviderHostAccessActions.test(input, first.effects);
        ProviderHostAccessActions.test(input, repeated.effects);

        expect(first.sendTest).toHaveBeenCalledOnce();
        expect(repeated.sendTest).not.toHaveBeenCalled();
        resolveTest?.(VALID_RESPONSE);
        await vi.waitFor(() => {
            expect(first.applyTestResponse).toHaveBeenCalledOnce();
        });
    });

    it('turns a stale granted row missing without a late prompt', async () => {
        const harness = createEffectsHarness();
        const hostAccessRequired: TestConnectionKeyResponse = {
            ok: false,
            code: PROVIDER_CONNECTION_FAILURE_CODE.HostAccessRequired,
            providerId: PROVIDER_ID.OpenAI,
        };
        harness.sendTest.mockResolvedValue(hostAccessRequired);

        ProviderHostAccessActions.test(
            createInput({
                providerId: PROVIDER_ID.OpenAI,
                hostAccessStatus: PROVIDER_HOST_ACCESS_STATUS.Granted,
            }),
            harness.effects,
        );

        await vi.waitFor(() => {
            expect(harness.markAccessMissing).toHaveBeenCalledWith(
                PROVIDER_ID.OpenAI,
            );
        });
        expect(harness.applyTestResponse).toHaveBeenCalledWith(
            PROVIDER_ID.OpenAI,
            hostAccessRequired,
        );
        expect(harness.request).not.toHaveBeenCalled();
    });

    it('rejects a host-access failure for a different provider', async () => {
        const harness = createEffectsHarness();
        harness.sendTest.mockResolvedValue({
            ok: false,
            code: PROVIDER_CONNECTION_FAILURE_CODE.HostAccessRequired,
            providerId: PROVIDER_ID.OpenAI,
        });

        ProviderHostAccessActions.test(
            createInput({
                providerId: PROVIDER_ID.OpenRouter,
                hostAccessStatus: PROVIDER_HOST_ACCESS_STATUS.Granted,
            }),
            harness.effects,
        );

        await vi.waitFor(() => {
            expect(harness.showTestUnavailable).toHaveBeenCalledWith(
                PROVIDER_ID.OpenRouter,
            );
        });
        expect(harness.markAccessMissing).not.toHaveBeenCalled();
        expect(harness.applyTestResponse).not.toHaveBeenCalled();
    });

    it.each([
        ['malformed response', { ok: true, valid: true, extra: 'field' }],
        ['generic error', { ok: false, error: 'raw provider failure' }],
    ] as const)('uses safe unavailable state for %s', async (_label, value) => {
        const harness = createEffectsHarness();
        harness.sendTest.mockResolvedValue(value);

        ProviderHostAccessActions.test(
            createInput({
                hostAccessStatus: PROVIDER_HOST_ACCESS_STATUS.Granted,
            }),
            harness.effects,
        );

        await vi.waitFor(() => {
            expect(harness.showTestUnavailable).toHaveBeenCalledWith(
                PROVIDER_ID.OpenRouter,
            );
        });
        expect(harness.applyTestResponse).not.toHaveBeenCalled();
    });

    it('uses safe unavailable state when the runtime request rejects', async () => {
        const harness = createEffectsHarness();
        harness.sendTest.mockRejectedValue(new Error('raw runtime rejection'));

        ProviderHostAccessActions.test(
            createInput({
                hostAccessStatus: PROVIDER_HOST_ACCESS_STATUS.Granted,
            }),
            harness.effects,
        );

        await vi.waitFor(() => {
            expect(harness.showTestUnavailable).toHaveBeenCalledWith(
                PROVIDER_ID.OpenRouter,
            );
        });
        expect(harness.applyTestResponse).not.toHaveBeenCalled();
    });
});
