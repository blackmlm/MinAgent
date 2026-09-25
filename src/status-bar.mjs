// Status bar: one line pinned to the LAST row of the terminal.
// It shows live context use and stays visible while output scrolls.
//
// How it works:
// - A "scroll region" (ESC[1;Nr, called DECSTBM) limits scrolling to rows
//   1..N. We set N = rows - 1, so the last row never scrolls.
// - To draw the bar: save the cursor (ESC7), jump to the last row, clear it,
//   write the text, then restore the cursor (ESC8). Normal output is not moved.
// - A timer redraws the bar every 500 ms, so it stays live. It also repairs
//   the bar if something clears the screen (for example ESC[0J or /new).
//   Node runs one write at a time, so a redraw never splits another write.
//
// Before: the context line was printed only when the prompt appeared, and
// it scrolled away while the model was working.

const REDRAW_INTERVAL_MS = 500;
// Below this many rows the terminal is too small to give one row away.
const MIN_ROWS = 5;

// output: the terminal stream (process.stdout).
// getText(columns): returns the bar text, already cut to fit the width.
export function createStatusBar({ output, getText }) {
	let active = false;
	let timer;

	// Limits scrolling to all rows except the last one.
	// DECSTBM moves the cursor to the top-left, so save and restore it.
	function setScrollRegion() {
		output.write(`\u001b7\u001b[1;${output.rows - 1}r\u001b8`);
	}

	function draw() {
		if (!active) return;
		let text = "";
		try {
			text = getText(output.columns || 80);
		} catch {
			// A broken text builder must never crash MinAgent. Draw nothing.
		}
		output.write(`\u001b7\u001b[${output.rows};1H\u001b[2K${text}\u001b8`);
	}

	// After a resize the last row changed: set the region again and redraw.
	function onResize() {
		if (!active) return;
		if (output.rows < MIN_ROWS) {
			stop();
			return;
		}
		setScrollRegion();
		draw();
	}

	function start() {
		if (active || !output.isTTY || !output.rows || output.rows < MIN_ROWS) return;
		active = true;
		// If the cursor is on the last row, the bar would cover it.
		// "\n" scrolls up one line if needed, then ESC[1A moves back up.
		output.write("\n\u001b[1A");
		setScrollRegion();
		draw();
		timer = setInterval(draw, REDRAW_INTERVAL_MS);
		// unref: the timer alone must not keep the process running.
		timer.unref();
		output.on("resize", onResize);
	}

	// Restores normal scrolling and clears the bar. Safe to call twice.
	function stop() {
		if (!active) return;
		active = false;
		clearInterval(timer);
		output.removeListener("resize", onResize);
		// ESC[r resets the scroll region to the whole screen.
		output.write(`\u001b7\u001b[r\u001b[${output.rows};1H\u001b[2K\u001b8`);
	}

	return { start, stop, draw };
}
