"use client";

import * as React from "react";
import s from "./glassButton.module.css";

// 글래스모피즘 버튼 — 순수 CSS(CSS Module). Tailwind·cva 없이 size 변형만 클래스로 가른다.
// 유리 질감(반투명 + backdrop-blur + 얇은 테두리 + 그림자 + hover 전환)은 glassButton.module.css.
export type GlassButtonSize = "sm" | "default" | "lg" | "icon";
// tone — 유리 색조. light = 기본 흰 유리(어두운 배경용), mint = 민트 유리(흰 배경에서도 보임)
export type GlassButtonTone = "light" | "mint";

export interface GlassButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: GlassButtonSize;
  tone?: GlassButtonTone;
  contentClassName?: string;
}

const SIZE_CLASS: Record<GlassButtonSize, string> = {
  sm: s.sm,
  default: s.default,
  lg: s.lg,
  icon: s.icon,
};

export const GlassButton = React.forwardRef<HTMLButtonElement, GlassButtonProps>(
  ({ className, children, size = "default", tone = "light", contentClassName, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={[s.glassButton, SIZE_CLASS[size], tone === "mint" ? s.mint : "", className]
          .filter(Boolean)
          .join(" ")}
        {...props}
      >
        <span className={[s.content, contentClassName].filter(Boolean).join(" ")}>{children}</span>
      </button>
    );
  },
);
GlassButton.displayName = "GlassButton";
