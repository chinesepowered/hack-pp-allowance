/**
 * Kip: a young capybara in a bucket hat with a tiny backpack.
 * An original character drawn here as SVG. Kip is the teen's shopping
 * buddy and shows up in loading, success, waiting and empty states.
 */
import type { CSSProperties } from "react";

export type KipMood = "idle" | "happy" | "thinking" | "sorry" | "wait" | "paused";

const LABEL: Record<KipMood, string> = {
  idle: "Kip the capybara",
  happy: "Kip the capybara, pleased",
  thinking: "Kip the capybara, thinking",
  sorry: "Kip the capybara, apologetic",
  wait: "Kip the capybara, waiting",
  paused: "Kip the capybara, paused",
};

export function Kip({ mood = "idle", size = 72, className, decorative = false, style }: { mood?: KipMood; size?: number; className?: string; decorative?: boolean; style?: CSSProperties }) {
  const fur = "var(--color-kip)";
  const furDark = "var(--color-kip-dark)";
  const furLight = "var(--color-kip-light)";
  const hat = mood === "paused" ? "#6b7785" : "var(--color-hat)";
  const pack = "var(--color-pack)";
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      style={style}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : LABEL[mood]}
    >
      {/* backpack peeking out behind the shoulder */}
      <rect x="14" y="66" width="26" height="34" rx="9" fill={pack} />
      <rect x="19" y="78" width="16" height="10" rx="4" fill="#fff" opacity="0.35" />
      <rect x="24" y="62" width="6" height="8" rx="3" fill="#c24a2c" />

      {/* body */}
      <path d="M30 118 C26 92 34 74 60 74 C86 74 94 92 90 118 Z" fill={fur} />
      <path d="M44 118 C43 104 49 94 60 94 C71 94 77 104 76 118 Z" fill={furLight} opacity="0.75" />
      {/* backpack strap across the chest */}
      <path d="M38 84 C44 96 46 106 46 118" stroke={pack} strokeWidth="5" strokeLinecap="round" fill="none" />

      {/* ears */}
      <ellipse cx="34" cy="38" rx="7" ry="8" fill={furDark} />
      <ellipse cx="86" cy="38" rx="7" ry="8" fill={furDark} />

      {/* head: wide, with the blunt capybara muzzle */}
      <path d="M26 56 C26 36 40 28 60 28 C80 28 94 36 94 56 C94 76 82 86 60 86 C38 86 26 76 26 56 Z" fill={fur} />
      <path d="M38 64 C38 54 47 50 60 50 C73 50 82 54 82 64 C82 76 73 82 60 82 C47 82 38 76 38 64 Z" fill={furLight} />

      {/* bucket hat */}
      <path d="M22 40 C30 34 42 31 60 31 C78 31 90 34 98 40 C99 44 96 46 92 45 C82 41 72 40 60 40 C48 40 38 41 28 45 C24 46 21 44 22 40 Z" fill={hat} />
      <path d="M36 34 C36 20 46 12 60 12 C74 12 84 20 84 34 C76 31 68 30 60 30 C52 30 44 31 36 34 Z" fill={hat} />
      <path d="M36.5 31 C44 28 52 27 60 27 C68 27 76 28 83.5 31" stroke="#fff" strokeWidth="3" fill="none" opacity="0.55" strokeLinecap="round" />

      {/* eyes */}
      {mood === "happy" ? (
        <g stroke="#2a1c10" strokeWidth="3" strokeLinecap="round" fill="none">
          <path d="M42 56 Q46 51 50 56" />
          <path d="M70 56 Q74 51 78 56" />
        </g>
      ) : mood === "sorry" ? (
        <g>
          <circle cx="46" cy="57" r="3.6" fill="#2a1c10" />
          <circle cx="74" cy="57" r="3.6" fill="#2a1c10" />
          <path d="M40 50 L51 53" stroke="#2a1c10" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M80 50 L69 53" stroke="#2a1c10" strokeWidth="2.4" strokeLinecap="round" />
        </g>
      ) : mood === "paused" ? (
        <g stroke="#2a1c10" strokeWidth="3" strokeLinecap="round">
          <path d="M42 56 L50 56" />
          <path d="M70 56 L78 56" />
        </g>
      ) : (
        <g>
          <circle cx="46" cy={mood === "thinking" ? 54.5 : 56} r="4" fill="#2a1c10" />
          <circle cx="74" cy={mood === "thinking" ? 54.5 : 56} r="4" fill="#2a1c10" />
          <circle cx={mood === "thinking" ? 47.5 : 47.3} cy={mood === "thinking" ? 53 : 54.6} r="1.3" fill="#fff" />
          <circle cx={mood === "thinking" ? 75.5 : 75.3} cy={mood === "thinking" ? 53 : 54.6} r="1.3" fill="#fff" />
        </g>
      )}

      {/* nose and mouth */}
      <ellipse cx="60" cy="63" rx="6.5" ry="4.2" fill="#5a3a22" />
      {mood === "happy" ? (
        <path d="M52 70 Q60 78 68 70" stroke="#5a3a22" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      ) : mood === "sorry" ? (
        <path d="M54 74 Q60 70 66 74" stroke="#5a3a22" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      ) : (
        <path d="M55 71 Q60 74.5 65 71" stroke="#5a3a22" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      )}
      {/* cheeks */}
      <circle cx="41" cy="67" r="4" fill="#e9967a" opacity={mood === "happy" ? 0.7 : 0.35} />
      <circle cx="79" cy="67" r="4" fill="#e9967a" opacity={mood === "happy" ? 0.7 : 0.35} />

      {/* mood props */}
      {mood === "thinking" && (
        <g fill="var(--color-pond)">
          <circle cx="99" cy="26" r="2.6" />
          <circle cx="106" cy="18" r="3.6" />
          <circle cx="113" cy="8" r="4.6" />
        </g>
      )}
      {mood === "wait" && (
        <g>
          <circle cx="100" cy="24" r="12" fill="#fff" stroke="var(--color-ask)" strokeWidth="2.5" />
          <path d="M100 17 L100 24 L105 27" stroke="var(--color-ask)" strokeWidth="2.5" strokeLinecap="round" fill="none" />
        </g>
      )}
      {mood === "happy" && (
        <g stroke="var(--color-pond)" strokeWidth="2.6" strokeLinecap="round">
          <path d="M101 14 L101 22" />
          <path d="M97 18 L105 18" />
          <path d="M110 30 L110 35" />
          <path d="M107.5 32.5 L112.5 32.5" />
        </g>
      )}
      {mood === "paused" && (
        <g>
          <circle cx="100" cy="24" r="12" fill="#fff" stroke="#6b7785" strokeWidth="2.5" />
          <rect x="95" y="18" width="3.6" height="12" rx="1.5" fill="#6b7785" />
          <rect x="101.4" y="18" width="3.6" height="12" rx="1.5" fill="#6b7785" />
        </g>
      )}
    </svg>
  );
}

