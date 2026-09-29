import { TestElement } from './test-element';
import { TestMediaElement } from './test-media-element';

/**
 * Player element id the caption bridge looks up by id; kept in sync with the
 * same literal the caller uses to build/query the harness.
 */
const MOVIE_PLAYER_ID = 'movie_player';

/**
 * Minimal `Document` stand-in: `getElementById` resolves the fixed player id
 * plus whatever elements the bridge appended to `documentElement`,
 * `querySelector` resolves the two selectors the bridge issues, and
 * `createElement` hands back fresh `TestElement`s for the bridge's own
 * style-tag insertion.
 */
export class TestDocument extends EventTarget {
    readonly documentElement: { append: (element: TestElement) => void };

    readonly player: TestElement;

    readonly button: TestElement;

    readonly video = new TestMediaElement();

    private readonly elementsById = new Map<string, TestElement>();

    constructor(player: TestElement, button: TestElement) {
        super();
        this.player = player;
        this.button = button;
        this.documentElement = {
            append: (element) => {
                if (element.id.length === 0) {
                    return;
                }
                this.elementsById.set(element.id, element);
                element.setRemoveHandler(() => {
                    this.elementsById.delete(element.id);
                });
            },
        };
    }

    getElementById(id: string): TestElement | null {
        if (id === MOVIE_PLAYER_ID) {
            return this.player;
        }
        return this.elementsById.get(id) ?? null;
    }

    querySelector(selector: string): TestElement | null {
        if (selector === '.ytp-subtitles-button[aria-pressed]') {
            return this.button;
        }
        if (selector.includes('video.html5-main-video')) {
            return this.video;
        }
        return null;
    }

    createElement(): TestElement {
        return new TestElement();
    }
}
