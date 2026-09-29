import { TestElement } from './test-element';

/**
 * `TestElement` with a `readyState`, standing in for the page's video tag.
 */
export class TestVideoElement extends TestElement {
    readyState = 1;
}
