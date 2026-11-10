"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Copies `value` to the clipboard. The confirmation is announced through a live
 * region as well as shown, so it is not only a change of icon.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
    } catch {
      // Clipboard is unavailable (an insecure context or a denied permission).
      setCopied(false);
      setFailed(true);
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 2000);
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="inline-flex shrink-0 items-center rounded p-1 text-secondary-text transition-colors hover:bg-gray-100 hover:text-gray-900 dark:hover:text-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600 active:scale-95 dark:hover:bg-gray-800"
      >
        {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
      </button>
      <output className="sr-only">
        {copied ? `${label} copied` : failed ? `Could not copy ${label}` : ""}
      </output>
    </>
  );
}
