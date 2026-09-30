import { TestVideoElement } from './test-video-element';

/**
 * `TestVideoElement` with the `HAVE_METADATA` constant the caption bridge
 * reads off `HTMLMediaElement`.
 */
export class TestMediaElement extends TestVideoElement {
    static readonly HAVE_METADATA = 1;
}
