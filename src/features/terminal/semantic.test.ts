import { describe, expect, it } from "vitest";
import {
  createSemanticMachine,
  formatDuration,
  nextPromptLine,
  parseClipboard,
  parseCwd,
  unescapeCommand,
  type CompletedCommand,
  type CommandMark,
  type LineAnchor,
  type SemanticHooks,
} from "./semantic";

/**
 * A fake terminal: a cursor line that advances, anchors that track lines.
 *
 * @param opts - `alt`: alt-screen probe; `clipboard`: OSC 52 opt-in.
 */
function fakeTerminal(opts: { alt?: () => boolean; clipboard?: boolean } = {}) {
  let cursor = 0;
  let now = 1_000;
  const done: CompletedCommand[] = [];
  const cwds: string[] = [];
  const clips: string[] = [];
  const marks: CommandMark[] = [];
  let detected = 0;
  const hooks: SemanticHooks = {
    now: () => now,
    anchor: (): LineAnchor => {
      const line = cursor;
      return { line, dispose: () => undefined };
    },
    cursorLine: () => cursor,
    altScreen: opts.alt ?? (() => false),
    onCommandDone: (d) => done.push(d),
    onCwd: (c) => cwds.push(c),
    onClipboard: (t) => clips.push(t),
    onIntegrationDetected: () => (detected += 1),
    onMark: (m) => marks.push(m),
  };
  const machine = createSemanticMachine(hooks, {
    clipboard: () => opts.clipboard ?? false,
  });
  return {
    machine,
    done,
    cwds,
    clips,
    marks,
    detected: () => detected,
    output: (lines: number) => (cursor += lines),
    tick: (ms: number) => (now += ms),
    /**
     * One full prompt → command → output → done cycle.
     *
     * @param cmd - The command text (633;E).
     * @param exit - The exit status (133;D).
     * @param lines - Output lines the command prints.
     * @param ms - How long the command takes.
     */
    run(cmd: string, exit: number, lines = 3, ms = 50) {
      machine.osc(133, "A");
      cursor += 1; // the prompt line
      machine.osc(133, "B");
      machine.osc(633, `E;${cmd}`);
      machine.osc(133, "C");
      cursor += lines;
      now += ms;
      machine.osc(133, `D;${exit}`);
    },
  };
}

