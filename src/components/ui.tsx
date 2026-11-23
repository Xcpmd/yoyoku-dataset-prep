import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import { classNames } from "../lib/utils";

export function Spinner({ size, className }: { size?: "lg"; className?: string }) {
  return <span className={classNames("spinner", size === "lg" && "lg", className)} aria-hidden />;
}

export function Progress({ value, danger }: { value: number; danger?: boolean }) {
  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <div
      className={classNames("progress", danger && "danger")}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={classNames("switch", disabled && "disabled")} style={disabled ? { opacity: 0.5 } : undefined}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
      <span className="track" />
      <span className="switch-label">{label}</span>
    </label>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={classNames("field", className)}>
      {label ? <span className="label">{label}</span> : null}
      {children}
      {error ? <span className="error-text">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  compact,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: ReactNode; icon?: IconName }[];
  onChange: (value: T) => void;
  compact?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className={classNames("segmented", compact && "compact")} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className={classNames(option.value === value && "active")}
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
        >
          {option.icon ? <Icon name={option.icon} className="sm" /> : null}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
  dot,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  className?: string;
  dot?: boolean;
}) {
  return (
    <span className={classNames("badge", tone, className)}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  active,
  disabled,
  size,
  className,
}: {
  icon: IconName;
  label: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  size?: "sm";
  className?: string;
}) {
  return (
    <button
      type="button"
      className={classNames("btn icon", size === "sm" && "sm", active && "active", className)}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} />
    </button>
  );
}

export function EmptyState({
  icon = "image",
  title,
  body,
  actions,
}: {
  icon?: IconName;
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={28} />
      </div>
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

export function Notice({
  tone = "info",
  icon,
  children,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  icon?: IconName;
  children: ReactNode;
}) {
  const defaultIcon: IconName =
    tone === "danger" ? "alert" : tone === "warning" ? "alert" : tone === "success" ? "check-circle" : "info";
  return (
    <div className={classNames("notice", tone)}>
      <Icon name={icon || defaultIcon} className="sm" style={{ marginTop: 1 }} />
      <div>{children}</div>
    </div>
  );
}

/* ── Modal ─────────────────────────────────────────────────────── */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width,
  closeOnBackdrop = true,
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: "wide" | "xwide" | "sm";
  closeOnBackdrop?: boolean;
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const timeouts: number[] = [];
    timeouts.push(
      window.setTimeout(() => {
        const root = ref.current;
        if (!root) return;
        const preferred = initialFocus ? root.querySelector<HTMLElement>(initialFocus) : null;
        const target = preferred || root.querySelector<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        target?.focus();
      }, 20),
    );
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const root = ref.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      timeouts.forEach((id) => window.clearTimeout(id));
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [open, initialFocus]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && closeOnBackdrop) onClose();
      }}
    >
      <div
        className={classNames("modal", width === "wide" && "wide", width === "xwide" && "xwide")}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        ref={ref}
      >
        <div className="modal-head">
          <div className="grow">
            <h2>{title}</h2>
            {subtitle ? <div className="sub">{subtitle}</div> : null}
          </div>
          <IconButton icon="x" label="关闭" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={classNames("btn", danger ? "danger" : "primary")}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      {body ? <div className="small muted" style={{ lineHeight: 1.7 }}>{body}</div> : null}
    </Modal>
  );
}

