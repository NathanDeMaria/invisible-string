import { useEffect, useRef } from "react";

import { SHORTCUTS } from "./shortcuts";

interface Props {
  onClose: () => void;
}

/**
 * The sheet `?` opens.
 *
 * A plain element rather than `<dialog>`: what this needs from a modal is the
 * Escape key, a backdrop that closes, and focus that starts inside and comes
 * back out -- all of which is the code below, without depending on a native
 * behaviour that differs between the browsers and the test DOM.
 *
 * Focus is returned to whatever opened it, which for a shortcut press is
 * whatever the reader was on. Closing a help sheet should put you back where
 * you were, not at the top of the document.
 */
export function ShortcutsDialog({ onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const closer = useRef<() => void>(onClose);
  closer.current = onClose;

  useEffect(() => {
    const opener = document.activeElement;
    panel.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closer.current();
    }
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  return (
    <div className="keys-backdrop" onClick={onClose}>
      <div
        className="keys-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="keys-title"
        tabIndex={-1}
        ref={panel}
        // The backdrop closes; the sheet is not the backdrop.
        onClick={(event) => event.stopPropagation()}
      >
        <div className="keys-head">
          <h2 id="keys-title">Keyboard shortcuts</h2>
          <button type="button" className="as-link" onClick={onClose}>
            Close
          </button>
        </div>

        {SHORTCUTS.map((group) => (
          <section key={group.where}>
            <h3>{group.where}</h3>
            <dl>
              {group.shortcuts.map((shortcut) => (
                <div key={shortcut.does}>
                  <dt>
                    {shortcut.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dt>
                  <dd>{shortcut.does}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
