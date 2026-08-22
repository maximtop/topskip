import { TOPSKIP_MESSAGE } from '@/shared/messages';
import { POPUP_REATTACH_REQUEST_TIMEOUT_MS } from '@/popup/constants';
import { requestPopupRuntimeMessage } from '@/popup/runtime-message-request';

const REATTACH_TIMEOUT_ERROR = 'Content script re-attach request timed out.';

/**
 * Asks the background to re-attach the watch bundles into the active tab.
 *
 * Opening the popup is the user gesture that grants `activeTab`, so this is
 * sent once at popup start; the background decides whether the tab needs it.
 *
 * @returns Opaque re-attach response before the bounded timeout.
 */
export function requestContentScriptReattachWithTimeout(): Promise<unknown> {
    return requestPopupRuntimeMessage(
        { type: TOPSKIP_MESSAGE.REATTACH_CONTENT_SCRIPT },
        POPUP_REATTACH_REQUEST_TIMEOUT_MS,
        REATTACH_TIMEOUT_ERROR,
    );
}
