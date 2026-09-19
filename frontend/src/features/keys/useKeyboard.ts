import { useEffect, useRef } from "react";

/** What a key does, keyed by `KeyboardEvent.key`. */
export type Bindings = Record<
  string,
  ((event: KeyboardEvent) => void) | undefined
>;

/**
 * Page-level keys, listened for on the document.
 *
 * Bindings are read through a ref rather than closed over, so the listener is
 * attached once and every press still runs the *current* handler -- the
 * alternative is re-subscribing on every render of a page whose handlers
 * close over its state, which is most of them.
 *
 * Three things are never a shortcut, and the checks are here rather than in
 * each handler:
 *
 * - **A key already spoken for.** `defaultPrevented` means something nearer
 *   the keystroke has handled it -- a table row's arrow keys, say -- and a
 *   second reading of the same press is how a page ends up scrolling and
 *   navigating at once. React's listener sits on the root container, inside
 *   the document, so it always gets its say first.
 * - **A chord.** Ctrl, Cmd and Alt belong to the browser and the OS; taking
 *   Cmd-R here would break reload for a letter we already have on its own.
 * - **Typing.** A filter box is where `g` means the letter g. Checkboxes and
 *   buttons are not typing, so a shortcut still works from the neutral-site
 *   toggle -- there is no letter it could be eating.
 */
export function useKeyboard(bindings: Bindings, enabled = true): void {
  const latest = useRef(bindings);
  latest.current = bindings;
  const on = useRef(enabled);
  on.current = enabled;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!on.current) return;
      if (event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event.target)) return;

      const handler = latest.current[event.key];
      if (!handler) return;
      // Claimed, so nothing downstream reads it again: arrows don't also
      // scroll, `/` doesn't also open the browser's quick-find.
      event.preventDefault();
      handler(event);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** Whether a keystroke is going somewhere that letters mean letters. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    // A checkbox eats space, not letters. The date field eats arrows, which
    // is exactly why it counts: stepping the day from inside it should move
    // the field, not the page.
    return !NOT_TYPED.has(target.type);
  }
  return false;
}

const NOT_TYPED = new Set(["checkbox", "radio", "button", "submit", "reset"]);
