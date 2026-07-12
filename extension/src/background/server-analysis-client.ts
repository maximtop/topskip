import * as v from 'valibot';

import { MIME_APPLICATION_JSON } from '@/shared/constants';
import {
    TOPSKIP_LOCAL_BACKEND_BASE_URL,
    buildServerAnalysisRequest,
    serverAnalysisResponseSchema,
    type ServerAnalysisResponse,
} from '@/shared/server-analysis-contract';

const SERVER_ANALYSIS_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Background-owned client for the local TopSkip backend; static API only.
 */
export class ServerAnalysisClient {
    /**
     * Requests the current server analysis state for a video.
     *
     * @param input - Current video metadata and extension version.
     * @returns Validated server analysis response from the local backend.
     */
    static async requestAnalysis(input: {
        videoId: string;
        durationSec?: number;
        extensionVersion: string;
    }): Promise<ServerAnalysisResponse> {
        const request = buildServerAnalysisRequest(input);
        return ServerAnalysisClient.requestBackendJson({
            url: `${TOPSKIP_LOCAL_BACKEND_BASE_URL}/v1/analysis`,
            init: {
                method: 'POST',
                headers: {
                    accept: MIME_APPLICATION_JSON,
                    'content-type': MIME_APPLICATION_JSON,
                },
                body: JSON.stringify(request),
            },
        });
    }

    /**
     * Requests the latest state for an existing backend analysis job.
     *
     * @param jobId - Local backend job id from a processing response.
     * @returns Validated server analysis response from the local backend.
     */
    static async requestJobStatus(
        jobId: string,
    ): Promise<ServerAnalysisResponse> {
        return ServerAnalysisClient.requestBackendJson({
            url:
                `${TOPSKIP_LOCAL_BACKEND_BASE_URL}/v1/analysis/jobs/` +
                encodeURIComponent(jobId),
            init: {
                method: 'GET',
                headers: {
                    accept: MIME_APPLICATION_JSON,
                },
            },
        });
    }

    /**
     * Fetches JSON from the local backend with the shared timeout policy.
     *
     * @param input - Request URL and fetch init without a signal.
     * @returns Validated server analysis response.
     */
    private static async requestBackendJson(input: {
        url: string;
        init: RequestInit;
    }): Promise<ServerAnalysisResponse> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, SERVER_ANALYSIS_REQUEST_TIMEOUT_MS);

        try {
            const res = await fetch(input.url, {
                ...input.init,
                signal: controller.signal,
            });
            // Fetch JSON is untyped; Valibot validates the boundary before use.
            const json = (await res.json()) as unknown;
            if (res.status === 429) {
                return v.parse(serverAnalysisResponseSchema, json);
            }
            if (!res.ok) {
                throw new Error(
                    `Server analysis failed with HTTP ${res.status}`,
                );
            }
            return v.parse(serverAnalysisResponseSchema, json);
        } catch (error) {
            if (controller.signal.aborted) {
                throw new Error('Server analysis timed out.');
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }
}
