import { useState } from "react";
import { Text, useInput } from "ink";

export interface TextFieldProps {
  isDisabled?: boolean;
  defaultValue?: string;
  placeholder?: string;
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

/** Delete the whitespace-delimited word before the cursor (Ctrl+W). */
export function deleteWordBefore(value: string, cursor: number): Edit {
  let i = cursor;
  while (i > 0 && value[i - 1] === " ") i--; // eat trailing spaces
  while (i > 0 && value[i - 1] !== " ") i--; // eat the word
  return { value: value.slice(0, i) + value.slice(cursor), cursor: i };
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
 *   Ctrl+A/Home start · Ctrl+E/End end · ←/→ move · Backspace delete · Enter submit
 * (@inkjs/ui's TextInput inserts the letter on Ctrl+combos, so this replaces it.)
 */
export function TextField({
  isDisabled = false,
  defaultValue = "",
  placeholder = "",
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

      if (key.leftArrow) {
        setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(value.length, cursor + 1));
        return;
      }
      if (key.backspace || key.delete) {
        apply(deleteBefore(value, cursor));
        return;
      }
      if (key.meta || !input) return; // ignore Alt combos / empty
      // The app turns on mouse tracking (for wheel scroll), so the terminal
      // emits SGR sequences like "[<0;62;7M" on every click. Ink hands those
      // to us as input. Strip them so a mouse click never dumps escape codes
      // into the field. Anything left is real typing.
      const text = input.replace(/\x1b?\[<\d+;\d+;\d+[Mm]/g, "");
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

  const before = value.slice(0, cursor);
  const atChar = value[cursor] ?? CURSOR;
  const after = cursor < value.length ? value.slice(cursor + 1) : "";
  return (
    <Text>
      {before}
      <Text inverse>{atChar}</Text>
      {after}
    </Text>
  );
}
