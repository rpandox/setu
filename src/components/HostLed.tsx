import "./HostLed.css";
import { lastSeenLabel } from "../state/reach";
import type { LedInfo } from "../state/reach";

/** Props for {@link HostLed} and {@link ReachChip}. */
export interface HostLedProps {
  /** The LED treatment to draw, from `ledInfoOf` (reach store). */
  led: LedInfo;
}

/**
 * One status LED of the board (§7 table): hollow ring (probing /
 * reachability off, tooltip says which), solid neon + glow (reachable now),
 * pulsing neon (live session), or solid red without glow (unreachable,
 * last-seen on hover). Rendered in sidebar rows and palette host results.
 *
 * @param props - {@link HostLedProps}
 * @returns The LED dot element.
 */
export function HostLed({ led }: HostLedProps) {
  const title =
    led.state === "down"
      ? `Unreachable — ${lastSeenLabel(led.lastUpAt)}`
      : led.state === "up"
        ? "Reachable"
        : led.state === "pulsing"
          ? "Live session"
          : led.reason;
  return (
    <span className={`hostled hostled--${led.state}`} title={title} aria-hidden="true" />
  );
}

/**
 * The latency chip that accompanies a lit LED (§7: "latency chip fades
 * in"): the last probe's connect time in quiet mono digits. Renders
 * nothing until a successful probe has reported.
 *
 * @param props - {@link HostLedProps}
 * @returns The chip element, or `null` without a latency to show.
 */
export function ReachChip({ led }: HostLedProps) {
  if (led.rttMs === undefined || (led.state !== "up" && led.state !== "pulsing")) {
    return null;
  }
  return <span className="reach-chip">{led.rttMs}ms</span>;
}
