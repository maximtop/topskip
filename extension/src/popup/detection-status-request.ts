import { TOPSKIP_MESSAGE } from '@/shared/messages';
import { POPUP_DETECTION_REQUEST_TIMEOUT_MS } from '@/popup/constants';
import { requestPopupRuntimeMessage } from '@/popup/runtime-message-request';

const DETECTION_STATUS_TIMEOUT_ERROR = 'Detection status request timed out.';

/**
 * Releases popup reconciliation when an MV3 message reply is lost during a
 * service-worker restart.
 *
 * @returns Opaque detection response before the bounded timeout.
 */
export function requestDetectionStatusWithTimeout(): Promise<unknown> {
    return requestPopupRuntimeMessage(
        { type: TOPSKIP_MESSAGE.GET_DETECTION_STATUS },
        POPUP_DETECTION_REQUEST_TIMEOUT_MS,
        DETECTION_STATUS_TIMEOUT_ERROR,
    );
}
