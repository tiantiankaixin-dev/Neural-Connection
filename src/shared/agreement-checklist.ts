const AGREEMENT_CHECKLIST_ITEMS = [
	"API routes and HTTP methods, including exact paths, params, query keys, request body shapes, response body shapes, status codes, and error response shapes.",
	"Authentication and authorization contracts, including token/header names, JWT payload fields, cookie/storage keys, role names, permission gates, and secret/env key names.",
	"Shared data models and database mappings, including table/collection names, field names, enum values, validation rules, default values, indexes, and relationship semantics.",
	"Frontend/backend integration contracts, including producer files that implement/accept/return values and consumer files that call/send/handle/store those values.",
	"Shared functions, classes, modules, events, message names, protocol names, exported identifiers, import boundaries, and ownership boundaries used across refined files.",
	"Persistence and runtime configuration contracts, including local/session storage keys, cache keys, file paths, environment variables, ports, feature flags, and external service names.",
	"Error handling and lifecycle expectations shared across files, including retry behavior, timeout semantics, loading states, empty states, cancellation behavior, and cleanup rules.",
]

export function renderAgreementChecklistBullets(): string {
	return AGREEMENT_CHECKLIST_ITEMS.map((item) => `- ${item}`).join("\n")
}
