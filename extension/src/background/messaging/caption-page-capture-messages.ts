import browser from '@/shared/browser';
import { CAPTION_CAPTURE_FAILURE_REASON } from '@/shared/messages';

const PAGE_API = '__topskipCaptionCaptureApi';
const CAPTION_PAGE_BRIDGE_FILE = 'caption-page-bridge.js';

/**
 * Page bridge method that enables captions for capture.
 */
const BRIDGE_ACTIVATE = 'activateCaptions';

/**
 * Page bridge method that restores original caption state.
 */
const BRIDGE_DEACTIVATE = 'deactivateCaptions';

/**
 * Bridge commands supported by MAIN-world caption capture.
 */
type BridgeCommand = typeof BRIDGE_ACTIVATE | typeof BRIDGE_DEACTIVATE;

/**
 * Prefers Chrome's native scripting API for MAIN-world instrumentation.
 *
 * @returns `chrome.scripting` or the polyfill `browser.scripting`.
 */
function getScriptingApi(): typeof browser.scripting {
    const chromeProp: unknown = Reflect.get(globalThis, 'chrome');
    const scripting: unknown =
        chromeProp && typeof chromeProp === 'object'
            ? Reflect.get(chromeProp, 'scripting')
            : undefined;
    return (
        (scripting as typeof browser.scripting | undefined) ?? browser.scripting
    );
}

/**
 * Installs and commands the page-world caption capture bridge; static API only.
 */
export class CaptionPageCaptureMessages {
    /**
     * Injects the canonical bridge bundle into a tab that missed registration.
     *
     * @param tabId Sender tab id.
     * @returns Installation acknowledgement.
     */
    static async install(
        tabId: number | undefined,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        if (tabId === undefined) {
            return { ok: false, error: 'No tab id' };
        }

        try {
            const scripting = getScriptingApi();
            await scripting.executeScript({
                target: { tabId, frameIds: [0] },
                world: 'MAIN',
                files: [CAPTION_PAGE_BRIDGE_FILE],
            });
            return { ok: true };
        } catch (error) {
            return { ok: false, error: String(error) };
        }
    }

    /**
     * Activates captions through the installed MAIN-world bridge.
     *
     * @param tabId Sender tab id.
     * @returns Bridge activation result.
     */
    static activate(tabId: number | undefined): Promise<unknown> {
        return CaptionPageCaptureMessages.runBridgeCommand(
            tabId,
            BRIDGE_ACTIVATE,
        );
    }

    /**
     * Restores caption state through the installed MAIN-world bridge.
     *
     * @param tabId Sender tab id.
     * @returns Bridge cleanup result.
     */
    static deactivate(tabId: number | undefined): Promise<unknown> {
        return CaptionPageCaptureMessages.runBridgeCommand(
            tabId,
            BRIDGE_DEACTIVATE,
        );
    }

    /**
     * Runs a named method from the installed page bridge API.
     *
     * @param tabId Sender tab id.
     * @param methodName Page bridge method to call.
     * @returns Method result, or a bounded failure.
     */
    private static async runBridgeCommand(
        tabId: number | undefined,
        methodName: BridgeCommand,
    ): Promise<unknown> {
        if (tabId === undefined) {
            return {
                ok: false,
                reason: CAPTION_CAPTURE_FAILURE_REASON.BridgeInstallFailed,
                error: 'No tab id',
            };
        }

        try {
            const scripting = getScriptingApi();
            const results: unknown = await scripting.executeScript({
                target: { tabId, frameIds: [0] },
                world: 'MAIN',
                func: (
                    pageApiFlag: string,
                    commandName: string,
                    bridgeInstallFailedReason: string,
                ): unknown => {
                    const api: unknown = Reflect.get(globalThis, pageApiFlag);
                    if (api === null || typeof api !== 'object') {
                        return {
                            ok: false,
                            reason: bridgeInstallFailedReason,
                            error: 'Caption bridge is not installed',
                        };
                    }
                    const command: unknown = Reflect.get(api, commandName);
                    if (typeof command !== 'function') {
                        return {
                            ok: false,
                            reason: bridgeInstallFailedReason,
                            error: 'Caption bridge command is unavailable',
                        };
                    }
                    return Reflect.apply(command, api, []);
                },
                args: [
                    PAGE_API,
                    methodName,
                    CAPTION_CAPTURE_FAILURE_REASON.BridgeInstallFailed,
                ],
            });
            const firstResult: unknown = Array.isArray(results)
                ? Reflect.get(results, '0')
                : undefined;
            if (firstResult === null || typeof firstResult !== 'object') {
                return undefined;
            }
            return Reflect.get(firstResult, 'result');
        } catch (error) {
            return {
                ok: false,
                reason: CAPTION_CAPTURE_FAILURE_REASON.BridgeInstallFailed,
                error: String(error),
            };
        }
    }
}
