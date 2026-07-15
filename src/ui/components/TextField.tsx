import { useState } from "react";
import { Text, useInput } from "ink";

export interface TextFieldProps {
  isDisabled?: boolean;
  defaultValue?: string;
  placeholder?: string;
  /** Viewport width in cells: the value scrolls horizontally to keep the
   *  cursor visible instead of wrapping. Unset means no clamping. */
  width?: number;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

interface Edit {
  value: string;
  cursor: number;
}

/** Delete the character before the cursor (Backspace). */
export function deleteBefore(value: string, cursor: number): Edit {
  if (cursor === 0) return { value, cursor };
  return {
    value: value.slice(0, cursor - 1) + value.slice(cursor),
    cursor: cursor - 1,
  };
}

/** Delete the character under the cursor (Delete). */
export function deleteAt(value: string, cursor: number): Edit {
  if (cursor === value.length) return { value, cursor };
  return {
    value: value.slice(0, cursor) + value.slice(cursor + 1),
    cursor,
  };
}

/** Delete the whitespace-delimited word before the cursor (Ctrl+W). */
export function deleteWordBefore(value: string, cursor: number): Edit {
  let i = cursor;
  while (i > 0 && value[i - 1] === " ") i--; // eat trailing spaces
  while (i > 0 && value[i - 1] !== " ") i--; // eat the word
  return { value: value.slice(0, i) + value.slice(cursor), cursor: i };
}

/** Cursor position at the start of the word before the cursor (Ctrl+←). */
export function wordLeft(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && value[i - 1] === " ") i--;
  while (i > 0 && value[i - 1] !== " ") i--;
  return i;
}

/** Cursor position past the end of the word after the cursor (Ctrl+→). */
export function wordRight(value: string, cursor: number): number {
  let i = cursor;
  while (i < value.length && value[i] === " ") i++;
  while (i < value.length && value[i] !== " ") i++;
  return i;
}

/** Delete the word after the cursor (Ctrl+Delete / Alt+D). */
export function deleteWordAfter(value: string, cursor: number): Edit {
  return {
    value: value.slice(0, cursor) + value.slice(wordRight(value, cursor)),
    cursor,
  };
}

/** Delete from the cursor to the end of the line (Ctrl+K). */
export function killToEnd(value: string, cursor: number): Edit {
  return { value: value.slice(0, cursor), cursor };
}

/** Insert text at the cursor. */
export function insertAt(value: string, cursor: number, text: string): Edit {
  return {
    value: value.slice(0, cursor) + text + value.slice(cursor),
    cursor: cursor + text.length,
  };
}

const CURSOR = " ";

/**
 * A controlled text input that owns its keymap, so terminal-style editing keys
 * work the way people expect from a shell prompt:
 *   Ctrl+U clear line · Ctrl+W delete word · Ctrl+K kill to end ·
 *   Ctrl+A/Home start · Ctrl+E/End end · ←/→ move · Ctrl+←/→ word jump ·
 *   Backspace delete · Delete forward · Ctrl+Backspace/Delete word · Enter submit
 * (@inkjs/ui's TextInput inserts the letter on Ctrl+combos, so this replaces it.)
 * Always single-line: newlines never enter the value, pastes collapse to one row.
 */
