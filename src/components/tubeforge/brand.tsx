// TubeForge brand kit — recreated from the 2026 brand logo (black / red-orange
// gradient "P" play glyph with speed lines, "Tube"+"Forge" wordmark).
// ForgeMark  : icon-only SVG mark (scales anywhere, crisp on every DPI)
// BrandLockup: mark + wordmark (+ optional "IDEAS → VIDEOS → IMPACT" tagline)

import Link from "next/link";

export const BRAND_GRADIENT = {
  from: "#FF3B30",
  mid: "#FF6A15",
  to: "#FF8E1F",
};

/** Icon-only brand mark: gradient "P"-shaped play button with speed lines. */
export function ForgeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      className={className}
      role="img"
      aria-label="TubeForge logo"
      fill="none"
    >
      <defs>
        <linearGradient id="tf-fire" x1="14" y1="10" x2="106" y2="112" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FF3B30" />
          <stop offset="0.55" stopColor="#FF6A15" />
          <stop offset="1" stopColor="#FF8E1F" />
        </linearGradient>
      </defs>

      {/* Speed lines — motion streaks shooting out to the left */}
      <g fill="url(#tf-fire)">
        <rect x="2" y="44" width="27" height="8.5" rx="4.25" />
        <rect x="9" y="59" width="19" height="8.5" rx="4.25" />
        <rect x="3" y="74" width="23" height="8.5" rx="4.25" />
        <circle cx="8.5" cy="91.5" r="4.25" />
      </g>

      {/* "P" play glyph: top bar flows into the right stem and sweeps down
          into a tapered tail; the concave notch between them holds the play
          triangle. fillRule evenodd cuts the notch out of the silhouette. */}
      <path
        fill="url(#tf-fire)"
        d="M35 10
           L97 10
           Q112 10 112 25
           L112 48
           Q112 74 93 81
           C79 86 68 97 61 112
           Q59 116 56 113
           Q54 100 58 89
           Q62 79 64 66
           L64 42
           L37 42
           Q30 42 30 34
           L30 16
           Q30 10 35 10
           Z"
      />

      {/* White play triangle (rounded corners via stroke-linejoin) */}
      <path
        d="M40 50 L62 62 L40 74 Z"
        fill="#FFFFFF"
        stroke="#FFFFFF"
        strokeWidth="6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Full brand lockup: mark + "TubeForge" wordmark (+ optional tagline).
 * Used in the sidebar, mobile nav, login screen and footer.
 */
export function BrandLockup({
  className,
  markClassName = "h-9 w-9",
  tagline = false,
  href = "/",
  subtitle = "Auto-Pilot Engine",
}: {
  className?: string;
  markClassName?: string;
  tagline?: boolean;
  href?: string;
  subtitle?: string | null;
}) {
  return (
    <Link href={href} className={`flex items-center gap-2.5 ${className ?? ""}`}>
      <ForgeMark className={`${markClassName} shrink-0 drop-shadow-[0_0_12px_rgba(255,90,20,0.35)]`} />
      <div className="min-w-0">
        <p className="font-semibold leading-tight tracking-tight text-[15px]">
          Tube<span className="text-gradient">Forge</span>
        </p>
        {subtitle && (
          <p className="text-[11px] text-muted-foreground truncate">{subtitle}</p>
        )}
        {tagline && (
          <p className="mt-1 text-[10px] uppercase tracking-[0.35em] text-muted-foreground">
            Ideas → Videos → Impact
          </p>
        )}
      </div>
    </Link>
  );
}
