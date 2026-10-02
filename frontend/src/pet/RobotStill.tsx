import type { Expression } from "./RobotModel";

// Flat stand-in for devices without WebGL, and the placeholder while the 3D
// chunk loads. Same silhouette and colours as the 3D robot.
export function RobotStill({ expression }: { expression: Expression }) {
  const eyeHeight = ({ idle: 15, happy: 15, sleep: 3, low: 7, grumpy: 9, surprised: 19, dizzy: 15, excited: 18, off: 0 } satisfies Record<Expression, number>)[expression];
  return (
    <svg className="cp-pet-still" viewBox="0 0 140 140" aria-hidden="true">
      <defs>
        <radialGradient id="cp-pet-shell" cx="38%" cy="30%" r="75%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#d9e3ff" />
        </radialGradient>
      </defs>
      <circle cx="70" cy="104" r="28" fill="url(#cp-pet-shell)" />
      <rect x="16" y="56" width="10" height="24" rx="5" fill="#0052FF" />
      <rect x="114" y="56" width="10" height="24" rx="5" fill="#0052FF" />
      <rect x="22" y="38" width="96" height="60" rx="30" fill="url(#cp-pet-shell)" />
      <rect x="34" y="50" width="72" height="36" rx="18" fill="#14213D" />
      {expression === "happy" ? (
        <g fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round">
          <path d="M51 71 q7 -9 14 0" />
          <path d="M75 71 q7 -9 14 0" />
        </g>
      ) : (
        <g fill="#fff">
          <ellipse cx="58" cy="68" rx="7.5" ry={eyeHeight / 2} />
          <ellipse cx="82" cy="68" rx="7.5" ry={eyeHeight / 2} />
        </g>
      )}
    </svg>
  );
}
