// TubeForge brand mark — uses the uploaded image from the public folder.
// mix-blend-screen makes the black background of the image transparent
// so it blends seamlessly into the dark UI.

export function TubeForgeLogo({ size = 36 }: { size?: number }) {
  return (
    <img
      src="/logo.png"
      alt="TubeForge Logo"
      width={size}
      height={size}
      className="rounded-xl object-cover shrink-0 mix-blend-screen"
      style={{ width: size, height: size }}
    />
  );
}

export function TubeForgeWordmark() {
  return (
    <div>
      <p className="font-bold leading-tight text-lg tracking-tight">
        Tube<span className="text-gradient">Forge</span>
      </p>
      <p className="text-[11px] text-muted-foreground">Auto-Pilot Engine</p>
    </div>
  );
}
