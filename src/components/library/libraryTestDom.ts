/**
 * The DOM the two library dialogs are driven through in their suites: a row
 * by name, a button by text or title, a field by id, and typing into a
 * controlled React field. One copy, so the suites cannot drift in what a
 * click or a keystroke means.
 */
import { act } from "react";

/** The nav row whose name is `name`. */
export const row = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".library__item")).find(
    (b) => b.querySelector(".library__item-name")?.textContent === name,
  );

/** The first button reading exactly `text`. */
export const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent === text);

export const buttonByTitle = (title: string) =>
  document.querySelector<HTMLButtonElement>(`button[title="${title}"]`);

/** The confirm's own button reading `text` — the editor may carry one with
 * the same label (Delete). */
export const confirmButton = (text: string) =>
  Array.from(document.querySelector(".confirm")?.querySelectorAll("button") ?? []).find(
    (b) => b.textContent === text,
  );

export const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
export const textarea = (id: string) => document.querySelector<HTMLTextAreaElement>(`#${id}`)!;

/** Type into a controlled React field: the native setter, then a bubbling
 * `input` — inside `act`, so the state it moves has settled on return. */
export function type(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
