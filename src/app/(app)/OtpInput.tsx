"use client";

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import styles from "./otpInput.module.css";

// 6자리 코드 입력 — **한 칸씩 자동 이동·붙여넣기·백스페이스 이동**.
//
// 로직(useOtpInput)은 외부 컴포넌트에서 가져온 것을 거의 그대로 쓴다(순수 React라
// 의존성이 없다). **표시만 우리 CSS 모듈·브랜드 토큰으로 다시 그렸다** — 원본은
// Tailwind + motion(#4568FF 파랑·stone·emerald)이라 우리 색·빌드와 맞지 않는다.
// 애니메이션(자릿수 크로스페이드·커서 깜빡임·오류 흔들림)은 CSS로 재현했고,
// prefers-reduced-motion 은 CSS 미디어쿼리가 끈다.
//
// 쓰는 곳: 정산 계좌 쿨다운 즉시 해제(공개 확인 번호 — 안 가림) · 간편 비밀번호
// 설정(비밀이라 mask 로 가림). 로그인은 아직 보류.

export type OtpMode = "numeric" | "alphanumeric";

const ALLOW: Record<OtpMode, RegExp> = {
  numeric: /^[0-9]$/,
  alphanumeric: /^[0-9a-zA-Z]$/,
};

export type UseOtpInputOptions = {
  length?: number;
  mode?: OtpMode;
  defaultValue?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
  onComplete?: (value: string) => void;
};

export type OtpCellProps = {
  ref: (el: HTMLInputElement | null) => void;
  value: string;
  disabled: boolean;
  type: "text";
  inputMode: "numeric" | "text";
  autoComplete: string;
  autoCorrect: "off";
  autoCapitalize: "off";
  spellCheck: false;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onPaste: (e: ClipboardEvent<HTMLInputElement>) => void;
  onFocus: (e: FocusEvent<HTMLInputElement>) => void;
  onBlur: (e: FocusEvent<HTMLInputElement>) => void;
};

export type UseOtpInputReturn = {
  chars: string[];
  value: string;
  length: number;
  complete: boolean;
  focusedIndex: number;
  getCellProps: (index: number) => OtpCellProps;
  focusAt: (index: number) => void;
  clear: () => void;
};

export function useOtpInput({
  length = 6,
  mode = "numeric",
  defaultValue = "",
  disabled = false,
  onChange,
  onComplete,
}: UseOtpInputOptions = {}): UseOtpInputReturn {
  const allow = ALLOW[mode];

  const keep = useCallback(
    (text: string) =>
      text
        .split("")
        .filter((c) => allow.test(c))
        .join(""),
    [allow],
  );

  const [chars, setChars] = useState<string[]>(() => {
    const seed = defaultValue
      .split("")
      .filter((c) => ALLOW[mode].test(c))
      .slice(0, length);
    return Array.from({ length }, (_, i) => seed[i] ?? "");
  });
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const charsRef = useRef(chars);
  charsRef.current = chars;

  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const changed = useRef(onChange);
  changed.current = onChange;
  const completed = useRef(onComplete);
  completed.current = onComplete;

  useEffect(() => {
    setChars((prev) =>
      prev.length === length ? prev : Array.from({ length }, (_, i) => prev[i] ?? ""),
    );
    refs.current.length = length;
  }, [length]);

  const commit = useCallback((next: string[]) => {
    charsRef.current = next;
    setChars(next);
    const value = next.join("");
    changed.current?.(value);
    if (next.length > 0 && next.every((c) => c !== "")) completed.current?.(value);
  }, []);

  const focusAt = useCallback(
    (index: number) => {
      const el = refs.current[Math.max(0, Math.min(length - 1, index))];
      if (!el) return;
      el.focus();
      el.select();
    },
    [length],
  );

  const fillFrom = useCallback(
    (index: number, text: string) => {
      const incoming = keep(text);
      if (incoming.length === 0) return;
      const next = [...charsRef.current];
      let cursor = index;
      for (const c of incoming) {
        if (cursor >= length) break;
        next[cursor] = c;
        cursor += 1;
      }
      commit(next);
      focusAt(cursor);
    },
    [commit, focusAt, keep, length],
  );

  const clear = useCallback(() => {
    commit(Array.from({ length }, () => ""));
    focusAt(0);
  }, [commit, focusAt, length]);

  const getCellProps = useCallback(
    (index: number): OtpCellProps => ({
      ref: (el) => {
        refs.current[index] = el;
      },
      value: chars[index] ?? "",
      disabled,
      type: "text",
      inputMode: mode === "numeric" ? "numeric" : "text",
      autoComplete: index === 0 ? "one-time-code" : "off",
      autoCorrect: "off",
      autoCapitalize: "off",
      spellCheck: false,
      onChange: (e) => {
        const previous = charsRef.current[index] ?? "";
        const raw = e.currentTarget.value;
        const trimmed =
          raw.length > 1 && previous && raw.startsWith(previous)
            ? raw.slice(previous.length)
            : raw;
        const incoming = keep(trimmed);

        if (incoming.length === 0) {
          if (raw.length === 0 && previous) {
            const next = [...charsRef.current];
            next[index] = "";
            commit(next);
          }
          e.currentTarget.value = charsRef.current[index] ?? "";
          return;
        }

        if (incoming.length === 1) {
          const next = [...charsRef.current];
          next[index] = incoming;
          e.currentTarget.value = incoming;
          commit(next);
          if (index < length - 1) focusAt(index + 1);
          return;
        }

        fillFrom(index, incoming);
      },
      onKeyDown: (e) => {
        if (e.key === "Backspace") {
          e.preventDefault();
          const current = charsRef.current;
          const next = [...current];
          if (current[index]) {
            next[index] = "";
            commit(next);
            return;
          }
          if (index > 0) {
            next[index - 1] = "";
            commit(next);
            focusAt(index - 1);
          }
          return;
        }
        if (e.key === "Delete") {
          e.preventDefault();
          const next = [...charsRef.current];
          next[index] = "";
          commit(next);
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          focusAt(index - 1);
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          focusAt(index + 1);
          return;
        }
        if (e.key === "Home") {
          e.preventDefault();
          focusAt(0);
          return;
        }
        if (e.key === "End") {
          e.preventDefault();
          focusAt(length - 1);
        }
      },
      onPaste: (e) => {
        e.preventDefault();
        const text = keep(e.clipboardData.getData("text"));
        fillFrom(text.length >= length ? 0 : index, text);
      },
      onFocus: (e) => {
        e.currentTarget.select();
        const firstEmpty = charsRef.current.findIndex((c) => c === "");
        if (firstEmpty !== -1 && firstEmpty < index) {
          focusAt(firstEmpty);
          return;
        }
        setFocusedIndex(index);
      },
      onBlur: (e) => {
        const to = e.relatedTarget as HTMLInputElement | null;
        if (to && refs.current.includes(to)) return;
        setFocusedIndex(-1);
      },
    }),
    [chars, commit, disabled, fillFrom, focusAt, keep, length, mode],
  );

  const value = chars.join("");

  return {
    chars,
    value,
    length,
    complete: chars.length > 0 && chars.every((c) => c !== ""),
    focusedIndex,
    getCellProps,
    focusAt,
    clear,
  };
}

