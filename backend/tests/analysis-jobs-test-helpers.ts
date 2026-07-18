import {
    BackendAnalysisJobs,
    type AnalysisJobStartInput,
    type BackendAnalysisJobResponse,
    type LegacyAnalysisJobStartInput,
    type UploadAnalysisJobStartInput,
} from '@topskip/backend/analysis-jobs';

const TEST_INSTALLATION_HASH = 'local-development';
const TEST_IP_HASH = 'test-ip-hash';

type LegacyAnalysisJobTestInput = Omit<
    LegacyAnalysisJobStartInput,
    'source' | 'installationHash' | 'ipHash'
> & {
    ownerInstallationHash?: string;
};

type AnalysisJobTestInput =
    | UploadAnalysisJobStartInput
    | LegacyAnalysisJobTestInput;

/**
 * Keeps historical extraction fixtures explicit without weakening production routing.
 *
 * @param input - Upload input or legacy fixture parameters.
 * @returns Processing or terminal response from the shared scheduler.
 */
export function startAnalysisJobForTest(
    input: AnalysisJobTestInput,
): BackendAnalysisJobResponse {
    if ('source' in input) {
        return BackendAnalysisJobs.start(input);
    }
    const { ownerInstallationHash, ...legacyInput } = input;
    const strictInput: AnalysisJobStartInput = {
        ...legacyInput,
        source: 'legacy_yt_dlp',
        installationHash: ownerInstallationHash ?? TEST_INSTALLATION_HASH,
        ipHash: TEST_IP_HASH,
    };
    return BackendAnalysisJobs.start(strictInput);
}
