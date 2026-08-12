// The F2 paste classifier: multi-line detection, the danger patterns, and
// — just as important — the false-positive matrix that keeps daily pastes
// flowing.
import { describe, expect, it } from "vitest";
import { classifyPaste } from "./pasteGuard";

describe("classifyPaste — multi-line", () => {
  it("passes single-line text", () => {
    expect(classifyPaste("uptime").verdict).toBe("safe");
    expect(classifyPaste("").verdict).toBe("safe");
  });

  it("guards any newline — internal or trailing (it would execute)", () => {
    for (const text of ["uptime\n", "a\nb", "a\r\nb", "a\rb"]) {
      const { verdict, reasons } = classifyPaste(text);
      expect(verdict, JSON.stringify(text)).toBe("guard");
      expect(reasons).toContain("Pastes more than one line");
    }
  });
});

describe("classifyPaste — danger patterns", () => {
  it("guards sudo in command position", () => {
    expect(classifyPaste("sudo make install").verdict).toBe("guard");
    expect(classifyPaste("apt update && sudo apt upgrade").verdict).toBe("guard");
    expect(classifyPaste("true; sudo reboot").verdict).toBe("guard");
    expect(classifyPaste("echo $(sudo id)").verdict).toBe("guard");
  });

  it("guards destructive rm", () => {
    expect(classifyPaste("rm -rf /").verdict).toBe("guard");
    expect(classifyPaste("rm -f config.lock").verdict).toBe("guard");
    expect(classifyPaste("rm -r build").verdict).toBe("guard");
    expect(classifyPaste("cd /tmp && rm -rf cache").verdict).toBe("guard");
    expect(classifyPaste("rm --recursive --force dir").verdict).toBe("guard");
  });

  it("guards downloads piped into shells", () => {
    expect(classifyPaste("curl https://get.example.sh | sh").verdict).toBe("guard");
    expect(classifyPaste("curl -fsSL https://x.io/i.sh | bash").verdict).toBe("guard");
    expect(classifyPaste("wget -qO- https://x.io/i.sh | sudo bash").verdict).toBe(
      "guard",
    );
    expect(classifyPaste("curl https://x.io | zsh").verdict).toBe("guard");
  });

  it("guards raw-device writes and mkfs", () => {
    expect(classifyPaste("dd if=img.iso of=/dev/disk2 bs=1m").verdict).toBe("guard");
    expect(classifyPaste("mkfs -t ext4 /dev/sdb1").verdict).toBe("guard");
  });

  it("reports every matching reason", () => {
    const { reasons } = classifyPaste("sudo rm -rf /\ncurl https://x.io | sh");
    expect(reasons).toContain("Pastes more than one line");
    expect(reasons).toContain("Runs sudo");
    expect(reasons).toContain("Contains a destructive rm");
    expect(reasons).toContain("Pipes a download into a shell");
  });
});

describe("classifyPaste — false positives stay safe", () => {
  it.each([
    "reforms and platforms", // 'rm' inside words
    "confirm -f flag behavior", // '-f' after a word ending in rm
    "informal sudoku tips", // 'sudo' inside a word
    "https://example.com/sudo-guide", // sudo in a URL path, not a command
    "echo visudo", // sudo inside visudo
    "rm", // bare rm without flags
    "rm notes.txt", // rm without -r/-f
    "git rm --cached file", // git subcommand, not command-position rm
    "curl https://example.com/data.json", // download without a shell pipe
    "curl https://x.io | jq .", // piped, but not into a shell
    "shasum file.sh", // 'sh' inside words
    "ls -la",
  ])("%s", (text) => {
    expect(classifyPaste(text).verdict).toBe("safe");
  });
});