export type OtpStatus = "idle" | "error" | "success";

export type OtpInputHandle = {
  clear: () => void;
  focus: () => void;
};

export type OtpInputProps = {
  length?: number;
  mode?: OtpMode;
  /** 비밀번호처럼 자릿수를 가린다 (간편 비밀번호 설정). 기본은 보임(공개 확인 번호). */
  mask?: boolean;
  status?: OtpStatus;
  disabled?: boolean;
  autoFocus?: boolean;
  focusOnError?: boolean;
  groupEvery?: number;
  ariaLabel?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onComplete?: (value: string) => void;
  className?: string;
  ref?: React.Ref<OtpInputHandle>;
};

export function OtpInput({
  length = 6,
  mode = "numeric",
  mask = false,
  status = "idle",
  disabled = false,
  autoFocus = false,
  focusOnError = true,
  groupEvery = 3,
  ariaLabel = "확인 번호",
  defaultValue = "",
  onChange,
  onComplete,
  className = "",
  ref,
}: OtpInputProps) {
  const { chars, focusedIndex, getCellProps, focusAt, clear } = useOtpInput({
    length,
    mode,
    defaultValue,
    disabled,
    onChange,
    onComplete,
  });

  const wasError = useRef(false);
  const error = status === "error";
  const success = status === "success";

  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        clear();
        focusAt(0);
      },
      focus: () => focusAt(0),
    }),
    [clear, focusAt],
  );

  useEffect(() => {
    if (error && !wasError.current && focusOnError && !disabled) focusAt(0);
    wasError.current = error;
  }, [error, focusOnError, disabled, focusAt]);

  useEffect(() => {
    if (autoFocus && !disabled) focusAt(0);
  }, [autoFocus, disabled, focusAt]);

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`${styles.group} ${error ? styles.shake : ""} ${className}`}
    >
      {Array.from({ length }, (_, i) => {
        const char = chars[i] ?? "";
        const active = focusedIndex === i;
        const gap = groupEvery > 0 && i > 0 && i % groupEvery === 0;

        const cellState = error
          ? styles.errorCell
          : success
            ? styles.successCell
            : active
              ? styles.activeCell
              : char
                ? styles.filledCell
                : "";

        return (
          <div key={i} className={`${styles.cell} ${gap ? styles.cellGap : ""}`}>
            <input
              {...getCellProps(i)}
              aria-label={`${ariaLabel}, ${i + 1} / ${length}`}
              aria-invalid={error || undefined}
              className={`${styles.input} ${cellState}`}
            />
            <span aria-hidden className={styles.overlay}>
              {char ? (
                // key 로 remount → CSS 크로스페이드가 다시 돈다. 마스킹이면 모든 칸이
                // 같은 점이라 값이 바뀌어도 재생하지 않게 "•" 하나로 고정한다
                <span key={mask ? "dot" : char} className={styles.digit}>
                  {mask ? "•" : char}
                </span>
              ) : null}
              {active && !char && !disabled ? <span className={styles.caret} /> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default OtpInput;
