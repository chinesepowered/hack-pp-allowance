import type { Metadata } from "next";
import Link from "next/link";
import { Kip, type KipMood } from "@/components/Kip";

export const metadata: Metadata = { title: "Meet Kip, the Allowance capybara" };

const MOODS: { mood: KipMood; name: string; when: string }[] = [
  { mood: "idle", name: "Ready", when: "Waiting for a request in the chat." },
  { mood: "thinking", name: "Working", when: "Searching, comparing, or checking the rules." },
  { mood: "happy", name: "Paid", when: "A purchase passed the rules and PayPal captured it." },
  { mood: "wait", name: "Asking", when: "Something needs a parent's OK. Nothing is charged yet." },
  { mood: "sorry", name: "No can do", when: "A rule blocks the request, or a payment did not go through." },
  { mood: "paused", name: "Paused", when: "A parent switched spending off." },
];

/** Kip's character sheet: every pose the product uses, and when. */
export default function KipPage() {
  return (
    <main className="mx-auto h-dvh max-w-4xl overflow-y-auto px-4 py-8">
      <p className="text-sm">
        <Link href="/" className="font-semibold text-[var(--color-pond-deep)] underline">
          Back to the demo
        </Link>
      </p>
      <h1 className="mt-3 font-display text-3xl font-extrabold">Meet Kip</h1>
      <p className="mt-2 max-w-2xl text-[var(--color-ink-2)]">
        Kip is a young capybara in a bucket hat with a tiny backpack. Kip is the teen&apos;s shopping buddy: casual with the teen, polite and precise with the parent. Kip is an original character drawn as SVG for this project.
      </p>
      <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {MOODS.map((m) => (
          <li key={m.mood} className="card flex flex-col items-center p-4 text-center">
            <div data-kip={m.mood}>
              <Kip mood={m.mood} size={168} />
            </div>
            <h2 className="mt-2 font-display text-lg font-extrabold">{m.name}</h2>
            <p className="text-sm text-[var(--color-ink-2)]">{m.when}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
