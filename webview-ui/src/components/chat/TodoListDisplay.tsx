import { cn } from "@/lib/utils"
import { t } from "i18next"
import { ArrowRight, Check, ChevronDown, ChevronRight, ListChecks, Pencil, Plus, Trash2, X } from "lucide-react"
import { useState, useRef, useMemo, useEffect, useCallback } from "react"
import { vscode } from "@src/utils/vscode"

type TodoStatus = "completed" | "in_progress" | "pending"

interface TodoItem {
	id?: string
	content: string
	status?: TodoStatus | string
}

const STATUS_CYCLE: TodoStatus[] = ["pending", "in_progress", "completed"]

function getStatusIcon(status: TodoStatus | string | undefined, size = "size-3.5") {
	switch (status) {
		case "completed":
			return (
				<div
					className={cn(
						size,
						"shrink-0 rounded-full bg-vscode-charts-green flex items-center justify-center",
					)}>
					<Check className="size-2.5 text-white" strokeWidth={3} />
				</div>
			)
		case "in_progress":
			return (
				<div
					className={cn(
						size,
						"shrink-0 rounded-full border-2 border-vscode-charts-yellow flex items-center justify-center",
					)}>
					<ArrowRight className="size-2 text-vscode-charts-yellow" strokeWidth={3} />
				</div>
			)
		default:
			return <div className={cn(size, "shrink-0 rounded-full border border-vscode-descriptionForeground/50")} />
	}
}

function genId() {
	return Math.random().toString(36).slice(2, 10)
}

