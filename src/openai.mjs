const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 1024 * 1024;
const RETRYABLE_NETWORK_ERRORS = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
// HTTP statuses that mean "the server is busy, try again later".
// Hosted endpoints like Cerebras return 429 (queue full) or 504 (gateway
// timeout) under high traffic. These usually succeed after a short wait.
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
// Total tries for busy-server responses: 1 first try + 9 retries.
// Before: 4 tries with 1s/2s/4s waits (~7s total), which was too short
// when Cerebras stayed busy. Now ~30s total at 3s per retry.
const MAX_BUSY_ATTEMPTS = 10;
// Wait between busy-server retries (user asked for 3 seconds).
const BUSY_RETRY_DELAY_MS = 3 * 1000;
// Total tries for Cerebras "token_quota_exceeded" (tokens-per-minute limit):
// 1 first try + 4 cooldowns (~2 min at 30s each).
// Before: 25 tries 3s apart, printing a new line each time. Retrying every
// 3s was wasteful: the limit refills slowly (~2.5K tokens/s for a 150K/min
// key), so a large request (70K+ tokens) needs ~30s before it fits again.
const MAX_TOKEN_QUOTA_ATTEMPTS = 5;
// Cooldown before retrying after "token_quota_exceeded", when the server
// does not say how long to wait (Cerebras sent no reset header in tests).
const TOKEN_QUOTA_COOLDOWN_MS = 30 * 1000;
// Longest wait between retries, so a large Retry-After header cannot stall us.
// Before: 20s. Raised to 60s because the token limit resets per minute.
const MAX_RETRY_DELAY_MS = 60 * 1000;

export function createOpenAiClient({ endpoint, apiKey, model, tools, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES }) {
	if (!endpoint || !model || !Array.isArray(tools)) throw new Error("OpenAI client configuration is incomplete.");
	return {
		complete: async (requestMessages, options = {}) => {
			const headers = { "Content-Type": "application/json" };
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
			const requestBody = { model, messages: requestMessages, stream: true };
			if (options.withTools) {
				requestBody.tools = options.availableTools ?? tools;
				requestBody.tool_choice = options.toolChoice ?? "auto";
			}
			if (options.maxTokens) requestBody.max_tokens = options.maxTokens;
			let response;
			// Before: this loop ran at most 2 times and only retried network errors.
			// Now it also retries busy-server HTTP statuses (see RETRYABLE_HTTP_STATUSES).
			// Body of the last busy response. We read it to find the error code,
			// so it cannot be read again later; the final error message uses it.
			let busyBodyText = "";
			// The loop bound is the larger limit. Each error type stops at its own
			// limit below (MAX_BUSY_ATTEMPTS or MAX_TOKEN_QUOTA_ATTEMPTS).
			// Math.max because either limit may be the larger one.
			for (let attempt = 0; attempt < Math.max(MAX_BUSY_ATTEMPTS, MAX_TOKEN_QUOTA_ATTEMPTS); attempt += 1) {
				try {
					busyBodyText = "";
					response = await fetch(endpoint, {
						method: "POST",
						headers,
						body: JSON.stringify(requestBody),
						redirect: "error",
						signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
					});
					if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
						// Read the body to learn which limit was hit, e.g.
						// "queue_exceeded" (server busy) or "token_quota_exceeded"
						// (our tokens-per-minute limit). The token limit gets more tries.
						busyBodyText = await readResponsePrefix(response, 8 * 1024);
						const errorCode = busyBodyText.match(/"code"\s*:\s*"([a-z_]+)"/)?.[1] ?? "";
						const maxAttempts = errorCode === "token_quota_exceeded" ? MAX_TOKEN_QUOTA_ATTEMPTS : MAX_BUSY_ATTEMPTS;
						// Tries left: wait, then try again.
						if (attempt < maxAttempts - 1) {
							const delayMs = retryDelayMs(response, errorCode);
							// The caller decides how to wait, so the UI can show a live
							// countdown. Without one, we just sleep.
							// Before: onRetry printed a notice, then we slept here.
							// retry = this retry's number, maxRetries = retries allowed.
							const waitBeforeRetry = options.waitBeforeRetry ?? ((info) => sleep(info.delayMs));
							await waitBeforeRetry({ status: response.status, errorCode, retry: attempt + 1, maxRetries: maxAttempts - 1, delayMs });
							continue;
						}
					}
					break;
				} catch (error) {
					const code = error?.cause?.code;
					if (attempt === 0 && RETRYABLE_NETWORK_ERRORS.has(code)) {
						await new Promise((resolve) => setTimeout(resolve, 250));
						continue;
					}
					const cause = code ? ` (${code})` : error?.cause?.message ? ` (${error.cause.message})` : "";
					throw new Error(`Could not connect to the OpenAI-compatible endpoint: ${error.message}${cause}`);
				}
			}
			if (!response.ok) {
				// Reuse the busy body if we already read it in the retry loop.
				const bodyText = busyBodyText || await readResponsePrefix(response, 8 * 1024);
				throw new Error(`Endpoint returned HTTP ${response.status}: ${bodyText}`);
			}
			const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
			if (contentType.includes("text/event-stream")) {
				return readStreamingResponse(response, options.onTextDelta, maxResponseBytes, options.onReasoningDelta);
			}
			const bodyText = await readResponsePrefix(response, 2 * 1024);
			throw new Error(`The endpoint did not return a streaming response (Content-Type: ${contentType || "unknown"}). Response: ${bodyText}`);
		},
	};
}

