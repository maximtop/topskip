import { Content } from '@/content/content';

const CONTENT_DISPOSE_KEY = '__topskipWatchContentDispose';
const previousDispose: unknown = Reflect.get(globalThis, CONTENT_DISPOSE_KEY);
if (typeof previousDispose === 'function') {
    try {
        Reflect.apply(previousDispose, undefined, []);
    } catch {
        // A stale extension context must not prevent the replacement bundle.
    }
}
Reflect.set(globalThis, CONTENT_DISPOSE_KEY, Content.init());
