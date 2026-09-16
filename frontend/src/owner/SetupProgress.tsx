const stages = ["Wallet", "Limits", "Agent"];

/** Progress represents completed setup actions, never an animated preview. */
export function SetupProgress({ current }: { current: 0 | 1 | 2 }) {
  return (
    <ol className="cp-setup-progress" aria-label="Setup progress">
      {stages.map((label, index) => (
        <li key={label} aria-current={index === current ? "step" : undefined} className={index < current ? "is-complete" : ""}>
          <span className="cp-setup-progress-number" aria-hidden="true">{index < current ? "✓" : `0${index + 1}`}</span>
          <span>{label}<span className="cp-setup-sr-only">{index < current ? ", complete" : index > current ? ", upcoming" : ", current step"}</span></span>
        </li>
      ))}
    </ol>
  );
}
