import { useEffect, useState } from "react";

// The view owns the whole terminal for the duration of a run: it switches to
// the alternate screen buffer, so the run's frames never scroll the user's
// scrollback away, and the shell is exactly as they left it when it exits.
// Anything worth keeping is printed *after* we restore (the summary in
// index.ts) or written to progress.log as it happens.

const ENTER = "\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l"; // alt buffer, home, clear, hide cursor
const LEAVE = "\x1b[?25h\x1b[?1049l"; // show cursor, back to the normal buffer

// Enter the alternate screen and return the restore function. Restoring is
// idempotent and also wired to process exit, so a crash or a Ctrl-C mid-frame
// cannot strand the terminal in the alternate buffer with a hidden cursor.
export function enterFullscreen(stream: NodeJS.WriteStream): () => void {
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    process.off("exit", restore);
    stream.write(LEAVE);
  };

  stream.write(ENTER);
  process.once("exit", restore);
  return restore;
}

// Terminal size, re-read on SIGWINCH. Panes size themselves from this rather
// than assuming 80x24, and long lists tail to whatever height is left.
export function useTerminalSize(stream: NodeJS.WriteStream): {
  columns: number;
  rows: number;
} {
  const read = () => ({
    columns: stream.columns || 80,
    rows: stream.rows || 24,
  });
  const [size, setSize] = useState(read);

  useEffect(() => {
    const onResize = () => setSize(read());
    stream.on("resize", onResize);
    return () => {
      stream.off("resize", onResize);
    };
  }, [stream]);

  return size;
}
