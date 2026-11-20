import * as React from "react"

// lucide-react 1.x stripped the brand icons (Youtube among them) from the
// core set. TubeForge's surfaces still need the YouTube mark for platform
// affordances (upload states, analytics badges, integrations), so the
// original lucide path (MIT, lucide v0.x) rides here with the same component
// contract the codebase already uses: className passthrough, currentColor
// stroke, 24x24 grid.
type YoutubeIconProps = React.SVGProps<SVGSVGElement>

const YoutubeIcon = React.forwardRef<SVGSVGElement, YoutubeIconProps>(
  function YoutubeIcon({ className, ...props }, ref) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={className}
        {...props}
      >
        <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17" />
        <path d="m10 15 5-3-5-3z" />
      </svg>
    )
  }
)

export { YoutubeIcon as Youtube }
