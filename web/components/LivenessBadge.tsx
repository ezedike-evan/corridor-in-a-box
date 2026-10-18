import { CircleCheck, CircleHelp, CircleSlash } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import type { LivenessState } from "@/lib/corridors";

// Green is reserved for corridors whose endpoints someone has actually checked.
// A lane with plausible-looking URLs that nobody has confirmed is amber, not
// green — the badge reports what we know, not what the YAML claims.
const BADGE: Record<
  LivenessState,
  { variant: "success" | "warning" | "default"; Icon: typeof CircleCheck; label: string }
> = {
  proven: { variant: "success", Icon: CircleCheck, label: "proven" },
  verified: { variant: "success", Icon: CircleCheck, label: "verified" },
  unverified: { variant: "warning", Icon: CircleHelp, label: "unverified" },
  "not-runnable": { variant: "default", Icon: CircleSlash, label: "not runnable" },
};

export function LivenessBadge({ state }: { state: LivenessState }) {
  const badge = BADGE[state];
  return (
    <Badge variant={badge.variant}>
      <badge.Icon size={12} /> {badge.label}
    </Badge>
  );
}
