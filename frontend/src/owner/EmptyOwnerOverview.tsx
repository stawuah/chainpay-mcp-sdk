import { Button } from "@astryxdesign/core/Button";
import {
  DEMO_RECEIPT_LINK_LABEL,
  EMPTY_OWNER_ACTIVITY,
  FIRST_MANDATE_TITLE,
  LOGIN_VS_APPROVAL,
  OWNER_SETUP_STEPS,
} from "./onboarding";

export type EmptyOwnerOverviewProps = {
  walletConnected: boolean;
  signedIn: boolean;
  signingIn: boolean;
  signInError: string;
  onSignIn: () => void;
  onReviewMandate: () => void;
  demoReceiptHref?: string | null;
};

export function EmptyOwnerOverview({
  walletConnected,
  signedIn,
  signingIn,
  signInError,
  onSignIn,
  onReviewMandate,
  demoReceiptHref,
}: EmptyOwnerOverviewProps) {
  return (
    <section className="dashboard-card owner-setup-card" aria-labelledby="owner-setup-title">
      <div className="dashboard-card-heading">
        <div>
          <span className="section-kicker">GET STARTED</span>
          <h2 id="owner-setup-title">{FIRST_MANDATE_TITLE}</h2>
        </div>
      </div>
      <ol className="owner-setup-path" aria-label="First mandate path">
        {OWNER_SETUP_STEPS.map((step, index) => {
          const complete = (step.key === "connect" && walletConnected) || (step.key === "signin" && signedIn);
          return (
            <li className={complete ? "owner-setup-step is-complete" : "owner-setup-step"} key={step.key}>
              <span className="owner-setup-index" aria-hidden="true">{index + 1}</span>
              <div>
                <strong>{step.label}</strong>
                <p>{step.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="owner-setup-distinction">{LOGIN_VS_APPROVAL}</p>
      <div className="owner-setup-actions">
        {!signedIn && (
          <Button
            type="button"
            variant="secondary"
            label={signingIn ? "Waiting for login message…" : "Sign in"}
            isDisabled={signingIn || !walletConnected}
            onClick={onSignIn}
          />
        )}
        <Button
          type="button"
          variant="primary"
          label="Review mandate"
          isDisabled={false}
          onClick={onReviewMandate}
        />
      </div>
      {signInError && <p className="builder-error" role="alert"><b>Sign in failed</b><span>{signInError}</span></p>}
      <p className="owner-activity-empty">{EMPTY_OWNER_ACTIVITY}</p>
      {demoReceiptHref && (
        <p className="owner-demo-link">
          <span>Separate demo evidence</span>
          <a href={demoReceiptHref}>{DEMO_RECEIPT_LINK_LABEL}</a>
        </p>
      )}
    </section>
  );
}
