import {
  Apple,
  FolderDown,
  HardDrive,
  Monitor,
  Radio,
  Server,
  Smartphone,
} from "lucide-react";
import type { TailscalePeer } from "../ipc/contract";
import { useHosts } from "../state/hosts";
import { useSessions } from "../state/sessions";
import { peerAsHost, peerLedInfo, peerOfflineLabel, useTailnet } from "../state/tailnet";
import { HostLed } from "./HostLed";

/** Props for {@link TailnetSection}. */
export interface TailnetSectionProps {
  /** Peers to render (already deduped against existing hosts). */
  peers: TailscalePeer[];
  /** The sidebar's live search query (peers filter by it too). */
  query: string;
}

/**
 * Picks the OS glyph for a peer row (F9: "MagicDNS name, OS icon,
 * online state, tags").
 *
 * @param os - The OS string as Tailscale reports it.
 * @returns A lucide icon component.
 */
function osIconOf(os: string): typeof Server {
  const value = os.toLowerCase();
  if (value.includes("macos") || value.includes("ios")) return Apple;
  if (value.includes("windows")) return Monitor;
  if (value.includes("android")) return Smartphone;
  if (value.includes("linux")) return Server;
  return HardDrive;
}

/**
 * The sidebar's Tailnet section (F9, Phase 7): live peers with LEDs
 * mirroring Tailscale's own online state — never a TCP probe. Online
 * peers connect with one click (MagicDNS name + the default tailnet
 * user); offline peers render dimmed with their last-seen. Row actions:
 * Adopt as host (promotes the peer into `hosts.toml`) and Ping to wake
 * (`tailscale ping`, toast result). Hidden entirely — by the parent —
 * when the tailnet is unavailable.
 *
 * @param props - {@link TailnetSectionProps}
 * @returns The section element, or `null` with nothing to show.
 */
export function TailnetSection({ peers, query }: TailnetSectionProps) {
  const sessions = useSessions((s) => s.sessions);
  const openSshTab = useSessions((s) => s.openSshTab);
  const adoptHost = useHosts((s) => s.adoptHost);
  const defaultUser = useTailnet((s) => s.defaultUser);
  const pingPeer = useTailnet((s) => s.pingPeer);

  const needle = query.trim().toLowerCase();
  const visible =
    needle === ""
      ? peers
      : peers.filter(
          (peer) =>
            peer.hostName.toLowerCase().includes(needle) ||
            peer.dnsName.toLowerCase().includes(needle),
        );
  if (visible.length === 0) return null;

  return (
    <section className="sidebar-group" aria-label="Tailnet">
      <h2 className="group-eyebrow">
        <span className="group-toggle group-toggle--static">Tailnet</span>
      </h2>
      <ul className="group-hosts">
        {visible.map((peer) => {
          const led = peerLedInfo(peer, sessions);
          const OsIcon = osIconOf(peer.os);
          return (
            <li
              className={`host-item${peer.online ? "" : " host-item--offline"}`}
              key={peer.id}
            >
              <button
                className="host-row"
                type="button"
                title={
                  peer.online
                    ? `Connect: ssh ${defaultUser}@${peer.dnsName}`
                    : peerOfflineLabel(peer.lastSeen)
                }
                onClick={() => void openSshTab(peerAsHost(peer, defaultUser))}
              >
                <HostLed led={led} />
                <span className="host-label">{peer.hostName}</span>
                <span className="host-detail">
                  <OsIcon size={11} aria-label={peer.os || "unknown OS"} />
                  {peer.dnsName}
                </span>
                {peer.tsSsh && (
                  <span
                    className="tailnet-badge"
                    title="Tailscale SSH — key-free connect"
                  >
                    ts-ssh
                  </span>
                )}
                {!peer.online && (
                  <span className="tailnet-lastseen">
                    {peerOfflineLabel(peer.lastSeen)}
                  </span>
                )}
              </button>
              <span className="host-actions">
                <button
                  className="host-action"
                  type="button"
                  title="Adopt as host (into hosts.toml)"
                  aria-label={`Adopt ${peer.hostName} as a host`}
                  onClick={() => void adoptHost(peer.id)}
                >
                  <FolderDown size={13} aria-hidden />
                </button>
                <button
                  className="host-action"
                  type="button"
                  title="Ping to wake path (tailscale ping)"
                  aria-label={`Ping ${peer.hostName}`}
                  onClick={() => void pingPeer(peer)}
                >
                  <Radio size={13} aria-hidden />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
