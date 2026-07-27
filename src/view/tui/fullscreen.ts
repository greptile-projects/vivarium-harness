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

// Bind a restore to the view's exit, whenever that happens, and hand back a
// handle the caller can await later.
//
// The two moments are not the same one. The view exits when the human presses
// `q` (or Ctrl-C); the caller awaits only once the run it is watching is over,
// which may be hours later. Restoring on the await would leave the terminal on
// the alternate screen with a hidden cursor for that whole gap — the view gone,
// the shell unusable. So the restore rides on `exit` itself.
//
// `exit` rejecting is the *view* failing, not the run — the run reports itself
// through its own result — and nothing awaits the handle until the run ends, so
// a rejection left unhandled would surface as an unhandled rejection in the
// meantime. It is swallowed, and the restore still runs: a view that broke has
// all the more reason to give the terminal back.
export function restoreOnExit(
  exit: Promise<unknown>,
  restore: () => void,
): () => Promise<void> {
  const exited = exit.then(
    () => {},
    () => {},
  ).finally(restore);
  return () => exited;
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
