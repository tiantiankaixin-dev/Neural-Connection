import { ContextInspectorPanel } from "./ContextInspectorPanel"

// Use require() instead of import so the module object is mutable (esbuild
// compiles ES imports as read-only bindings, preventing monkey-patching).
const httpMod: typeof import("http") = require("http")
const httpsMod: typeof import("https") = require("https")

type HttpRequest = typeof import("http").request
type ClientRequest = import("http").ClientRequest
type IncomingMessage = import("http").IncomingMessage
type RequestOptions = import("http").RequestOptions

interface NetworkLogEntry {
	requestId: number
	method: string
	url: string
	headers: Record<string, string | string[] | undefined>
	requestBody: string
	statusCode?: number
	responseHeaders?: Record<string, string | string[] | undefined>
	responseBody?: string
	startTime: number
	endTime?: number
	error?: string
}

/**
 * Intercepts ALL outgoing HTTP/HTTPS requests at the Node.js network layer.
 * This captures everything regardless of which code path initiates the request.
 * Uses monkey-patching of http.request / https.request.
 */
export class NetworkInterceptor {
	private static instance: NetworkInterceptor | undefined
	private enabled = false
	private requestCounter = 0

	private originalHttpRequest: HttpRequest | undefined
	private originalHttpsRequest: HttpRequest | undefined

	private constructor() {}

	public static getInstance(): NetworkInterceptor {
		if (!NetworkInterceptor.instance) {
			NetworkInterceptor.instance = new NetworkInterceptor()
		}
		return NetworkInterceptor.instance
	}

	public start(): void {
		if (this.enabled) return
		this.enabled = true
		this.patchHttp()
		this.patchHttps()
		console.log("[NetworkInterceptor] Started - intercepting all HTTP/HTTPS requests")
	}

	public stop(): void {
		if (!this.enabled) return
		this.enabled = false
		this.restoreHttp()
		this.restoreHttps()
		console.log("[NetworkInterceptor] Stopped")
	}

	public isRunning(): boolean {
		return this.enabled
	}

	private patchHttp(): void {
		this.originalHttpRequest = httpMod.request
		httpMod.request = ((...args: any[]) => {
			return this.interceptRequest(this.originalHttpRequest!, "http", args)
		}) as any
	}

	private patchHttps(): void {
		this.originalHttpsRequest = httpsMod.request
		httpsMod.request = ((...args: any[]) => {
			return this.interceptRequest(this.originalHttpsRequest!, "https", args)
		}) as any
	}

	private restoreHttp(): void {
		if (this.originalHttpRequest) {
			httpMod.request = this.originalHttpRequest
			this.originalHttpRequest = undefined
		}
	}

	private restoreHttps(): void {
		if (this.originalHttpsRequest) {
			httpsMod.request = this.originalHttpsRequest
			this.originalHttpsRequest = undefined
		}
	}

	private interceptRequest(originalFn: HttpRequest, protocol: string, args: any[]): ClientRequest {
		const requestId = ++this.requestCounter
		const startTime = Date.now()

		// Parse arguments to extract URL, options, callback
		let url = ""
		let options: RequestOptions = {}
		let callback: ((res: IncomingMessage) => void) | undefined

		if (typeof args[0] === "string") {
			url = args[0]
			if (typeof args[1] === "function") {
				callback = args[1]
			} else if (typeof args[1] === "object") {
				options = args[1]
				callback = args[2]
			}
		} else if (args[0] instanceof URL) {
			url = args[0].toString()
			if (typeof args[1] === "function") {
				callback = args[1]
			} else if (typeof args[1] === "object") {
				options = args[1]
				callback = args[2]
			}
		} else if (typeof args[0] === "object") {
			options = args[0]
			const host = options.hostname || options.host || "unknown"
			const port = options.port ? `:${options.port}` : ""
			const path = options.path || "/"
			url = `${protocol}://${host}${port}${path}`
			callback = args[1]
		}

		const entry: NetworkLogEntry = {
			requestId,
			method: options.method || "GET",
			url,
			headers: (options.headers as Record<string, string | string[] | undefined>) || {},
			requestBody: "",
			startTime,
		}

		// Wrap callback to capture response
		const wrappedCallback = (res: IncomingMessage) => {
			entry.statusCode = res.statusCode
			entry.responseHeaders = res.headers as Record<string, string | string[] | undefined>

			const chunks: Buffer[] = []
			const originalOn = res.on.bind(res)

			// Intercept response data events
			res.on = function (event: string, listener: (...args: any[]) => void) {
				if (event === "data") {
					const wrappedListener = (chunk: Buffer | string) => {
						try {
							chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
						} catch {}
						listener(chunk)
					}
					return originalOn(event, wrappedListener)
				} else if (event === "end") {
					const wrappedListener = (...endArgs: any[]) => {
						entry.endTime = Date.now()
						try {
							const fullBody = Buffer.concat(chunks).toString("utf-8")
							entry.responseBody = fullBody
						} catch {
							entry.responseBody = `[${chunks.length} chunks, could not decode]`
						}

						// Log to inspector
						ContextInspectorPanel.getInstance().logNetworkResponse(entry)

						listener(...endArgs)
					}
					return originalOn(event, wrappedListener)
				}
				return originalOn(event, listener)
			} as any

			if (callback) {
				callback(res)
			}
		}

		// Build new args with wrapped callback
		let newArgs: any[]
		if (typeof args[0] === "string" || args[0] instanceof URL) {
			if (typeof args[1] === "object") {
				newArgs = [args[0], args[1], wrappedCallback]
			} else {
				newArgs = [args[0], wrappedCallback]
			}
		} else {
			newArgs = [args[0], wrappedCallback]
		}

		// Call original function
		const req = originalFn(...(newArgs as [any])) as ClientRequest

		// Intercept request body (write calls)
		const originalWrite = req.write.bind(req)
		const originalEnd = req.end.bind(req)
		const bodyChunks: Buffer[] = []

		req.write = function (chunk: any, ...rest: any[]) {
			try {
				if (chunk) {
					bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
				}
			} catch {}
			return originalWrite(chunk, ...rest)
		} as any

		req.end = function (chunk?: any, ...rest: any[]) {
			try {
				if (chunk && typeof chunk !== "function") {
					bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
				}
				entry.requestBody = Buffer.concat(bodyChunks).toString("utf-8")
			} catch {
				entry.requestBody = `[${bodyChunks.length} chunks, could not decode]`
			}

			// Log request immediately
			ContextInspectorPanel.getInstance().logNetworkRequest(entry)

			return originalEnd(chunk, ...rest)
		} as any

		// Capture errors
		req.on("error", (err: Error) => {
			entry.error = err.message
			entry.endTime = Date.now()
			ContextInspectorPanel.getInstance().logNetworkError(entry)
		})

		return req
	}
}
