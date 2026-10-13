import { buttonVariants } from "@cloudflare/kumo/components/button";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { PeekDrawer } from "@/components/peek-drawer";

/** The click-to-peek contract every list shares: plain click opens
 * the dialog; modified clicks keep native nav. peek(row) sets the
 * peeked entity; <peek.Drawer> renders only while one's open. */
export function usePeek<T>() {
  const [peeked, setPeeked] = useState<T | null>(null);
  const peek = (item: T) => setPeeked(item);
  const peekOnClick = (item: T) => (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    setPeeked(item);
  };
  const Drawer = ({ children }: { children: React.ReactNode }) => (
    <PeekDrawer
      open={peeked !== null}
      onOpenChange={(o) => !o && setPeeked(null)}
    >
      {children}
    </PeekDrawer>
  );
  return { peek, peekOnClick, peeked, Drawer };
}

/** Peek header grammar: chips/meta row, title, open-full-page button. */
export function PeekHeader({
  meta,
  title,
  href,
}: {
  meta?: React.ReactNode;
  title: string;
  href: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        {meta ? <div className="flex items-center gap-2">{meta}</div> : null}
        <h2 className="text-xl font-semibold text-kumo-default">{title}</h2>
      </div>
      <Link
        to={href as never}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        Open full page
        <ArrowSquareOut />
      </Link>
    </div>
  );
}