describe("semantic machine", () => {
  it("turns a prompt cycle into one completed command with text, exit, duration, output range", () => {
    const t = fakeTerminal();
    t.machine.osc(7, "file://hermes/home/u");
    t.run("ls -la", 0, 3, 120);
    expect(t.done).toHaveLength(1);
    const { mark, outputLines } = t.done[0];
    expect(mark.cmd).toBe("ls -la");
    expect(mark.exit).toBe(0);
    expect(mark.durationMs).toBe(120);
    expect(mark.cwd).toBe("/home/u");
    expect(outputLines).toEqual([1, 3]);
    expect(t.machine.lastCompleted()).toBe(mark);
    expect(t.detected()).toBe(1);
    expect(t.machine.integrationSeen()).toBe(true);
  });

  it("dedupes repeated prompt marks by sequence (tmux inner shells) and ignores stray D", () => {
    const t = fakeTerminal();
    expect(t.machine.osc(133, "D;0")).toBe(true); // nothing open → ignored
    expect(t.done).toHaveLength(0);
    t.machine.osc(133, "A");
    t.output(1);
    t.machine.osc(133, "A"); // redraw: same prompt, moved
    t.machine.osc(133, "A");
    expect(t.machine.marks()).toHaveLength(1);
    expect(t.machine.marks()[0].prompt.line).toBe(1);
    t.machine.osc(133, "C");
    t.machine.osc(133, "C"); // duplicate C is a no-op
    t.machine.osc(133, "D;1");
    expect(t.done).toHaveLength(1);
    expect(t.done[0].mark.exit).toBe(1);
  });

  it("opens a cycle on C without a prompt, and closes an unfinished one on the next A", () => {
    const t = fakeTerminal();
    t.machine.osc(633, "E;sleep 1");
    t.machine.osc(133, "C"); // no A/B seen
    expect(t.machine.marks()).toHaveLength(1);
    t.machine.osc(133, "A"); // killed before D
    expect(t.done).toHaveLength(0);
    expect(t.machine.marks()).toHaveLength(2);
    expect(t.machine.marks()[0].done).toBe(true);
    expect(t.machine.marks()[0].exit).toBeNull();
    expect(t.machine.lastCompleted()).toBeUndefined(); // no status → not "completed"
  });

  it("records a missing exit status as null", () => {
    const t = fakeTerminal();
    t.machine.osc(133, "A");
    t.machine.osc(133, "C");
    t.machine.osc(133, "D");
    expect(t.done[0].mark.exit).toBeNull();
  });

  it("flags commands that touched the alternate screen", () => {
    let alt = false;
    const t = fakeTerminal({ alt: () => alt });
    t.machine.osc(133, "A");
    t.machine.osc(633, "E;vim x");
    t.machine.osc(133, "C");
    alt = true;
    t.machine.noteAltScreen();
    alt = false;
    t.machine.osc(133, "D;0");
    expect(t.done[0].mark.usedAltScreen).toBe(true);
    t.run("ls", 0);
    expect(t.done[1].mark.usedAltScreen).toBe(false);
  });

  it("reports cwd changes once per change and honors OSC 52 only when opted in", () => {
    const off = fakeTerminal({ clipboard: false });
    off.machine.osc(7, "file://h/a");
    off.machine.osc(7, "file://h/a");
    off.machine.osc(7, "file://h/b%20c");
    expect(off.cwds).toEqual(["/a", "/b c"]);
    expect(off.machine.cwd()).toBe("/b c");
    off.machine.osc(52, `c;${btoa("secret")}`);
    expect(off.clips).toEqual([]);
    const on = fakeTerminal({ clipboard: true });
    on.machine.osc(52, `c;${btoa("hello")}`);
    on.machine.osc(52, "c;?");
    expect(on.clips).toEqual(["hello"]);
  });

  it("prunes scrolled-out marks and caps the list", () => {
    const t = fakeTerminal();
    for (let i = 0; i < 5; i++) t.run(`c${i}`, 0, 1);
    const first = t.machine.marks()[0];
    (first as { prompt: LineAnchor }).prompt = { line: -1, dispose: () => undefined };
    t.machine.prune(3);
    expect(t.machine.marks()).toHaveLength(3);
    expect(t.machine.marks()[0].cmd).toBe("c2");
  });

  it("keeps handler cost under the §3 bar (< 1 ms per call) under flood", () => {
    const t = fakeTerminal();
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      t.run(`cmd ${i} --flag`, i % 3, 2, 5);
      t.machine.osc(7, `file://h/dir/${i}`);
    }
    const { calls, totalMs } = t.machine.stats();
    expect(calls).toBe(N * 6);
    expect(totalMs / calls).toBeLessThan(1);
    expect(t.machine.marks().length).toBeLessThanOrEqual(2000);
  });
});

describe("helpers", () => {
  it("unescapes 633;E payloads", () => {
    expect(unescapeCommand("echo a\\x3b b \\\\ c\\x0ad")).toBe("echo a; b \\ c\nd");
    expect(unescapeCommand("plain")).toBe("plain");
    expect(unescapeCommand("trail\\")).toBe("trail\\");
  });

  it("parses OSC 7 forms", () => {
    expect(parseCwd("file://hermes/home/u/My%20Dir")).toBe("/home/u/My Dir");
    expect(parseCwd("file:///root")).toBe("/root");
    expect(parseCwd("/plain/path")).toBe("/plain/path");
    expect(parseCwd("nonsense")).toBeUndefined();
  });

  it("decodes OSC 52 and rejects queries", () => {
    expect(parseClipboard(`c;${btoa("x y")}`)).toBe("x y");
    expect(parseClipboard("c;?")).toBeUndefined();
    expect(parseClipboard("c;***")).toBeUndefined();
  });

  it("finds the previous/next prompt relative to the viewport", () => {
    const anchor = (line: number): LineAnchor => ({ line, dispose: () => undefined });
    const marks: CommandMark[] = [10, 40, 70].map((line, i) => ({
      seq: i,
      prompt: anchor(line),
      done: true,
    }));
    expect(nextPromptLine(marks, 50, "up")).toBe(40);
    expect(nextPromptLine(marks, 50, "down")).toBe(70);
    expect(nextPromptLine(marks, 5, "up")).toBeUndefined();
    expect(nextPromptLine(marks, 70, "down")).toBeUndefined();
  });

  it("formats durations", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(4200)).toBe("4.2 s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(2 * 3_600_000 + 3 * 60_000)).toBe("2h 03m");
  });
});
