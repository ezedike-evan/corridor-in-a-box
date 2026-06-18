import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { docs } from "@/lib/docs";

export const metadata = {
  title: "Docs — corridor-in-a-box",
};

export default function DocsIndex() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Documentation</h1>
        <p className="mt-1 text-secondary-text">
          Everything you need to understand and run the engine.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {docs.map((d) => (
          <Link
            key={d.slug}
            href={`/docs/${d.slug}`}
            className="group rounded-xl border border-border bg-background p-4 transition-colors hover:border-blue-500"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{d.title}</h2>
              <ArrowRight size={16} className="text-secondary-text group-hover:text-blue-600" />
            </div>
            <p className="mt-1 text-sm text-secondary-text">{d.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
