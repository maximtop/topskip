import { Content } from '@/content/content';

/**
 * Guards against double init: the bundle can arrive twice — once from
 * `registerContentScripts` and once from the existing-tab injection pass.
 */
const INSTALL_FLAG = '__topskipWatchContentInstalled';

if (!Reflect.get(globalThis, INSTALL_FLAG)) {
    Reflect.set(globalThis, INSTALL_FLAG, true);
    Content.init();
}
