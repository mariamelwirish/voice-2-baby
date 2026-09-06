// Voice2Baby brand mark: a soft voice bubble with a baby face inside.
// Line style (uses currentColor) so it matches the lucide icon set and picks up
// the accent color wherever it's placed. Use in place of the old <Baby> icon.
export function Logo({ size = 24, strokeWidth = 1.7, ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {/* voice bubble with tail */}
      <path d="M6.5 2.5h11a5.5 5.5 0 0 1 5.5 5.5v4.5a5.5 5.5 0 0 1-5.5 5.5h-4l-4.5 3.5v-3.5h-2.5A5.5 5.5 0 0 1 1 12.5V8a5.5 5.5 0 0 1 5.5-5.5Z" />
      {/* hair curl */}
      <path d="M11.25 6.1c.3-1 1.7-1 1.95 0" />
      {/* eyes */}
      <circle cx="9.25" cy="9.75" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="14.75" cy="9.75" r="0.6" fill="currentColor" stroke="none" />
      {/* smile */}
      <path d="M9 12.75c.9 1.5 5.1 1.5 6 0" />
    </svg>
  );
}
