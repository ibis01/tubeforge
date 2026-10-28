// TubeForge brand mark — the red-orange flame-play logo used in the sidebar,
// lock screen and splash. Kept as a component so every surface stays identical.

export function TubeForgeLogo({ size = 36 }: { size?: number }) {
  return (
    <div
      className="rounded-xl bg-brand-gradient flex items-center justify-center shadow-lg glow-red-soft shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 64 64"
        style={{ width: size, height: size }}
        className="rounded-xl"
        role="img"
        aria-label="TubeForge"
      >
        <defs>
          <linearGradient id="tf-tile" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#FF2020" />
            <stop offset="0.55" stopColor="#FF3D14" />
            <stop offset="1" stopColor="#FF7A1F" />
          </linearGradient>
          <linearGradient id="tf-flame" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#FFB13D" />
            <stop offset="1" stopColor="#FFDD6B" />
          </linearGradient>
        </defs>
        <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#tf-tile)" />
        <path d="M27 19v26l22-13z" fill="#fff" opacity="0.96" />
        <path
          d="M27 19c-3.2 1.6-4.6 4.1-4.3 7 .2 2 1.4 3.4 1.1 5.6-.3 2.4-2.2 4-4.8 4.2 1.1-2.6.6-4.4-1.5-6.4-2.4-2.3-3.1-5.8-1.5-9.2 1.9-4.1 6.3-6.3 11-5.3-1.9 1.3-3 2.6-3.5 4.1z"
          fill="url(#tf-flame)"
        />
      </svg>
    </div>
  );
}

export function TubeForgeWordmark() {
  return (
    <div>
      <p className="font-semibold leading-tight">
        Tube<span className="text-gradient">Forge</span>
      </p>
      <p className="text-[11px] text-muted-foreground">Auto-Pilot Engine</p>
    </div>
  );
}
