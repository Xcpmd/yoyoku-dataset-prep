import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../components/Icon";
import { Kbd } from "../components/ui";
import { classNames } from "../lib/utils";
import { S } from "../lib/strings";

export interface PaletteCommand {
  id: string;
  label: string;
  icon?: IconName;
  hint?: string;
  keywords?: string;
  run: () => void | Promise<void>;
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.keywords || ""}`.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>(".palette-item.active");
    element?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const run = async (command: PaletteCommand) => {
    onClose();
    await command.run();
  };

  return createPortal(
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label={S.palette.title}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={S.palette.placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((current) => (filtered.length ? (current + 1) % filtered.length : 0));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current) => (filtered.length ? (current - 1 + filtered.length) % filtered.length : 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const command = filtered[active];
              if (command) void run(command);
            }
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {filtered.length === 0 ? (
            <div className="empty" style={{ padding: "32px 16px" }}>
              <p>{S.palette.noResults}</p>
            </div>
          ) : (
            filtered.map((command, index) => (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={index === active}
                className={classNames("palette-item", index === active && "active")}
                onMouseEnter={() => setActive(index)}
                onClick={() => void run(command)}
              >
                {command.icon ? <Icon name={command.icon} /> : <Icon name="dot" />}
                <span>{command.label}</span>
                {command.hint ? (
                  <span className="palette-hint">
                    {command.hint.includes("+") ? (
                      <span className="row" style={{ gap: 2 }}>
                        {command.hint.split("+").map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </span>
                    ) : (
                      command.hint
                    )}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
