// TubeForge brand mark — uses the uploaded image from the public folder.
// The ?v=2 forces the browser to bypass its cache and load the new image.

export function TubeForgeLogo({ size = 36 }: { size?: number }) {
  return (
    <img
      src="/logo.png?v=2"
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
      <p className="font-semibold leading-tight">
        Tube<span className="text-gradient">Forge</span>
      </p>
      <p className="text-[11px] text-muted-foreground">Auto-Pilot Engine</p>
    </div>
  );
}
