import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Bot, Copy } from "lucide-react";
import type { CardView } from "@chainpay/sdk";
import { buildMcpClientConfig, copyValue } from "../../owner/runtime";
import type { CardAgentConnection, CardsSource } from "./source";
import { errorText } from "./shared";

const TOOL_COPY: Record<string, string> = {
  request_card_checkout: "Check out at an allowed shop, once per purchase",
  get_card_activity: "See this card's purchases and declines",
  get_statement: "Read the statement",
  prepare_agent_card: "Suggest a new card for you to review",
};

/**
 * Owner-only: connect an MCP agent to this one card (cards-only connection scope).
 * The agent can ask for a single-use checkout and read activity and statements. It can't
 * see the card number, change limits, unfreeze, or repay. The token shows once.
 */
export function CardAgentConnect({ source, card }: { source: CardsSource; card: CardView }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<CardAgentConnection | null>(null);
  const [copied, setCopied] = useState(false);

  function close() {
    setOpen(false);
    // The token is shown once; closing forgets it.
    setConnection(null);
    setName("");
    setError("");
    setCopied(false);
  }

  async function connect() {
    setBusy(true);
    setError("");
    try {
      setConnection(await source.connectAgent(card.cardId, name));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const config = connection ? buildMcpClientConfig(connection.mcpUrl, connection.token) : "";

  return (
    <>
      <Button type="button" variant="secondary" label="Give an agent this card" icon={<Bot size={16} />} isDisabled={card.freeze.onChain} onClick={() => setOpen(true)} />
      <Dialog isOpen={open} onOpenChange={(next) => { if (!next) close(); }} purpose="form" width={560}>
        <Layout
          height="auto"
          header={<DialogHeader title={connection ? "Agent connected" : "Give an agent this card"} onOpenChange={(next) => { if (!next) close(); }} />}
          content={
            <LayoutContent>
              <div className="cp-agent-connect" data-testid="agent-connect">
                {!connection ? (
                  <>
                    <p>The agent can pay at the shops on this card, inside your limits. It never sees the card number or your limits, and it can't unfreeze the card or pay the statement.</p>
                    <TextInput label="Agent name" value={name} onChange={setName} placeholder="Research agent" description="Shows in Agents." />
                    <ul className="cp-agent-tools">
                      {Object.entries(TOOL_COPY).map(([tool, copy]) => <li key={tool}><code>{tool}</code> {copy}</li>)}
                    </ul>
                  </>
                ) : (
                  <>
                    <p><b>{connection.agentName}</b> can now use this card. Paste this into the agent's MCP settings. The key shows only once.</p>
                    <pre className="cp-agent-config" data-testid="agent-config">{config.replace(connection.token, `${connection.token.slice(0, 6)}…`)}</pre>
                    <Button type="button" variant="primary" label={copied ? "Copied" : "Copy settings with key"} icon={<Copy size={16} />} onClick={() => void copyValue(config).then(() => setCopied(true))} />
                    <p className="owner-muted">Remove it any time from Agents. Freezing the card stops its checkouts at once.</p>
                  </>
                )}
                {error && <div className="builder-error" role="alert"><b>Not connected</b><span>{error}</span></div>}
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <div className="cp-dialog-footer">
                <Button type="button" variant="secondary" label={connection ? "Done" : "Cancel"} onClick={close} />
                {!connection && <Button type="button" variant="primary" label={busy ? "Connecting…" : "Connect agent"} isDisabled={busy || !name.trim()} onClick={() => void connect()} />}
              </div>
            </LayoutFooter>
          }
        />
      </Dialog>
    </>
  );
}