// How long to wait before retrying a busy-server response.
// Uses the server's wait time (in seconds) when it sends one:
// Retry-After, or x-ratelimit-reset-tokens-minute for the token limit.
// Otherwise: TOKEN_QUOTA_COOLDOWN_MS (30s) for token_quota_exceeded,
// and BUSY_RETRY_DELAY_MS (3s) for other busy errors.
// Before: 1s, 2s, 4s (doubling), then a fixed 3s for every error type.
function retryDelayMs(response, errorCode) {
	const isTokenQuota = errorCode === "token_quota_exceeded";
	const headerSeconds = Number(response.headers.get("retry-after")
		?? (isTokenQuota ? response.headers.get("x-ratelimit-reset-tokens-minute") : null));
	const delay = Number.isFinite(headerSeconds) && headerSeconds > 0
		? headerSeconds * 1000
		: isTokenQuota ? TOKEN_QUOTA_COOLDOWN_MS : BUSY_RETRY_DELAY_MS;
	return Math.min(delay, MAX_RETRY_DELAY_MS);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponsePrefix(response, maxBytes) {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks = [];
	let totalBytes = 0;
	let truncated = false;
	try {
		while (totalBytes < maxBytes) {
			const { value, done } = await reader.read();
			if (done) break;
			const keep = value.subarray(0, maxBytes - totalBytes);
			chunks.push(Buffer.from(keep));
			totalBytes += keep.byteLength;
			if (keep.byteLength < value.byteLength) {
				truncated = true;
				break;
			}
		}
		if (totalBytes >= maxBytes) truncated = true;
	} finally {
		if (truncated) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	return `${Buffer.concat(chunks, totalBytes).toString("utf8")}${truncated ? " [response excerpt truncated]" : ""}`;
}

export async function readStreamingResponse(response, onTextDelta, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, onReasoningDelta) {
	if (!response.body) throw new Error("Endpoint opened a streaming response without a readable body.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const toolCalls = new Map();
	let buffer = "";
	let content = "";
	let usage;
	let finishReason;
	let finished = false;
	let bytesRead = 0;
	let bodyDone = false;

	function consumeFrame(frame) {
		const data = frame.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") {
			if (data === "[DONE]") finished = true;
			return;
		}
		let event;
		try {
			event = JSON.parse(data);
		} catch {
			throw new Error("Endpoint sent an invalid streaming event.");
		}
		if (event?.error) {
			const detail = typeof event.error === "string" ? event.error : JSON.stringify(event.error);
			throw new Error(`Endpoint streaming error: ${detail.slice(0, 1000)}`);
		}
		if (event?.usage) usage = event.usage;
		const choice = event?.choices?.[0];
		if (!choice) return;
		if (choice.finish_reason) finishReason = choice.finish_reason;
		const delta = choice.delta ?? {};
		// Endpoints name the reasoning field differently.
		// Cerebras sends it as `delta.reasoning`; others use `reasoning_content`
		// or `reasoning_summary`. Without the `reasoning` case, Cerebras
		// reasoning was dropped and nothing showed during "Processing...".
		const reasoningDelta = typeof delta.reasoning_summary === "string" && delta.reasoning_summary
			? delta.reasoning_summary
			: typeof delta.reasoning_content === "string" && delta.reasoning_content ? delta.reasoning_content
			: typeof delta.reasoning === "string" ? delta.reasoning : "";
		if (reasoningDelta) {
			onReasoningDelta?.(reasoningDelta);
		}
		if (typeof delta.content === "string" && delta.content) {
			content += delta.content;
			onTextDelta?.(delta.content);
		} else if (Array.isArray(delta.content)) {
			for (const part of delta.content) {
				if (typeof part?.text === "string" && part.text) {
					content += part.text;
					onTextDelta?.(part.text);
				}
			}
		}
		for (const deltaCall of delta.tool_calls ?? []) {
			const index = Number.isInteger(deltaCall.index) ? deltaCall.index : toolCalls.size;
			const call = toolCalls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
			if (deltaCall.id) call.id = deltaCall.id;
			if (deltaCall.type) call.type = deltaCall.type;
			if (deltaCall.function?.name) call.function.name += deltaCall.function.name;
			if (deltaCall.function?.arguments) {
				call.function.arguments += deltaCall.function.arguments;
				if (call.function.arguments.length > MAX_TOOL_ARGUMENT_CHARS) throw new Error("Endpoint returned tool arguments larger than the 1 MiB limit.");
			}
			toolCalls.set(index, call);
		}
	}

	try {
		while (!finished) {
			const { value, done } = await reader.read();
			if (done) {
				bodyDone = true;
				break;
			}
			bytesRead += value.byteLength;
			if (bytesRead > maxResponseBytes) throw new Error(`Endpoint streaming response exceeds the ${maxResponseBytes} byte limit.`);
			buffer += decoder.decode(value, { stream: true });
			let boundary;
			while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
				const frame = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				consumeFrame(frame);
				if (finished) break;
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) consumeFrame(buffer);
		if (!finished && !finishReason) throw new Error("Endpoint stream ended before a complete response was received.");
	} finally {
		if (!bodyDone) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}

	const message = { role: "assistant", content: content || null };
	if (toolCalls.size > 0) message.tool_calls = [...toolCalls.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, call]) => call);
	return { payload: { usage, finish_reason: finishReason }, message };
}
