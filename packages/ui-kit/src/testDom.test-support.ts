/** The ui-kit's DOM test support: the DOM guards, from the contract's test
 * entry point so core, packages and plugins share one implementation, and
 * a media query a test can answer. */
export { elementOf, instanceOf } from "@keepdeck/plugin-api/testing";

/** The browser's answer to a media query, which happy-dom never varies: a
 * real EventTarget, so a preference that changes reaches the fold's listener
 * as a browser's `change` would. */
export class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  onchange: MediaQueryList["onchange"] = null;
  constructor(
    readonly media: string,
    public matches: boolean,
  ) {
    super();
  }
  addListener(): void {}
  removeListener(): void {}
  /** The person changed the preference: answer anew and say so. */
  change(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new MediaQueryListEvent("change", { matches, media: this.media }));
  }
}
