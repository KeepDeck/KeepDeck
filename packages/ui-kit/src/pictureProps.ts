/**
 * How a picture is named — the one rule for a mark that stands for words: on
 * its own it is an image, named for what it says, for assistive tech and the
 * pointer alike; beside words that already say it, it is a picture only,
 * hidden from assistive tech, which would otherwise read it twice.
 */
export function pictureProps(label: string, decorative = false) {
  return decorative ? ({ "aria-hidden": true } as const) : ({ role: "img", "aria-label": label, title: label } as const);
}