/** Just the head, for the logo and small avatars. */
export function KipHead({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="18 8 84 82" width={size} height={size} className={className} aria-hidden="true">
      <ellipse cx="34" cy="38" rx="7" ry="8" fill="var(--color-kip-dark)" />
      <ellipse cx="86" cy="38" rx="7" ry="8" fill="var(--color-kip-dark)" />
      <path d="M26 56 C26 36 40 28 60 28 C80 28 94 36 94 56 C94 76 82 86 60 86 C38 86 26 76 26 56 Z" fill="var(--color-kip)" />
      <path d="M38 64 C38 54 47 50 60 50 C73 50 82 54 82 64 C82 76 73 82 60 82 C47 82 38 76 38 64 Z" fill="var(--color-kip-light)" />
      <path d="M22 40 C30 34 42 31 60 31 C78 31 90 34 98 40 C99 44 96 46 92 45 C82 41 72 40 60 40 C48 40 38 41 28 45 C24 46 21 44 22 40 Z" fill="var(--color-hat)" />
      <path d="M36 34 C36 20 46 12 60 12 C74 12 84 20 84 34 C76 31 68 30 60 30 C52 30 44 31 36 34 Z" fill="var(--color-hat)" />
      <circle cx="46" cy="56" r="4" fill="#2a1c10" />
      <circle cx="74" cy="56" r="4" fill="#2a1c10" />
      <ellipse cx="60" cy="63" rx="6.5" ry="4.2" fill="#5a3a22" />
      <path d="M55 71 Q60 74.5 65 71" stroke="#5a3a22" strokeWidth="2.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}
