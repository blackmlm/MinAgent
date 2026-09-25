// Clipboard image support for Alt+V.
// Saves the image currently in the clipboard (e.g. a screenshot taken with
// Win+Shift+S) as a PNG file and returns its path. MinAgent then puts that
// path in the prompt, and prepareUserMessage attaches it like any image path.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Temp folder for pasted images. The OS temp dir keeps the workspace clean.
const CLIPBOARD_IMAGE_DIRECTORY = join(tmpdir(), "minagent-clipboard");

// Returns the saved PNG path, or null when the clipboard has no image.
// Throws on unsupported platforms or when PowerShell fails.
export async function saveClipboardImage() {
	// Only Windows for now. macOS/Linux need other tools (pngpaste, xclip).
	if (process.platform !== "win32") throw new Error("Alt+V image paste is only supported on Windows.");
	await mkdir(CLIPBOARD_IMAGE_DIRECTORY, { recursive: true });
	const filePath = join(CLIPBOARD_IMAGE_DIRECTORY, `clipboard-${Date.now()}.png`);
	// Windows PowerShell reads the clipboard through WinForms.
	// -STA is required: the WinForms clipboard only works on an STA thread.
	// The path goes in through an environment variable, so no quoting issues.
	const script = [
		"Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
		"$image = [System.Windows.Forms.Clipboard]::GetImage()",
		"if ($null -eq $image) { 'none'; exit 0 }",
		"$image.Save($env:MINAGENT_CLIPBOARD_FILE, [System.Drawing.Imaging.ImageFormat]::Png)",
		"'saved'",
	].join("; ");
	const output = await new Promise((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
			{ env: { ...process.env, MINAGENT_CLIPBOARD_FILE: filePath }, windowsHide: true, timeout: 15000 },
			(error, stdout, stderr) => {
				if (error) reject(new Error(stderr.trim() || error.message));
				else resolve(stdout.trim());
			},
		);
	});
	return output === "saved" ? filePath : null;
}
