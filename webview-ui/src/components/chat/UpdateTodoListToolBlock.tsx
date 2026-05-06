import React, { useState, useEffect, useRef } from "react"
import { ToolUseBlock, ToolUseBlockHeader } from "../common/ToolUseBlock"
import MarkdownBlock from "../common/MarkdownBlock"

interface TodoItem {
	id?: string
	content: string
	status?: "completed" | "in_progress" | string
	/** From refine STEP 1 (item_contexts); shown in refined card before plans exist */
	context?: string
}

interface TodoPlanEntry {
	filePath: string
	content: string
}

interface TodoPlanTarget {
	target: string
	action: string
}

interface TodoPlanData {
	savedPath?: string
	savedPaths?: string[]
	planType?: "file" | "general"
	contexts: string[]
	plans: TodoPlanEntry[]
	targetStubs?: TodoPlanTarget[]
}

/**
 * @description
 * Editable Todo List component. Each time the todo list changes (edit, add, delete, status switch), the parent component will be notified via the onChange callback.
 * The parent component should synchronize the latest todos to the model in onChange.
 */
interface UpdateTodoListToolBlockProps {
	todos?: TodoItem[]
	previousTodos?: TodoItem[]
	todoPlansById?: Record<string, TodoPlanData>
	planTargets?: TodoPlanTarget[][]
	refiningTodoItemIds?: string[]
	activeRefiningTodoItemId?: string
	refineStatusLabel?: string
	refineReasoningContent?: string
	showRefiningIndicator?: boolean
	content?: string
	/**
	 * Callback when todos change, be sure to implement and notify the model with the latest todos
	 * @param todos Latest todo list
	 */
	onChange: (todos: TodoItem[]) => void
	/** Callback when user clicks refine on todo items */
	onRefine?: (todoItemIds: string[]) => void
	/** Whether editing is allowed (controlled externally) */
	editable?: boolean
	userEdited?: boolean
}

type TodoChangeType = "added" | "status_changed" | "content_changed" | "unchanged"

function computeTodoChanges(prev: TodoItem[] | undefined, current: TodoItem[]): Map<string, TodoChangeType> {
	const changes = new Map<string, TodoChangeType>()
	if (!prev || prev.length === 0) return changes
	const prevMap = new Map<string, TodoItem>()
	for (const t of prev) {
		if (t.id) prevMap.set(t.id, t)
	}
	for (const t of current) {
		const id = t.id || t.content
		const old = t.id ? prevMap.get(t.id) : prev.find((p) => p.content === t.content)
		if (!old) {
			changes.set(id, "added")
		} else if ((old.status || "") !== (t.status || "")) {
			changes.set(id, "status_changed")
		} else if (old.content !== t.content) {
			changes.set(id, "content_changed")
		} else {
			changes.set(id, "unchanged")
		}
	}
	return changes
}

const STATUS_OPTIONS = [
	{ value: "", label: "Not Started", color: "var(--vscode-foreground)", border: "#bbb", bg: "transparent" },
	{
		value: "in_progress",
		label: "In Progress",
		color: "var(--vscode-charts-yellow)",
		border: "var(--vscode-charts-yellow)",
		bg: "rgba(255, 221, 51, 0.15)",
	},
	{
		value: "completed",
		label: "Completed",
		color: "var(--vscode-charts-green)",
		border: "var(--vscode-charts-green)",
		bg: "var(--vscode-charts-green)",
	},
]

const genId = () => Math.random().toString(36).slice(2, 10)

const CHANGE_COLORS: Record<TodoChangeType, string> = {
	added: "var(--vscode-charts-blue)",
	status_changed: "var(--vscode-charts-yellow)",
	content_changed: "var(--vscode-charts-orange)",
	unchanged: "transparent",
}

function getDisplayedPlanContent(content: string) {
	const stripped = content.replace(
		/^<<<PLAN_TARGET>>>\r?\nACTION: .*\r?\nPATH: .*\r?\n<<<END_PLAN_TARGET>>>(?:\r?\n)*/,
		"",
	)

	return stripped.trim() || content
}

function normalizePlanTargetsForDisplay(value: unknown): TodoPlanTarget[] {
	if (!Array.isArray(value)) {
		return []
	}
	return value
		.map((entry) => {
			if (!entry || typeof entry !== "object") {
				return undefined
			}
			const record = entry as Record<string, unknown>
			return typeof record.target === "string" && typeof record.action === "string"
				? { target: record.target, action: record.action }
				: undefined
		})
		.filter((entry): entry is TodoPlanTarget => !!entry)
}