export function TextField({
  isDisabled = false,
  defaultValue = "",
  placeholder = "",
  width,
  onChange,
  onSubmit,
}: TextFieldProps) {
  const [value, setValue] = useState(defaultValue);
  const [cursor, setCursor] = useState(defaultValue.length);

  function apply(next: Edit): void {
    setValue(next.value);
    setCursor(Math.max(0, Math.min(next.value.length, next.cursor)));
    if (next.value !== value) onChange?.(next.value);
  }

  useInput(
    (input, key) => {
      // Leave navigation / app chords to their handlers.
      if (key.upArrow || key.downArrow || key.tab || (key.ctrl && input === "c"))
        return;

      if (key.return) {
        onSubmit?.(value);
        return;
      }

      // Home/End arrive with an empty `input`, so they must be handled
      // before the empty-input ignore below.
      if (key.home) {
        setCursor(0);
        return;
      }
      if (key.end) {
        setCursor(value.length);
        return;
      }

      // Modifier+named-key combos must be handled before the ctrl switch:
      // named keys arrive with an empty input, so they'd hit its default arm
      // and vanish.
      if (key.leftArrow) {
        if (key.ctrl || key.meta) {
          setCursor(wordLeft(value, cursor));
          return;
        }
        setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        if (key.ctrl || key.meta) {
          setCursor(wordRight(value, cursor));
          return;
        }
        setCursor(Math.min(value.length, cursor + 1));
        return;
      }
      if (key.delete) {
        apply(
          key.ctrl || key.meta
            ? deleteWordAfter(value, cursor)
            : deleteAt(value, cursor),
        );
        return;
      }
      if (key.backspace) {
        apply(
          key.ctrl || key.meta
            ? deleteWordBefore(value, cursor)
            : deleteBefore(value, cursor),
        );
        return;
      }

      if (key.ctrl) {
        switch (input) {
          case "u": // clear the whole line
            apply({ value: "", cursor: 0 });
            return;
          case "w": // delete word before cursor
            apply(deleteWordBefore(value, cursor));
            return;
          case "k": // kill to end of line
            apply(killToEnd(value, cursor));
            return;
          case "a": // jump to start
            setCursor(0);
            return;
          case "e": // jump to end
            setCursor(value.length);
            return;
          default:
            return; // swallow other Ctrl combos (never insert the letter)
        }
      }

      if (key.meta) {
        if (input === "d") {
          apply(deleteWordAfter(value, cursor));
        }
        return;
      }
      if (!input) return;
      // The app turns on mouse tracking (for wheel scroll), so the terminal
      // emits SGR sequences like "[<0;62;7M" on every click. Ink hands those
      // to us as input; bracketed-paste terminals also wrap pastes in
      // \x1b[200~…\x1b[201~ markers, and a multi-line paste carries raw
      // newlines that would wrap this one-row field and corrupt the layout.
      // Strip all three; anything left is real typing.
      const text = input
        .replace(/\x1b?\[<\d+;\d+;\d+[Mm]/g, "") // SGR mouse
        .replace(/\x1b\[20[01]~/g, "") // bracketed-paste markers
        .replace(/[\r\n]+/g, ""); // newlines: always single-line
      if (!text) return;
      apply(insertAt(value, cursor, text));
    },
    { isActive: !isDisabled },
  );

  if (isDisabled) {
    return value ? (
      <Text>{value}</Text>
    ) : (
      <Text dimColor>{placeholder}</Text>
    );
  }

  if (value.length === 0) {
    if (placeholder) {
      return (
        <Text>
          <Text inverse>{placeholder[0]}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      );
    }
    return <Text inverse>{CURSOR}</Text>;
  }

  // Compute a viewport window that keeps the cursor visible.
  // The cursor char itself always occupies 1 column inside the viewport.
  const viewW = width && width > 0 ? width : Infinity;
  let viewStart = 0;
  if (value.length + 1 > viewW) {
    // Ensure cursor position is visible: keep at least 1 char of context
    // after the cursor when possible.
    if (cursor >= viewW - 1) {
      viewStart = cursor - viewW + 2;
    }
  }
  const viewEnd = viewStart + viewW;

  const before = value.slice(Math.max(viewStart, 0), cursor);
  const atChar = value[cursor] ?? CURSOR;
  const after =
    cursor < value.length
      ? value.slice(cursor + 1, Math.min(value.length, viewEnd))
      : "";
  return (
    <Text>
      {before}
      <Text inverse>{atChar}</Text>
      {after}
    </Text>
  );
}
