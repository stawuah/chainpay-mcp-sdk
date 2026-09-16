import { Button } from "@astryxdesign/core/Button";
import {
  DEMO_RECEIPT_LINK_LABEL,
  EMPTY_OWNER_ACTIVITY,
  LOGIN_VS_APPROVAL,
} from "./onboarding";
import { SetupProgress } from "./SetupProgress";
import "./owner-welcome.css";

export type EmptyOwnerOverviewProps = {
  walletConnected: boolean;
  signedIn: boolean;
  signingIn: boolean;
  signInError: string;
  mandateApproved?: boolean;
  agentPaired?: boolean;
  onSignIn: () => void;
  onChangeWallet?: () => void;
  onReviewMandate: () => void;
  onConnectAgent?: () => void;
  demoReceiptHref?: string | null;
};

export function EmptyOwnerOverview({
  walletConnected,
  signedIn,
  signingIn,
  signInError,
  onSignIn,
  onChangeWallet,
  onReviewMandate,
  onConnectAgent,
  mandateApproved = false,
  agentPaired = false,
  demoReceiptHref,
}: EmptyOwnerOverviewProps) {
  const current = !signedIn ? 0 : mandateApproved ? 2 : 1;
  return (
    <section className="dashboard-card owner-setup-card cp-owner-scene" aria-labelledby="owner-setup-title">
      <SetupProgress current={current} />
      <div className="cp-owner-scene-current" key={current}>
        <h2 id="owner-setup-title">{!signedIn ? "Your wallet is connected." : mandateApproved ? "Give your agent access." : "Set your spending limits."}</h2>
        <p className="cp-owner-scene-copy">{!signedIn
          ? "Sign in with a login message to open your workspace. This does not authorize spending."
          : mandateApproved
            ? "Your mandate is approved. Connect an agent to use it, with the access you choose."
            : "Choose your agent, token, allowance and expiry. You’ll review the exact limits before approving anything in your wallet."}</p>
      <div className="owner-setup-actions">
        {!signedIn && (
          <Button
            type="button"
            variant="primary"
            label={signingIn ? "Waiting for login message…" : "Sign in"}
            isDisabled={signingIn || !walletConnected}
            onClick={onSignIn}
          />
        )}
        {!signedIn && onChangeWallet && <Button type="button" variant="secondary" label="Change wallet" isDisabled={signingIn} onClick={onChangeWallet} />}
        {signedIn && !mandateApproved && <Button
          type="button"
          variant="primary"
          label="Review mandate"
          isDisabled={false}
          onClick={onReviewMandate}
        />}
        {signedIn && mandateApproved && onConnectAgent && (
          <Button
            type="button"
            variant="primary"
            label="Connect an agent"
            isDisabled={agentPaired}
            onClick={onConnectAgent}
          />
        )}
      </div>
      </div>
      {signInError && <p className="builder-error" role="alert"><b>Sign in failed</b><span>{signInError}</span></p>}
      <div className="cp-owner-scene-next"><strong>Up next</strong><span>{!signedIn ? "Review mandate → Approve in wallet → Connect an agent" : mandateApproved ? "Choose your agent’s access" : "Approve in wallet → Connect an agent"}</span></div>
      <p className="owner-setup-distinction">{LOGIN_VS_APPROVAL}</p>
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