function normalizeTargetKey(value: string): string {
	return value
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "")
		.replace(/\/+/g, "/")
		.toLowerCase()
}

function RefinedTodoCard({ todo, plan }: { todo: TodoItem; plan?: TodoPlanData }) {
	const [isExpanded, setIsExpanded] = React.useState(false)
	const [expandedSections, setExpandedSections] = React.useState<Set<number>>(new Set())
	const [expandedContexts, setExpandedContexts] = React.useState<Set<number>>(new Set())
	const targetStubs = plan?.targetStubs ?? []
	const hasTargetStubs = targetStubs.length > 0
	const hasPlan = !!plan && (plan.plans.length > 0 || plan.contexts.length > 0 || hasTargetStubs)
	const hasContexts = !!plan && plan.contexts.length > 0
	const plannedTargetKeys = new Set((plan?.plans ?? []).map((entry) => normalizeTargetKey(entry.filePath)))
	const plannedTargetCount = hasTargetStubs
		? targetStubs.filter((target) => plannedTargetKeys.has(normalizeTargetKey(target.target))).length
		: (plan?.plans.length ?? 0)

	const toggleContext = (idx: number) => {
		setExpandedContexts((prev) => {
			const next = new Set(prev)
			if (next.has(idx)) {
				next.delete(idx)
			} else {
				next.add(idx)
			}
			return next
		})
	}
	const statusColor =
		todo.status === "completed"
			? "var(--vscode-charts-green)"
			: todo.status === "in_progress"
				? "var(--vscode-charts-yellow)"
				: "var(--vscode-descriptionForeground)"

	const toggleSection = (idx: number) => {
		setExpandedSections((prev) => {
			const next = new Set(prev)
			if (next.has(idx)) {
				next.delete(idx)
			} else {
				next.add(idx)
			}
			return next
		})
	}

	return (
		<div
			style={{
				borderRadius: 6,
				border: hasPlan ? "1px solid rgba(55, 148, 255, 0.32)" : "1px solid rgba(55, 148, 255, 0.12)",
				background: hasPlan ? "var(--vscode-editor-background)" : "rgba(55, 148, 255, 0.03)",
				overflow: "hidden",
			}}>
			<div
				onClick={() => {
					if (hasPlan) {
						setIsExpanded(!isExpanded)
					}
				}}
				style={{
					display: "flex",
					alignItems: "center",
					gap: 6,
					padding: "8px 10px",
					cursor: hasPlan ? "pointer" : "default",
					userSelect: "none",
					fontSize: 13,
					color: "var(--vscode-foreground)",
				}}>
				<span
					className={`codicon codicon-chevron-${isExpanded ? "down" : "right"}`}
					style={{
						fontSize: 13,
						flexShrink: 0,
						opacity: hasPlan ? 1 : 0.35,
					}}
				/>
				<span className="codicon codicon-wand" style={{ color: "var(--vscode-charts-blue)", flexShrink: 0 }} />
				<div style={{ minWidth: 0, flex: 1, lineHeight: "1.35" }}>
					<div
						style={{
							color: "var(--vscode-foreground)",
							fontWeight: 600,
						}}>
						{todo.content}
					</div>
					<div style={{ color: "var(--vscode-descriptionForeground)", fontSize: 12 }}>
						{hasPlan
							? hasTargetStubs
								? `${plannedTargetCount}/${targetStubs.length} STEP 2 target(s) planned`
								: plan.plans.length > 0
									? `${plan.plans.length} ${plan.planType === "general" ? "section(s)" : "file(s)"}`
									: plan.contexts.length > 0
										? `${plan.contexts.length} task context block(s)`
										: "No refine details"
							: "No refine details"}
					</div>
				</div>
				<span
					style={{
						display: "inline-block",
						width: 8,
						height: 8,
						borderRadius: "50%",
						marginLeft: 4,
						flexShrink: 0,
						background:
							todo.status === "completed" || todo.status === "in_progress" ? statusColor : "transparent",
						border:
							todo.status === "completed" || todo.status === "in_progress"
								? "none"
								: "1px solid var(--vscode-descriptionForeground)",
					}}
				/>
			</div>
			{isExpanded && hasPlan && plan && (
				<div style={{ borderTop: "1px solid var(--vscode-editorGroup-border)" }}>
					{hasTargetStubs && (
						<div style={{ borderBottom: "1px solid var(--vscode-editorGroup-border)" }}>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 6,
									padding: "6px 10px 6px 20px",
									fontSize: 12,
									color: "var(--vscode-foreground)",
								}}>
								<span
									className="codicon codicon-list-tree"
									style={{
										fontSize: 12,
										flexShrink: 0,
										color: "var(--vscode-charts-blue)",
									}}
								/>
								<span style={{ fontWeight: 500, opacity: 0.9 }}>STEP 1 File Targets</span>
								<span style={{ color: "var(--vscode-descriptionForeground)", fontSize: 11 }}>
									{plannedTargetCount}/{targetStubs.length} planned
								</span>
							</div>
							<div
								style={{
									padding: "0 14px 8px 36px",
									fontFamily: "var(--vscode-editor-font-family)",
									fontSize: 12,
									color: "var(--vscode-descriptionForeground)",
								}}>
								{targetStubs.map((target, index) => (
									<div
										key={`${target.action}-${target.target}-${index}`}
										style={{
											display: "flex",
											alignItems: "center",
											gap: 6,
										}}>
										<span
											className={`codicon codicon-${plannedTargetKeys.has(normalizeTargetKey(target.target)) ? "check" : "circle-large-outline"}`}
											style={{
												color: plannedTargetKeys.has(normalizeTargetKey(target.target))
													? "var(--vscode-charts-green)"
													: "var(--vscode-descriptionForeground)",
												fontSize: 11,
												flexShrink: 0,
											}}
										/>
										<span style={{ color: "var(--vscode-charts-blue)", marginRight: 6 }}>
											{target.action}
										</span>
										<span>{target.target}</span>
									</div>
								))}
							</div>
						</div>
					)}
					{/* Context sections — parent agent's cross-cutting context (interfaces, contracts, dependencies) */}
					{hasContexts &&
						plan.contexts.map((ctx, ctxIdx) => (
							<div
								key={`ctx-${ctxIdx}`}
								style={{
									borderBottom: "1px solid var(--vscode-editorGroup-border)",
								}}>
								<div
									onClick={() => toggleContext(ctxIdx)}
									style={{
										display: "flex",
										alignItems: "center",
										gap: 6,
										padding: "6px 10px 6px 20px",
										cursor: "pointer",
										userSelect: "none",
										fontSize: 12,
										color: "var(--vscode-foreground)",
									}}>
									<span
										className={`codicon codicon-chevron-${expandedContexts.has(ctxIdx) ? "down" : "right"}`}
										style={{ fontSize: 12, flexShrink: 0 }}
									/>
									<span
										className="codicon codicon-symbol-interface"
										style={{
											fontSize: 12,
											flexShrink: 0,
											color: "var(--vscode-charts-purple)",
										}}
									/>
									<span style={{ fontWeight: 500, opacity: 0.9 }}>
										Task Context{plan.contexts.length > 1 ? ` (${ctxIdx + 1})` : ""}
									</span>
									<span style={{ color: "var(--vscode-descriptionForeground)", fontSize: 11 }}>
										interfaces & contracts
									</span>
								</div>
								{expandedContexts.has(ctxIdx) && (
									<div
										style={{
											padding: "4px 14px 8px 36px",
											color: "var(--vscode-foreground)",
											maxHeight: "30vh",
											overflowY: "auto",
											overflowX: "hidden",
											background: "#000000",
											borderRadius: 4,
											margin: "4px 12px 8px 28px",
										}}>
										<MarkdownBlock markdown={ctx} />
									</div>
								)}
							</div>
						))}
					{plan.plans.map((entry, index) => (
						<div
							key={index}
							style={{
								borderBottom:
									index < plan.plans.length - 1
										? "1px solid var(--vscode-editorGroup-border)"
										: undefined,
							}}>
							<div
								onClick={() => toggleSection(index)}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 6,
									padding: "6px 10px 6px 20px",
									cursor: "pointer",
									userSelect: "none",
									fontSize: 12,
									color: "var(--vscode-foreground)",
								}}>
								<span
									className={`codicon codicon-chevron-${expandedSections.has(index) ? "down" : "right"}`}
									style={{ fontSize: 12, flexShrink: 0 }}
								/>
								<span
									className={`codicon codicon-${plan.planType === "general" ? "book" : "file-code"}`}
									style={{
										fontSize: 12,
										flexShrink: 0,
										color: "var(--vscode-descriptionForeground)",
									}}
								/>
								<span style={{ fontFamily: "var(--vscode-editor-font-family)", opacity: 0.9 }}>
									{entry.filePath}
								</span>
							</div>
							{expandedSections.has(index) && (
								<div
									style={{
										padding: "4px 14px 8px 36px",
										color: "var(--vscode-foreground)",
										maxHeight: "30vh",
										overflowY: "auto",
										overflowX: "hidden",
										background: "#000000",
										borderRadius: 4,
										margin: "4px 12px 8px 28px",
									}}>
									<MarkdownBlock markdown={getDisplayedPlanContent(entry.content)} />
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	)
}

const UpdateTodoListToolBlock: React.FC<UpdateTodoListToolBlockProps> = ({
	todos = [],
	previousTodos,
	todoPlansById,
	planTargets,
	refiningTodoItemIds,
	activeRefiningTodoItemId,
	refineStatusLabel = "subagent...",
	refineReasoningContent = "",
	showRefiningIndicator = false,
	content,
	onChange,
	onRefine,
	editable = true,
	userEdited = false,
}) => {
	const changeMap = React.useMemo(
		() => (userEdited && previousTodos ? computeTodoChanges(previousTodos, todos) : new Map()),
		[userEdited, previousTodos, todos],
	)
	const [editTodos, setEditTodos] = useState<TodoItem[]>(
		todos.length > 0 ? todos.map((todo) => ({ ...todo, id: todo.id || genId() })) : [],
	)
	const [adding, setAdding] = useState(false)
	const [newContent, setNewContent] = useState("")
	const newInputRef = useRef<HTMLInputElement>(null)
	const [deleteId, setDeleteId] = useState<string | null>(null)
	const [isEditing, setIsEditing] = useState(false)
	const [expandedInlineThinkingIds, setExpandedInlineThinkingIds] = useState<Set<string>>(new Set())
	const [selectedForRefine, setSelectedForRefine] = useState<Set<string>>(new Set())
	const [isRefineMode, setIsRefineMode] = useState(false)
	const displayPlanTargets = React.useMemo(
		() => (Array.isArray(planTargets) ? planTargets.map((targets) => normalizePlanTargetsForDisplay(targets)) : []),
		[planTargets],
	)
	const refiningTodoIdSet = React.useMemo(
		() => new Set((showRefiningIndicator ? refiningTodoItemIds : []) ?? []),
		[refiningTodoItemIds, showRefiningIndicator],
	)

	// Automatically exit edit mode when external editable becomes false
	useEffect(() => {
		if (!editable && isEditing) {
			setIsEditing(false)
		}
	}, [editable, isEditing])

	// Check if onChange is passed
	useEffect(() => {
		if (typeof onChange !== "function") {
			console.warn(
				"UpdateTodoListToolBlock: onChange callback not passed, cannot notify model after todo changes!",
			)
		}
		// Only check once on mount
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Sync when external props.todos changes
	useEffect(() => {
		setEditTodos(todos.length > 0 ? todos.map((todo) => ({ ...todo, id: todo.id || genId() })) : [])
	}, [todos])

	// Auto focus on new item
	useEffect(() => {
		if (adding && newInputRef.current) {
			newInputRef.current.focus()
		}
	}, [adding])

	// Edit content
	const handleContentChange = (id: string, value: string) => {
		const newTodos = editTodos.map((todo) => (todo.id === id ? { ...todo, content: value } : todo))
		setEditTodos(newTodos)
		onChange?.(newTodos)
	}

	// Change status
	const handleStatusChange = (id: string, status: string) => {
		const newTodos = editTodos.map((todo) => (todo.id === id ? { ...todo, status } : todo))
		setEditTodos(newTodos)
		onChange?.(newTodos)
	}

	// Delete (confirmation dialog)
	const handleDelete = (id: string) => {
		setDeleteId(id)
	}
	const confirmDelete = () => {
		if (!deleteId) return
		const newTodos = editTodos.filter((todo) => todo.id !== deleteId)
		setEditTodos(newTodos)
		onChange?.(newTodos)
		setDeleteId(null)
	}
	const cancelDelete = () => setDeleteId(null)

	// Add
	const handleAdd = () => {
		if (!newContent.trim()) return
		const newTodo: TodoItem = {
			id: genId(),
			content: newContent.trim(),
			status: "",
		}
		const newTodos = [...editTodos, newTodo]
		setEditTodos(newTodos)
		onChange?.(newTodos)
		setNewContent("")
		setAdding(false)
	}

	// Add on Enter
	const handleNewInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			handleAdd()
		} else if (e.key === "Escape") {
			setAdding(false)
			setNewContent("")
		}
	}

	const toggleInlineThinking = (id: string) => {
		setExpandedInlineThinkingIds((prev) => {
			const next = new Set(prev)
			if (next.has(id)) {
				next.delete(id)
			} else {
				next.add(id)
			}
			return next
		})
	}

	return (
		<>
			<ToolUseBlock>
				<ToolUseBlockHeader>
					<div className="flex items-center w-full" style={{ width: "100%" }}>
						<span
							className={userEdited ? "codicon codicon-sync mr-1.5" : "codicon codicon-checklist mr-1.5"}
							style={{ color: userEdited ? "var(--vscode-charts-yellow)" : "var(--vscode-foreground)" }}
						/>
						<span className="font-bold mr-2" style={{ fontWeight: "bold" }}>
							{userEdited ? "Todo List Modified" : "Todo List Updated"}
						</span>
						<div className="flex-grow" />
						{editable && onRefine && !isEditing && (
							<button
								type="button"
								onClick={() => {
									if (isRefineMode) {
										// Send selected items for refinement
										if (selectedForRefine.size > 0) {
											onRefine(Array.from(selectedForRefine))
										}
										setIsRefineMode(false)
										setSelectedForRefine(new Set())
									} else {
										setIsRefineMode(true)
									}
								}}
								style={{
									border: isRefineMode
										? "1px solid var(--vscode-charts-blue)"
										: "1px solid var(--vscode-button-secondaryBorder)",
									background: isRefineMode
										? "var(--vscode-charts-blue)"
										: "var(--vscode-button-secondaryBackground)",
									color: isRefineMode ? "#fff" : "var(--vscode-button-secondaryForeground)",
									borderRadius: 4,
									padding: "2px 8px",
									cursor: "pointer",
									fontSize: 12,
									marginLeft: 6,
								}}>
								<span className="codicon codicon-wand mr-1" style={{ fontSize: 12 }} />
								{isRefineMode
									? selectedForRefine.size > 0
										? `Refine (${selectedForRefine.size})`
										: "Cancel"
									: "Refine"}
							</button>
						)}
						{isRefineMode && onRefine && (
							<button
								type="button"
								onClick={() => {
									const allIds = editTodos.map((t) => t.id).filter(Boolean) as string[]
									if (selectedForRefine.size === allIds.length) {
										setSelectedForRefine(new Set())
									} else {
										setSelectedForRefine(new Set(allIds))
									}
								}}
								style={{
									border: "1px solid var(--vscode-button-secondaryBorder)",
									background: "var(--vscode-button-secondaryBackground)",
									color: "var(--vscode-button-secondaryForeground)",
									borderRadius: 4,
									padding: "2px 8px",
									cursor: "pointer",
									fontSize: 12,
									marginLeft: 4,
								}}>
								{selectedForRefine.size === editTodos.length ? "Deselect All" : "Select All"}
							</button>
						)}
						{editable && !isRefineMode && (
							<button
								type="button"
								onClick={() => setIsEditing(!isEditing)}
								style={{
									border: isEditing
										? "1px solid var(--vscode-button-border)"
										: "1px solid var(--vscode-button-secondaryBorder)",
									background: isEditing
										? "var(--vscode-button-background)"
										: "var(--vscode-button-secondaryBackground)",
									color: isEditing
										? "var(--vscode-button-foreground)"
										: "var(--vscode-button-secondaryForeground)",
									borderRadius: 4,
									padding: "2px 8px",
									cursor: "pointer",
									fontSize: 13,
									marginLeft: 8,
								}}>
								{isEditing ? "Done" : "Edit"}
							</button>
						)}
					</div>
				</ToolUseBlockHeader>
				<div className="overflow-x-auto max-w-full" style={{ padding: "6px 0 2px 0" }}>
					{Array.isArray(editTodos) && editTodos.length > 0 ? (
						<ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
							{editTodos.map((todo, idx) => {
								let icon
								if (todo.status === "completed") {
									icon = (
										<span
											style={{
												display: "inline-block",
												width: 8,
												height: 8,
												borderRadius: "50%",
												background: "var(--vscode-charts-green)",
												marginRight: 6,
												marginTop: 7,
												flexShrink: 0,
											}}
										/>
									)
								} else if (todo.status === "in_progress") {
									icon = (
										<span
											style={{
												display: "inline-block",
												width: 8,
												height: 8,
												borderRadius: "50%",
												background: "var(--vscode-charts-yellow)",
												marginRight: 6,
												marginTop: 7,
												flexShrink: 0,
											}}
										/>
									)
								} else {
									icon = (
										<span
											style={{
												display: "inline-block",
												width: 8,
												height: 8,
												borderRadius: "50%",
												border: "1px solid var(--vscode-descriptionForeground)",
												background: "transparent",
												marginRight: 6,
												marginTop: 7,
												flexShrink: 0,
											}}
										/>
									)
								}
								const changeType = changeMap.get(todo.id || todo.content) as TodoChangeType | undefined
								const changeColor = changeType ? CHANGE_COLORS[changeType] : "transparent"
								const todoPlan = todo.id ? todoPlansById?.[todo.id] : undefined
								const targetStubs = displayPlanTargets[idx] ?? []
								const contextFromTodo = todo.context?.trim() ? [todo.context.trim()] : []
								const effectivePlan: TodoPlanData | undefined =
									todoPlan || contextFromTodo.length > 0 || targetStubs.length > 0
										? {
												...(todoPlan ?? { contexts: contextFromTodo, plans: [] }),
												contexts: todoPlan?.contexts?.length
													? todoPlan.contexts
													: contextFromTodo,
												plans: todoPlan?.plans ?? [],
												targetStubs: todoPlan?.targetStubs?.length
													? todoPlan.targetStubs
													: targetStubs,
											}
										: undefined
								const hasInlineRefinedCard =
									!isEditing &&
									(!!effectivePlan?.plans?.length ||
										!!effectivePlan?.contexts?.length ||
										!!effectivePlan?.targetStubs?.length)
								const isActiveInlineRefining =
									showRefiningIndicator &&
									!!todo.id &&
									activeRefiningTodoItemId === todo.id &&
									!effectivePlan?.plans?.length &&
									!effectivePlan?.contexts?.length &&
									!effectivePlan?.targetStubs?.length
								const shouldShowInlineRefining =
									isActiveInlineRefining && !!todo.id && refiningTodoIdSet.has(todo.id)
								const shouldShowInlineThinking =
									shouldShowInlineRefining &&
									refineStatusLabel === "thinking..." &&
									refineReasoningContent.trim().length > 0
								const isInlineThinkingExpanded = !!todo.id && expandedInlineThinkingIds.has(todo.id)
								return (
									<li
										key={todo.id || idx}
										style={{
											marginBottom: hasInlineRefinedCard ? 8 : 2,
											display: "flex",
											alignItems: hasInlineRefinedCard ? "stretch" : "flex-start",
											minHeight: 20,
											borderLeft:
												changeColor !== "transparent" ? `3px solid ${changeColor}` : undefined,
											paddingLeft: changeColor !== "transparent" ? 6 : undefined,
											borderRadius: 2,
										}}>
										{isRefineMode && todo.id && (
											<input
												type="checkbox"
												checked={selectedForRefine.has(todo.id)}
												onChange={() => {
													setSelectedForRefine((prev) => {
														const next = new Set(prev)
														if (next.has(todo.id!)) {
															next.delete(todo.id!)
														} else {
															next.add(todo.id!)
														}
														return next
													})
												}}
												style={{
													marginRight: 6,
													marginTop: hasInlineRefinedCard ? 8 : 7,
													flexShrink: 0,
													accentColor: "var(--vscode-charts-blue)",
												}}
											/>
										)}
										{!isRefineMode && !hasInlineRefinedCard && icon}
										{isEditing && (
											<select
												value={todo.status || ""}
												onChange={(e) => handleStatusChange(todo.id!, e.target.value)}
												style={{
													marginRight: 6,
													borderRadius: 4,
													border: "1px solid var(--vscode-input-border)",
													background: "var(--vscode-input-background)",
													color: "var(--vscode-input-foreground)",
													fontSize: 12,
													padding: "1px 4px",
												}}>
												{STATUS_OPTIONS.map((opt) => (
													<option key={opt.value} value={opt.value}>
														{opt.label}
													</option>
												))}
											</select>
										)}
										{isEditing ? (
											<input
												type="text"
												value={todo.content}
												onChange={(e) => handleContentChange(todo.id!, e.target.value)}
												style={{
													flex: 1,
													minWidth: 0,
													fontWeight: 500,
													color:
														todo.status === "completed"
															? "var(--vscode-charts-green)"
															: todo.status === "in_progress"
																? "var(--vscode-charts-yellow)"
																: "var(--vscode-foreground)",
													background: "transparent",
													border: "none",
													outline: "none",
													fontSize: 13,
													padding: "1px 3px",
													lineHeight: "1.4",
												}}
												onBlur={(e) => {
													if (!e.target.value.trim()) {
														handleDelete(todo.id!)
													}
												}}
											/>
										) : hasInlineRefinedCard ? (
											<div
												style={{
													flex: 1,
													minWidth: 0,
													marginRight: 6,
												}}>
												<RefinedTodoCard todo={todo} plan={effectivePlan} />
											</div>
										) : (
											<div
												style={{
													flex: 1,
													minWidth: 0,
												}}>
												<span
													style={{
														display: "block",
														fontWeight: 500,
														color:
															todo.status === "completed"
																? "var(--vscode-charts-green)"
																: todo.status === "in_progress"
																	? "var(--vscode-charts-yellow)"
																	: "var(--vscode-foreground)",
														fontSize: 13,
														padding: "1px 3px",
														lineHeight: "1.4",
													}}>
													{todo.content}
												</span>
												{shouldShowInlineRefining &&
													(shouldShowInlineThinking && todo.id ? (
														<button
															type="button"
															onClick={() => toggleInlineThinking(todo.id!)}
															style={{
																marginTop: 4,
																marginLeft: 3,
																padding: 0,
																border: "none",
																background: "transparent",
																color: "var(--vscode-descriptionForeground)",
																fontSize: 11,
																lineHeight: "1.35",
																cursor: "pointer",
																display: "flex",
																alignItems: "center",
																gap: 4,
															}}>
															<span
																className={`codicon codicon-chevron-${isInlineThinkingExpanded ? "down" : "right"}`}
																style={{ fontSize: 11 }}
															/>
															<span>{refineStatusLabel}</span>
														</button>
													) : (
														<div
															style={{
																marginTop: 4,
																marginLeft: 3,
																fontSize: 11,
																lineHeight: "1.35",
																color: "var(--vscode-descriptionForeground)",
															}}>
															{refineStatusLabel}
														</div>
													))}
												{shouldShowInlineThinking && isInlineThinkingExpanded && (
													<div
														style={{
															marginTop: 4,
															marginLeft: 3,
															padding: "6px 10px",
															borderLeft: "2px solid var(--vscode-widget-border)",
															background: "var(--vscode-editor-background)",
															borderRadius: 4,
															maxHeight: "24vh",
															overflowY: "auto",
														}}>
														<MarkdownBlock markdown={refineReasoningContent} />
													</div>
												)}
											</div>
										)}
										{isEditing && (
											<button
												type="button"
												onClick={() => handleDelete(todo.id!)}
												style={{
													border: "none",
													background: "transparent",
													color: "#f14c4c",
													cursor: "pointer",
													fontSize: 14,
													marginLeft: 2,
													padding: 0,
													lineHeight: 1,
												}}
												title="Remove">
												×
											</button>
										)}
									</li>
								)
							})}
							{adding ? (
								<li style={{ marginTop: 2, display: "flex", alignItems: "center" }}>
									<span style={{ width: 14, marginRight: 6 }} />
									<input
										ref={newInputRef}
										type="text"
										value={newContent}
										placeholder="Enter todo item, press Enter to add"
										onChange={(e) => setNewContent(e.target.value)}
										onKeyDown={handleNewInputKeyDown}
										style={{
											flex: 1,
											minWidth: 0,
											fontWeight: 500,
											color: "var(--vscode-foreground)",
											background: "transparent",
											border: "none",
											outline: "none",
											fontSize: 13,
											marginRight: 6,
											padding: "1px 3px",
											borderBottom: "1px solid #eee",
										}}
									/>
									<button
										type="button"
										onClick={handleAdd}
										disabled={!newContent.trim()}
										style={{
											border: "1px solid var(--vscode-button-border)",
											background: "var(--vscode-button-background)",
											color: "var(--vscode-button-foreground)",
											borderRadius: 4,
											padding: "1px 7px",
											cursor: newContent.trim() ? "pointer" : "not-allowed",
											fontSize: 12,
											marginRight: 4,
										}}>
										Add
									</button>
									<button
										type="button"
										onClick={() => {
											setAdding(false)
											setNewContent("")
										}}
										style={{
											border: "1px solid var(--vscode-button-secondaryBorder)",
											background: "var(--vscode-button-secondaryBackground)",
											color: "var(--vscode-button-secondaryForeground)",
											borderRadius: 4,
											padding: "1px 7px",
											cursor: "pointer",
											fontSize: 12,
										}}>
										Cancel
									</button>
								</li>
							) : (
								<li style={{ marginTop: 2 }}>
									{isEditing && (
										<button
											type="button"
											onClick={() => setAdding(true)}
											style={{
												border: "1px dashed var(--vscode-button-secondaryBorder)",
												background: "var(--vscode-button-secondaryBackground)",
												color: "var(--vscode-button-secondaryForeground)",
												borderRadius: 4,
												padding: "1px 8px",
												cursor: "pointer",
												fontSize: 12,
											}}>
											+ Add Todo
										</button>
									)}
								</li>
							)}
						</ul>
					) : (
						<MarkdownBlock markdown={content} />
					)}
					{/* Global refine indicator: shown at the bottom of the list only during
					    the __global__ exploration phase, before the list is rewritten */}
					{showRefiningIndicator && activeRefiningTodoItemId === "__global__" && (
						<div style={{ marginTop: 6, marginLeft: 3 }}>
							{refineReasoningContent.trim().length > 0 ? (
								<button
									type="button"
									onClick={() => {
										/* toggle handled via parent state - just show inline */
									}}
									style={{
										padding: 0,
										border: "none",
										background: "transparent",
										color: "var(--vscode-descriptionForeground)",
										fontSize: 11,
										lineHeight: "1.35",
										cursor: "default",
										display: "flex",
										alignItems: "center",
										gap: 4,
									}}>
									<span className="codicon codicon-chevron-down" style={{ fontSize: 11 }} />
									<span>{refineStatusLabel}</span>
								</button>
							) : (
								<div
									style={{
										fontSize: 11,
										lineHeight: "1.35",
										color: "var(--vscode-descriptionForeground)",
									}}>
									{refineStatusLabel}
								</div>
							)}
							{refineReasoningContent.trim().length > 0 && (
								<div
									style={{
										marginTop: 4,
										marginLeft: 3,
										padding: "6px 10px",
										borderLeft: "2px solid var(--vscode-widget-border)",
										background: "var(--vscode-editor-background)",
										borderRadius: 4,
										maxHeight: "24vh",
										overflowY: "auto",
									}}>
									<MarkdownBlock markdown={refineReasoningContent} />
								</div>
							)}
						</div>
					)}
				</div>
				{/* Delete confirmation dialog */}
				{deleteId && (
					<div
						style={{
							position: "fixed",
							left: 0,
							top: 0,
							right: 0,
							bottom: 0,
							background: "rgba(0,0,0,0.15)",
							zIndex: 9999,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
						}}
						onClick={cancelDelete}>
						<div
							style={{
								background: "#fff",
								borderRadius: 8,
								boxShadow: "0 2px 16px rgba(0,0,0,0.15)",
								padding: "16px 20px",
								minWidth: 200,
								zIndex: 10000,
							}}
							onClick={(e) => e.stopPropagation()}>
							<div style={{ marginBottom: 12, fontSize: 14, color: "#333" }}>
								Are you sure you want to delete this todo item?
							</div>
							<div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
								<button
									type="button"
									onClick={cancelDelete}
									style={{
										border: "1px solid #bbb",
										background: "transparent",
										color: "#888",
										borderRadius: 4,
										padding: "2px 10px",
										cursor: "pointer",
										fontSize: 12,
									}}>
									Cancel
								</button>
								<button
									type="button"
									onClick={confirmDelete}
									style={{
										border: "1px solid #f14c4c",
										background: "#f14c4c",
										color: "#fff",
										borderRadius: 4,
										padding: "2px 10px",
										cursor: "pointer",
										fontSize: 12,
									}}>
									Delete
								</button>
							</div>
						</div>
					</div>
				)}
			</ToolUseBlock>
		</>
	)
}

export default UpdateTodoListToolBlock