export function TodoListDisplay({ todos }: { todos: any[] }) {
	const [isCollapsed, setIsCollapsed] = useState(true)
	const [isEditing, setIsEditing] = useState(false)
	const [editTodos, setEditTodos] = useState<TodoItem[]>([])
	const [addingContent, setAddingContent] = useState("")
	const [isAdding, setIsAdding] = useState(false)
	const addInputRef = useRef<HTMLInputElement>(null)
	const ulRef = useRef<HTMLUListElement>(null)
	const itemRefs = useRef<(HTMLLIElement | null)[]>([])

	const scrollIndex = useMemo(() => {
		const inProgressIdx = todos.findIndex((todo: any) => todo.status === "in_progress")
		if (inProgressIdx !== -1) return inProgressIdx
		return todos.findIndex((todo: any) => todo.status !== "completed")
	}, [todos])

	const mostImportantTodo = useMemo(() => {
		const inProgress = todos.find((todo: any) => todo.status === "in_progress")
		if (inProgress) return inProgress
		return todos.find((todo: any) => todo.status !== "completed")
	}, [todos])

	useEffect(() => {
		if (isCollapsed) return
		if (!ulRef.current) return
		if (scrollIndex === -1) return
		const target = itemRefs.current[scrollIndex]
		if (target && ulRef.current) {
			const ul = ulRef.current
			const targetTop = target.offsetTop - ul.offsetTop
			const targetHeight = target.offsetHeight
			const ulHeight = ul.clientHeight
			const scrollTo = targetTop - (ulHeight / 2 - targetHeight / 2)
			ul.scrollTop = scrollTo
		}
	}, [todos, isCollapsed, scrollIndex])

	// Sync editTodos when entering edit mode or when todos change while editing
	useEffect(() => {
		setEditTodos(todos.map((t: any) => ({ ...t, id: t.id || genId() })))
	}, [todos])

	// Auto-focus add input
	useEffect(() => {
		if (isAdding && addInputRef.current) {
			addInputRef.current.focus()
		}
	}, [isAdding])

	const sendEdit = useCallback((newTodos: TodoItem[]) => {
		setEditTodos(newTodos)
		vscode.postMessage({ type: "editTodoList", payload: { todos: newTodos } })
	}, [])

	const handleStatusCycle = useCallback(
		(id: string) => {
			const newTodos = editTodos.map((todo) => {
				if (todo.id !== id) return todo
				const currentIdx = STATUS_CYCLE.indexOf((todo.status || "pending") as TodoStatus)
				const nextStatus = STATUS_CYCLE[(currentIdx + 1) % STATUS_CYCLE.length]
				return { ...todo, status: nextStatus }
			})
			sendEdit(newTodos)
		},
		[editTodos, sendEdit],
	)

	const handleContentChange = useCallback(
		(id: string, value: string) => {
			const newTodos = editTodos.map((todo) => (todo.id === id ? { ...todo, content: value } : todo))
			setEditTodos(newTodos)
		},
		[editTodos],
	)

	const handleContentBlur = useCallback(
		(id: string, value: string) => {
			if (!value.trim()) {
				// Remove empty items on blur
				const newTodos = editTodos.filter((todo) => todo.id !== id)
				sendEdit(newTodos)
			} else {
				sendEdit(editTodos)
			}
		},
		[editTodos, sendEdit],
	)

	const handleDelete = useCallback(
		(id: string) => {
			const newTodos = editTodos.filter((todo) => todo.id !== id)
			sendEdit(newTodos)
		},
		[editTodos, sendEdit],
	)

	const handleAdd = useCallback(() => {
		if (!addingContent.trim()) return
		const newTodo: TodoItem = { id: genId(), content: addingContent.trim(), status: "pending" }
		const newTodos = [...editTodos, newTodo]
		sendEdit(newTodos)
		setAddingContent("")
		setIsAdding(false)
	}, [addingContent, editTodos, sendEdit])

	const handleAddKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") handleAdd()
			else if (e.key === "Escape") {
				setIsAdding(false)
				setAddingContent("")
			}
		},
		[handleAdd],
	)

	if (!Array.isArray(todos) || todos.length === 0) return null

	const totalCount = todos.length
	const completedCount = todos.filter((todo: any) => todo.status === "completed").length
	const allCompleted = completedCount === totalCount && totalCount > 0
	const displayTodos = isEditing ? editTodos : todos

	return (
		<div
			data-todo-list
			className={cn(
				"mt-1.5 -mx-2.5 overflow-hidden rounded-md",
				"border border-vscode-panel-border/60",
				"bg-vscode-sideBar-background/40",
			)}>
			{/* Header */}
			<div
				className={cn(
					"flex items-center gap-2 px-2.5 py-1.5 cursor-pointer select-none",
					"hover:bg-vscode-list-hoverBackground/50 transition-colors",
				)}
				onClick={() => {
					setIsCollapsed((v) => !v)
					if (!isCollapsed) setIsEditing(false)
				}}>
				{isCollapsed ? (
					<ChevronRight className="size-3 shrink-0 text-vscode-descriptionForeground" />
				) : (
					<ChevronDown className="size-3 shrink-0 text-vscode-descriptionForeground" />
				)}
				<ListChecks
					className={cn(
						"size-3.5 shrink-0",
						allCompleted
							? "text-vscode-charts-green"
							: mostImportantTodo?.status === "in_progress"
								? "text-vscode-charts-yellow"
								: "text-vscode-foreground",
					)}
				/>
				<span
					className={cn(
						"flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium",
						allCompleted && "text-vscode-charts-green",
						!allCompleted &&
							mostImportantTodo?.status === "in_progress" &&
							isCollapsed &&
							"text-vscode-charts-yellow",
					)}>
					{isCollapsed
						? allCompleted
							? t("chat:todo.complete", { total: completedCount })
							: mostImportantTodo?.content
						: t("chat:todo.partial", { completed: completedCount, total: totalCount })}
				</span>
				{/* Progress badge */}
				<div
					className={cn(
						"shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full",
						allCompleted
							? "bg-vscode-charts-green/20 text-vscode-charts-green"
							: "bg-vscode-badge-background text-vscode-badge-foreground",
					)}>
					{completedCount}/{totalCount}
				</div>
				{/* Edit button (only when expanded) */}
				{!isCollapsed && (
					<button
						className={cn(
							"shrink-0 p-0.5 rounded hover:bg-vscode-toolbar-hoverBackground transition-colors",
							isEditing && "text-vscode-charts-yellow",
						)}
						onClick={(e) => {
							e.stopPropagation()
							setIsEditing((v) => !v)
							if (isEditing) setIsAdding(false)
						}}
						title={isEditing ? t("chat:todo.doneEditing") : t("chat:todo.edit")}>
						{isEditing ? <X className="size-3.5" /> : <Pencil className="size-3.5" />}
					</button>
				)}
			</div>

			{/* Expanded list */}
			{!isCollapsed && (
				<div className="px-2 pb-2">
					<ul ref={ulRef} className="list-none max-h-[300px] overflow-y-auto space-y-0.5">
						{displayTodos.map((todo: any, idx: number) => (
							<li
								key={todo.id || todo.content || idx}
								ref={(el) => (itemRefs.current[idx] = el)}
								className={cn(
									"flex items-start gap-2 py-1 px-1.5 rounded group",
									"transition-colors",
									isEditing && "hover:bg-vscode-list-hoverBackground/40",
								)}>
								{/* Status icon - clickable in edit mode */}
								<button
									className={cn(
										"mt-0.5 shrink-0",
										isEditing
											? "cursor-pointer hover:scale-110 transition-transform"
											: "cursor-default",
									)}
									onClick={() => isEditing && handleStatusCycle(todo.id)}
									tabIndex={isEditing ? 0 : -1}>
									{getStatusIcon(todo.status)}
								</button>

								{/* Content */}
								{isEditing ? (
									<input
										type="text"
										value={todo.content}
										onChange={(e) => handleContentChange(todo.id, e.target.value)}
										onBlur={(e) => handleContentBlur(todo.id, e.target.value)}
										className={cn(
											"flex-1 min-w-0 bg-transparent border-none outline-none",
											"text-[13px] leading-normal font-light",
											"border-b border-vscode-input-border/50 focus:border-vscode-focusBorder",
											"text-vscode-foreground",
										)}
									/>
								) : (
									<span
										className={cn(
											"flex-1 min-w-0 text-[13px] leading-normal font-light",
											todo.status === "completed" &&
												"line-through text-vscode-descriptionForeground",
											todo.status === "in_progress" && "text-vscode-charts-yellow",
											todo.status !== "in_progress" &&
												todo.status !== "completed" &&
												"opacity-70",
										)}>
										{todo.content}
									</span>
								)}

								{/* Delete button in edit mode */}
								{isEditing && (
									<button
										className="shrink-0 mt-0.5 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-vscode-inputValidation-errorBackground/30 transition-all"
										onClick={() => handleDelete(todo.id)}
										title={t("chat:todo.delete")}>
										<Trash2 className="size-3 text-vscode-errorForeground" />
									</button>
								)}
							</li>
						))}
					</ul>

					{/* Add item row */}
					{isEditing && (
						<div className="mt-1 px-1.5">
							{isAdding ? (
								<div className="flex items-center gap-2">
									<Plus className="size-3.5 shrink-0 text-vscode-descriptionForeground" />
									<input
										ref={addInputRef}
										type="text"
										value={addingContent}
										onChange={(e) => setAddingContent(e.target.value)}
										onKeyDown={handleAddKeyDown}
										placeholder={t("chat:todo.addPlaceholder")}
										className={cn(
											"flex-1 min-w-0 bg-transparent border-none outline-none",
											"text-[13px] leading-normal font-light",
											"border-b border-vscode-input-border/50 focus:border-vscode-focusBorder",
											"text-vscode-foreground placeholder:text-vscode-descriptionForeground/50",
										)}
									/>
									<button
										className="text-[11px] px-1.5 py-0.5 rounded bg-vscode-button-background text-vscode-button-foreground hover:bg-vscode-button-hoverBackground"
										onClick={handleAdd}
										disabled={!addingContent.trim()}>
										{t("chat:todo.add")}
									</button>
									<button
										className="text-[11px] px-1.5 py-0.5 rounded bg-vscode-button-secondaryBackground text-vscode-button-secondaryForeground hover:bg-vscode-button-secondaryHoverBackground"
										onClick={() => {
											setIsAdding(false)
											setAddingContent("")
										}}>
										{t("chat:todo.cancel")}
									</button>
								</div>
							) : (
								<button
									className="flex items-center gap-1.5 text-[12px] text-vscode-descriptionForeground hover:text-vscode-foreground transition-colors py-0.5"
									onClick={() => setIsAdding(true)}>
									<Plus className="size-3" />
									{t("chat:todo.addItem")}
								</button>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	)
}
