import { clsx } from "clsx";
import type { HTMLAttributes } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  selected?: boolean;
}

export function Card({ selected, className, ...props }: CardProps) {
  return (
    <div
      className={clsx(
        "rounded-xl border bg-background p-5 shadow-sm transition-colors",
        selected ? "border-blue-500 ring-2 ring-blue-500" : "border-border",
        className,
      )}
      {...props}
    />
  );
}