export function PromptDialog({
  open,
  title,
  body,
  label,
  placeholder,
  confirmLabel = "确认",
  danger,
  required,
  busy,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  body?: ReactNode;
  label?: ReactNode;
  placeholder?: string;
  confirmLabel?: string;
  danger?: boolean;
  required?: boolean;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setValue("");
      setError(null);
    }
  }, [open]);
  const submit = () => {
    if (required && !value.trim()) {
      setError("请填写内容");
      return;
    }
    onSubmit(value.trim());
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      initialFocus="textarea, input"
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={classNames("btn", danger ? "danger" : "primary")}
            onClick={submit}
            disabled={busy}
          >
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack">
        {body ? <div className="small muted" style={{ lineHeight: 1.7 }}>{body}</div> : null}
        <Field label={label} error={error}>
          <textarea
            className="textarea"
            style={{ minHeight: 90 }}
            placeholder={placeholder}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submit();
            }}
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ── Dropdown ──────────────────────────────────────────────────── */
export function Dropdown({
  renderTrigger,
  children,
  align = "start",
  width = 240,
}: {
  renderTrigger: (toggle: () => void, open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top?: number; bottom?: number; left: number; maxHeight: number }>({
    left: 0,
    maxHeight: 400,
  });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => {
    setOpen((current) => {
      if (current) return false;
      const anchor = anchorRef.current;
      if (anchor) {
        const rect = anchor.getBoundingClientRect();
        const menuWidth = Math.min(width, window.innerWidth - 16);
        let left = align === "end" ? rect.right - menuWidth : rect.left;
        left = Math.min(Math.max(8, left), window.innerWidth - menuWidth - 8);
        const spaceBelow = window.innerHeight - rect.bottom - 12;
        const spaceAbove = rect.top - 12;
        if (spaceBelow < 260 && spaceAbove > spaceBelow) {
          setPosition({
            bottom: window.innerHeight - rect.top + 6,
            left,
            maxHeight: Math.max(180, Math.min(spaceAbove, 560)),
          });
        } else {
          setPosition({
            top: rect.bottom + 6,
            left,
            maxHeight: Math.max(180, Math.min(spaceBelow, 560)),
          });
        }
      }
      return true;
    });
  }, [align, width]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (
        menuRef.current?.contains(event.target as Node) ||
        anchorRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    const timer = window.setTimeout(() => {
      const first = menuRef.current?.querySelector<HTMLElement>(".menu-item");
      first?.focus();
    }, 20);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.clearTimeout(timer);
    };
  }, [open, close]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(".menu-item:not([disabled])") || [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    if (event.key === "End") next = items.length - 1;
    items[next]?.focus();
  };

  return (
    <>
      <span ref={anchorRef} style={{ display: "inline-flex" }}>
        {renderTrigger(toggle, open)}
      </span>
      {open
        ? createPortal(
            <div
              className="menu"
              ref={menuRef}
              role="menu"
              style={{
                position: "fixed",
                top: position.top,
                bottom: position.bottom,
                left: position.left,
                width: Math.min(width, window.innerWidth - 16),
                maxHeight: position.maxHeight,
                overflow: "auto",
                zIndex: 110,
              }}
              onKeyDown={onMenuKeyDown}
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export interface SelectOption {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

/**
 * 自绘下拉选择器，替代原生的系统弹层，保证菜单与全站 Apple 风格一致。
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = "请选择",
  ariaLabel,
  className,
  disabled,
  title,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  }>({ left: 0, width: 180, maxHeight: 320 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, 180);
    let left = rect.left;
    left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    const spaceBelow = window.innerHeight - rect.bottom - 10;
    const spaceAbove = rect.top - 10;
    if (spaceBelow < 220 && spaceAbove > spaceBelow) {
      setPosition({
        bottom: window.innerHeight - rect.top + 6,
        left,
        width,
        maxHeight: Math.max(180, Math.min(spaceAbove, 360)),
      });
    } else {
      setPosition({
        top: rect.bottom + 6,
        left,
        width,
        maxHeight: Math.max(180, Math.min(spaceBelow, 360)),
      });
    }
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        close(true);
      }
    };
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      close(false);
    };
    const onResize = () => close(false);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    const timer = window.setTimeout(() => {
      const preferred =
        menuRef.current?.querySelector<HTMLElement>(".select-option.selected") ||
        menuRef.current?.querySelector<HTMLElement>(".select-option:not([disabled])");
      preferred?.focus();
      preferred?.scrollIntoView({ block: "nearest" });
    }, 20);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.clearTimeout(timer);
    };
  }, [open, close]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(".select-option:not([disabled])") || [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    if (event.key === "End") next = items.length - 1;
    items[next]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={classNames("select", "select-trigger", open && "open", className)}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) openMenu();
          }
        }}
      >
        <span className={classNames("select-label", !selected && "placeholder")}>
          {selected ? selected.label : placeholder}
        </span>
        <Icon name="chevron-down" className="sm select-chevron" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="select-pop"
              role="listbox"
              aria-label={ariaLabel}
              style={{
                position: "fixed",
                top: position.top,
                bottom: position.bottom,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
                overflowY: "auto",
                zIndex: 130,
              }}
              onKeyDown={onMenuKeyDown}
            >
              {options.length === 0 ? (
                <div className="select-empty">{placeholder}</div>
              ) : (
                options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    className={classNames(
                      "select-option",
                      option.value === value && "selected",
                    )}
                    onClick={() => {
                      onChange(option.value);
                      close(true);
                    }}
                  >
                    <span className="select-option-label">{option.label}</span>
                    {option.hint ? <span className="select-option-hint">{option.hint}</span> : null}
                    {option.value === value ? (
                      <Icon name="check" className="sm select-option-check" />
                    ) : null}
                  </button>
                ))
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  disabled,
  hint,
}: {  icon?: IconName;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={classNames("menu-item", danger && "danger")}
      onClick={onClick}
      disabled={disabled}
    >
      {icon ? <Icon name={icon} className="sm" /> : null}
      <span className="grow">{children}</span>
      {hint ? <span className="hint">{hint}</span> : null}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-label">{children}</div>;
}

export function MenuSeparator() {
  return <div className="menu-sep" />;
}

/* ── Toasts ────────────────────────────────────────────────────── */
export interface ToastItem {
  id: number;
  title?: string;
  message: string;
  tone?: "default" | "success" | "danger" | "warning";
  actionLabel?: string;
  onAction?: () => void;
  duration?: number;
}

const ToastContext = createContext<{
  push: (toast: Omit<ToastItem, "id">) => void;
  remove: (id: number) => void;
}>({ push: () => undefined, remove: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(1);
  const timers = useRef(new Map<number, number>());
  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);
  const push = useCallback(
    (toast: Omit<ToastItem, "id">) => {
      const id = counter.current++;
      setToasts((current) => [...current.slice(-3), { ...toast, id }]);
      const timer = window.setTimeout(() => remove(id), toast.duration ?? 4600);
      timers.current.set(id, timer);
    },
    [remove],
  );
  const value = useMemo(() => ({ push, remove }), [push, remove]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toast-stack" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={classNames("toast", toast.tone)}>
              <Icon
                name={
                  toast.tone === "danger" || toast.tone === "warning"
                    ? "alert"
                    : toast.tone === "success"
                      ? "check-circle"
                      : "info"
                }
                style={{ marginTop: 1, color: toast.tone === "warning" ? "var(--warning)" : undefined }}
              />
              <div className="toast-body">
                {toast.title ? <div className="toast-title">{toast.title}</div> : null}
                <div className="toast-message">{toast.message}</div>
              </div>
              {toast.actionLabel && toast.onAction ? (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    toast.onAction?.();
                    remove(toast.id);
                  }}
                >
                  {toast.actionLabel}
                </button>
              ) : null}
              <IconButton icon="x" label="关闭通知" size="sm" onClick={() => remove(toast.id)} />
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}
