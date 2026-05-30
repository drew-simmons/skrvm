import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./Dashboard.css";

// Interface definitions matching the Rust types
interface BlockerRef {
  id: string;
  identifier: string;
  state: string | null;
}

interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  assignee_id: string | null;
  blocked_by: BlockerRef[];
  labels: string[];
  assigned_to_worker: boolean;
  created_at: string | null;
  updated_at: string | null;
}

interface RunningEntry {
  pid: number | null;
  identifier: string;
  issue: Issue;
  worker_host: string | null;
  workspace_path: string | null;
  session_id: string | null;
  last_event: string | null;
  last_message: string | null;
  last_event_at: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  turn_count: number;
  retry_attempt: number;
  started_at: string;
}

interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  error: string | null;
}

interface BlockedEntry {
  issue_id: string;
  identifier: string;
  issue: Issue;
  session_id: string | null;
  error: string;
  blocked_at: string;
}

interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: { [key: string]: RunningEntry };
  completed: string[];
  claimed: string[];
  blocked: { [key: string]: BlockedEntry };
  retry_attempts: { [key: string]: RetryEntry };
  codex_totals: CodexTotals;
  last_error: string | null;
}

interface AgentUpdateEvent {
  issue_id: string;
  event: string;
  timestamp: string;
  pid: number | null;
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  turn_count: number;
  message: string | null;
}

interface MiniTodo {
  id: number;
  text: string;
  completed: boolean;
}

function App() {
  const [orchState, setOrchState] = useState<OrchestratorState | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [operatorInput, setOperatorInput] = useState<string>("");
  const [isReloading, setIsReloading] = useState<boolean>(false);
  const [reloadMsg, setReloadMsg] = useState<string | null>(null);

  // Local cache of console logs mapped to issue identifier
  const [liveLogs, setLiveLogs] = useState<{ [id: string]: string[] }>({});
  const consoleBottomRef = useRef<HTMLDivElement | null>(null);

  // Local cache of issue metadata (to retrieve completed ticket details)
  const [issueCache, setIssueCache] = useState<{ [id: string]: Issue }>({});

  // Mini-TodoMVC Badge Demonstration State
  const [miniTodos, setMiniTodos] = useState<MiniTodo[]>([
    { id: 1, text: "Milk", completed: false },
    { id: 2, text: "Apples", completed: false },
  ]);
  const [miniTodoInput, setMiniTodoInput] = useState<string>("");
  const [miniTodoFilter, setMiniTodoFilter] = useState<"all" | "active" | "completed">("all");

  // 1. Fetch Orchestrator State
  const fetchState = async () => {
    try {
      const stateSnapshot: OrchestratorState = await invoke("get_orchestrator_state");
      setOrchState(stateSnapshot);

      // Update issue cache with any seen metadata
      if (stateSnapshot) {
        setIssueCache((prev) => {
          const next = { ...prev };
          Object.values(stateSnapshot.running).forEach((entry) => {
            next[entry.issue.id] = entry.issue;
          });
          Object.values(stateSnapshot.blocked).forEach((entry) => {
            next[entry.issue.id] = entry.issue;
          });
          return next;
        });
      }
    } catch (e) {
      console.error("Failed to fetch orchestrator state:", e);
    }
  };

  // 2. Trigger dynamic reload of WORKFLOW.md
  const handleReload = async () => {
    setIsReloading(true);
    setReloadMsg(null);
    try {
      await invoke("reload_workflow");
      setReloadMsg("Workflow reloaded!");
      fetchState();
      setTimeout(() => setReloadMsg(null), 3000);
    } catch (e) {
      setReloadMsg(`Reload failed: ${e}`);
      setTimeout(() => setReloadMsg(null), 5000);
    } finally {
      setIsReloading(false);
    }
  };

  // 3. Resolve a blocked issue using operator input
  const handleResolveBlock = async () => {
    if (!selectedIssueId) return;
    try {
      await invoke("unblock_issue", { issueId: selectedIssueId });
      setSelectedIssueId(null);
      setOperatorInput("");
      fetchState();
    } catch (e) {
      alert(`Unblock failed: ${e}`);
    }
  };

  // 4. Register listeners and timers
  useEffect(() => {
    fetchState();

    // Periodically sync every 1.5 seconds
    const interval = setInterval(fetchState, 1500);

    // Event listener for state refresh triggers from the backend
    let stateUnsubscribe: () => void = () => {};
    listen("orchestrator-state-updated", () => {
      fetchState();
    }).then((unsub) => {
      stateUnsubscribe = unsub;
    });

    // Event listener for live updates from agents
    let updateUnsubscribe: () => void = () => {};
    listen<AgentUpdateEvent>("agent-update", (event) => {
      const update = event.payload;
      if (update.message) {
        setLiveLogs((prev) => {
          const current = prev[update.issue_id] || [];
          const time = new Date(update.timestamp).toLocaleTimeString();
          const newLine = `[${time}] ${update.event.toUpperCase()}: ${update.message}`;
          return {
            ...prev,
            [update.issue_id]: [...current.slice(-49), newLine], // Limit cache to 50 logs
          };
        });
      }
      fetchState();
    }).then((unsub) => {
      updateUnsubscribe = unsub;
    });

    return () => {
      clearInterval(interval);
      stateUnsubscribe();
      updateUnsubscribe();
    };
  }, []);

  // Auto-scroll terminal divs when logs arrive
  useEffect(() => {
    if (selectedIssueId && consoleBottomRef.current) {
      consoleBottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [liveLogs, selectedIssueId]);

  // Mini-TodoMVC handlers
  const handleAddMiniTodo = (e: React.FormEvent) => {
    e.preventDefault();
    if (!miniTodoInput.trim()) return;
    setMiniTodos((prev) => [
      ...prev,
      { id: Date.now(), text: miniTodoInput.trim(), completed: false },
    ]);
    setMiniTodoInput("");
  };

  const handleToggleMiniTodo = (id: number) => {
    setMiniTodos((prev) =>
      prev.map((todo) => (todo.id === id ? { ...todo, completed: !todo.completed } : todo)),
    );
  };

  const handleDeleteMiniTodo = (id: number) => {
    setMiniTodos((prev) => prev.filter((todo) => todo.id !== id));
  };

  // Compile Kanban board columns
  const runningArray = orchState ? Object.values(orchState.running) : [];
  const blockedArray = orchState ? Object.values(orchState.blocked) : [];
  const retryArray = orchState ? Object.values(orchState.retry_attempts) : [];
  const completedIds = orchState ? orchState.completed : [];

  // Group tickets by column
  // Column 1: Todo (Retrying & Claimed but not yet running/blocked)
  const todoColumnTickets = retryArray.map((retry) => {
    const cached = issueCache[retry.issue_id];
    return {
      id: retry.issue_id,
      identifier: retry.identifier,
      title: cached?.title || `Scheduled check (${retry.identifier})`,
      priority: cached?.priority || null,
      state: "Todo",
      type: "retry" as const,
      error: retry.error,
      attempt: retry.attempt,
      due_at_ms: retry.due_at_ms,
      issue: cached || null,
    };
  });

  // Column 2: In Progress (Running entries)
  const inProgressColumnTickets = runningArray.map((entry) => ({
    id: entry.issue.id,
    identifier: entry.identifier,
    title: entry.issue.title,
    priority: entry.issue.priority,
    state: "In Progress",
    type: "running" as const,
    entry,
  }));

  // Column 3: Human Review (Blocked entries)
  const blockedColumnTickets = blockedArray.map((entry) => ({
    id: entry.issue_id,
    identifier: entry.identifier,
    title: entry.issue.title,
    priority: entry.issue.priority,
    state: "Human Review",
    type: "blocked" as const,
    entry,
  }));

  // Column 4: Done (Completed IDs)
  const doneColumnTickets = completedIds.map((id) => {
    const cached = issueCache[id];
    return {
      id,
      identifier: cached?.identifier || `MT-COMP`,
      title: cached?.title || "Agent task completed",
      priority: cached?.priority || null,
      state: "Done",
      type: "completed" as const,
      issue: cached || null,
    };
  });

  // Identify selected ticket details for drawer
  const getSelectedTicketDetails = () => {
    if (!selectedIssueId) return null;

    // Check In Progress
    const running = runningArray.find((r) => r.issue.id === selectedIssueId);
    if (running) return { type: "running" as const, data: running.issue, entry: running };

    // Check Blocked
    const blocked = blockedArray.find((b) => b.issue_id === selectedIssueId);
    if (blocked) return { type: "blocked" as const, data: blocked.issue, entry: blocked };

    // Check Todo / Retries
    const retry = retryArray.find((r) => r.issue_id === selectedIssueId);
    if (retry) {
      const cached = issueCache[retry.issue_id];
      return { type: "retry" as const, data: cached || null, entry: retry };
    }

    // Check Completed
    const completed = completedIds.find((c) => c === selectedIssueId);
    if (completed) {
      const cached = issueCache[completed];
      return { type: "completed" as const, data: cached || null, entry: completed };
    }

    return null;
  };

  const selectedDetails = getSelectedTicketDetails();

  // Generate automated checklist plan items based on current turn count
  const renderPlanChecklist = (turnCount: number, type: string) => {
    const isDone = type === "completed";

    const checklistPhases = [
      {
        title: "1. Inspect existing TodoMVC footer filter implementation",
        steps: [
          { text: "Locate React component rendering filter tabs", activeTurn: 1 },
          { text: "Identify how active/completed counts are computed", activeTurn: 2 },
          { text: "Review shared CSS to understand layout constraints", activeTurn: 3 },
        ],
      },
      {
        title: "2. Extend filter markup to support badges without changing behavior",
        steps: [
          { text: "Add badge rendering for Active", activeTurn: 4 },
          { text: "Add badge rendering for Completed", activeTurn: 5 },
          { text: "Ensure badges render even if count is 0", activeTurn: 6 },
          { text: "Keep All tab unchanged and preserve routing/selection", activeTurn: 7 },
        ],
      },
      {
        title: "3. Add styling for a compact vintage macOS-style badge",
        steps: [
          { text: "Add local CSS overrides rather than changing upstream CSS", activeTurn: 8 },
          { text: "Style badge as a small gray rounded pill with highlight", activeTurn: 9 },
          { text: "Keep spacing tight and visually consistent", activeTurn: 10 },
          { text: "Avoid introducing layout regressions in filter row", activeTurn: 11 },
        ],
      },
      {
        title: "4. Rebuild generated artifacts",
        steps: [
          { text: "Compile the TypeScript sources", activeTurn: 12 },
          { text: "Rebuild the browser bundle so generated files sync", activeTurn: 13 },
        ],
      },
      {
        title: "5. Validate the final behavior",
        steps: [{ text: "Confirm Active and Completed both show numeric badges", activeTurn: 14 }],
      },
    ];

    return (
      <div className="checklist-container">
        {checklistPhases.map((phase, pIdx) => {
          // Check if any step in this phase is active or complete
          const isPhasePending = !isDone && phase.steps.every((s) => turnCount < s.activeTurn);
          return (
            <div key={pIdx} style={{ marginBottom: "0.5rem" }}>
              <div
                className="detail-section-title"
                style={{
                  fontSize: "0.7rem",
                  opacity: isPhasePending ? 0.4 : 1,
                  borderBottom: "none",
                  paddingBottom: 0,
                  marginBottom: "0.2rem",
                }}
              >
                {phase.title}
              </div>

              {phase.steps.map((step, sIdx) => {
                const isStepCompleted = isDone || turnCount > step.activeTurn;
                const isStepInProgress = !isDone && turnCount === step.activeTurn;

                let stepClass = "item-pending";
                if (isStepCompleted) stepClass = "item-checked";
                else if (isStepInProgress) stepClass = "item-active";

                return (
                  <div key={sIdx} className={`checklist-item ${stepClass} checklist-sub-item`}>
                    <div
                      className={`checklist-checkbox ${isStepCompleted ? "checked" : isStepInProgress ? "in-progress" : ""}`}
                    >
                      {isStepCompleted && "✓"}
                    </div>
                    <span className="checklist-text">{step.text}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  // Filter mini todo lists
  const filteredMiniTodos = miniTodos.filter((todo) => {
    if (miniTodoFilter === "active") return !todo.completed;
    if (miniTodoFilter === "completed") return todo.completed;
    return true;
  });

  const miniActiveCount = miniTodos.filter((t) => !t.completed).length;
  const miniCompletedCount = miniTodos.filter((t) => t.completed).length;

  return (
    <div className="app-container">
      {/* Premium Title Header */}
      <header className="header-bar">
        <div className="brand-section">
          <div className="pulse-dot"></div>
          <h1 className="brand-title">Skrvm Orchestrator Console</h1>
        </div>

        <div className="controls-section">
          {reloadMsg && (
            <span className="queue-label" style={{ color: "#00f0ff", fontSize: "0.75rem" }}>
              {reloadMsg}
            </span>
          )}
          <button className="btn-premium" onClick={handleReload} disabled={isReloading}>
            {isReloading ? "Reloading..." : "Reload Config"}
          </button>
        </div>
      </header>

      {/* Metric Cards Row */}
      <section className="metrics-row">
        <div className="metric-card">
          <span className="metric-title">Active Workers</span>
          <span className="metric-value cyan-glow">
            {runningArray.length}{" "}
            <span style={{ fontSize: "1rem", color: "var(--color-text-muted)", fontWeight: 400 }}>
              / {orchState?.max_concurrent_agents || 10}
            </span>
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-title">Claims in Queue</span>
          <span className="metric-value">{orchState?.claimed.length || 0}</span>
        </div>

        <div className="metric-card">
          <span className="metric-title">Blocked Handoffs</span>
          <span className="metric-value" style={{ color: "var(--color-amber)" }}>
            {blockedArray.length}
          </span>
        </div>

        <div className="metric-card">
          <span className="metric-title">Total Tokens Consumed</span>
          <span className="metric-value purple-glow">
            {orchState?.codex_totals.total_tokens.toLocaleString() || 0}
          </span>
        </div>
      </section>

      {/* Kanban Board Area */}
      <section className="kanban-board-container">
        <div className="kanban-board">
          {/* Column 1: Todo */}
          <div className="kanban-column">
            <div className="kanban-column-header">
              <span className="kanban-column-title" style={{ color: "var(--color-zinc-400)" }}>
                ● Backlog / Todo
              </span>
              <span className="kanban-column-count">{todoColumnTickets.length}</span>
            </div>
            <div className="kanban-column-body">
              {todoColumnTickets.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-state-subtitle">No items in backlog</span>
                </div>
              ) : (
                todoColumnTickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    className={`kanban-card card-todo ${selectedIssueId === ticket.id ? "selected" : ""}`}
                    onClick={() => setSelectedIssueId(ticket.id)}
                  >
                    <div className="card-header">
                      <div className="card-identity">
                        <span className="issue-tag">{ticket.identifier}</span>
                      </div>
                      {ticket.priority && <span className="card-priority">{ticket.priority}</span>}
                    </div>
                    <span className="card-title">{ticket.title}</span>
                    <div className="card-footer">
                      <div className="card-meta-left">
                        <div className="status-dot retrying"></div>
                        <span>Attempt #{ticket.attempt}</span>
                      </div>
                      <span style={{ color: "var(--color-purple)", fontFamily: "monospace" }}>
                        Retrying
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Column 2: In Progress */}
          <div className="kanban-column">
            <div className="kanban-column-header">
              <span className="kanban-column-title" style={{ color: "var(--color-primary)" }}>
                ● In Progress
              </span>
              <span className="kanban-column-count">{inProgressColumnTickets.length}</span>
            </div>
            <div className="kanban-column-body">
              {inProgressColumnTickets.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-state-subtitle">Idle. Awaiting candidate tickets...</span>
                </div>
              ) : (
                inProgressColumnTickets.map((ticket) => {
                  const turnProgress = Math.min(
                    100,
                    Math.ceil((ticket.entry.turn_count / 20) * 100),
                  );
                  return (
                    <div
                      key={ticket.id}
                      className={`kanban-card card-in-progress ${selectedIssueId === ticket.id ? "selected" : ""}`}
                      onClick={() => setSelectedIssueId(ticket.id)}
                    >
                      <div className="card-header">
                        <div className="card-identity">
                          <span className="issue-tag">{ticket.identifier}</span>
                        </div>
                        {ticket.priority && (
                          <span className="card-priority">{ticket.priority}</span>
                        )}
                      </div>
                      <span className="card-title">{ticket.title}</span>
                      <div className="card-footer">
                        <div className="card-meta-left">
                          <div className="status-dot running"></div>
                          <span>Turn {ticket.entry.turn_count}</span>
                        </div>
                        <div className="progress-bar-bg" title={`${turnProgress}% turns completed`}>
                          <div
                            className="progress-bar-fill"
                            style={{ width: `${turnProgress}%` }}
                          ></div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Column 3: Human Review */}
          <div className="kanban-column">
            <div className="kanban-column-header">
              <span className="kanban-column-title" style={{ color: "var(--color-amber)" }}>
                ● Human Review
              </span>
              <span className="kanban-column-count">{blockedColumnTickets.length}</span>
            </div>
            <div className="kanban-column-body">
              {blockedColumnTickets.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-state-subtitle">No blocked worker sessions</span>
                </div>
              ) : (
                blockedColumnTickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    className={`kanban-card card-blocked ${selectedIssueId === ticket.id ? "selected" : ""}`}
                    onClick={() => setSelectedIssueId(ticket.id)}
                  >
                    <div className="card-header">
                      <div className="card-identity">
                        <span className="issue-tag">{ticket.identifier}</span>
                      </div>
                      {ticket.priority && <span className="card-priority">{ticket.priority}</span>}
                    </div>
                    <span className="card-title">{ticket.title}</span>
                    <div className="card-footer">
                      <div className="card-meta-left">
                        <div className="status-dot blocked"></div>
                        <span style={{ color: "var(--color-amber)", fontWeight: 500 }}>
                          Action Required
                        </span>
                      </div>
                      <span className="macos-badge">Handoff</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Column 4: Done */}
          <div className="kanban-column">
            <div className="kanban-column-header">
              <span className="kanban-column-title" style={{ color: "var(--color-emerald)" }}>
                ● Done
              </span>
              <span className="kanban-column-count">{doneColumnTickets.length}</span>
            </div>
            <div className="kanban-column-body">
              {doneColumnTickets.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-state-subtitle">No completed tickets</span>
                </div>
              ) : (
                doneColumnTickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    className={`kanban-card card-done ${selectedIssueId === ticket.id ? "selected" : ""}`}
                    onClick={() => setSelectedIssueId(ticket.id)}
                  >
                    <div className="card-header">
                      <div className="card-identity">
                        <span className="issue-tag">{ticket.identifier}</span>
                      </div>
                      {ticket.priority && <span className="card-priority">{ticket.priority}</span>}
                    </div>
                    <span className="card-title">{ticket.title}</span>
                    <div className="card-footer">
                      <div className="card-meta-left">
                        <div
                          className="status-dot"
                          style={{ backgroundColor: "var(--color-emerald)" }}
                        ></div>
                        <span style={{ color: "var(--color-emerald)" }}>Completed</span>
                      </div>
                      <span
                        className="macos-badge"
                        style={{
                          backgroundImage: "linear-gradient(180deg, #34c759 0%, #248a3d 100%)",
                          borderColor: "#1e6d30",
                        }}
                      >
                        Merged
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Slide-out sheet Details Panel Drawer Backdrop */}
      <div
        className={`drawer-backdrop ${selectedIssueId ? "open" : ""}`}
        onClick={() => setSelectedIssueId(null)}
      />

      {/* Slide-out sheet Details Panel Drawer Content */}
      <div className={`drawer-content ${selectedIssueId ? "open" : ""}`}>
        {selectedDetails ? (
          <>
            <div className="drawer-header">
              <div className="drawer-header-left">
                <div className="drawer-title-area">
                  <span className="drawer-title">
                    <span
                      className="issue-tag"
                      style={{
                        background: "rgba(255, 255, 255, 0.05)",
                        border: "1px solid rgba(255, 255, 255, 0.1)",
                      }}
                    >
                      {selectedDetails.data?.identifier || "MT-COMP"}
                    </span>
                    <span style={{ fontSize: "0.85rem", opacity: 0.8 }}>Issue Inspector</span>
                  </span>
                </div>
              </div>
              <button className="btn-close" onClick={() => setSelectedIssueId(null)}>
                &times;
              </button>
            </div>

            <div className="drawer-body">
              {/* Title & Description */}
              <div>
                <h2
                  style={{
                    fontSize: "1rem",
                    fontWeight: 600,
                    marginBottom: "0.4rem",
                    color: "var(--color-text-main)",
                    lineHeight: 1.3,
                  }}
                >
                  {selectedDetails.data?.title || "Agent task session details"}
                </h2>
                {selectedDetails.data?.description && (
                  <p className="ticket-description">{selectedDetails.data.description}</p>
                )}
              </div>

              {/* Worker Session Metadata Grid */}
              <div>
                <div className="detail-section-title">Session Parameters</div>
                <div className="meta-grid">
                  <div className="meta-item">
                    <span className="meta-label">Worker Assignment</span>
                    <span className="meta-value" style={{ color: "var(--color-primary)" }}>
                      frantic (AI Worker)
                    </span>
                  </div>

                  <div className="meta-item">
                    <span className="meta-label">Worker Host IP</span>
                    <span className="meta-value">
                      {selectedDetails.type === "running"
                        ? (selectedDetails.entry as RunningEntry).worker_host || "127.0.0.1"
                        : "127.0.0.1"}
                    </span>
                  </div>

                  <div className="meta-item">
                    <span className="meta-label">Active PID</span>
                    <span className="meta-value">
                      {selectedDetails.type === "running"
                        ? (selectedDetails.entry as RunningEntry).pid || "Initializing"
                        : "Exited"}
                    </span>
                  </div>

                  <div className="meta-item">
                    <span className="meta-label">Current State</span>
                    <span
                      className="meta-value"
                      style={{
                        color:
                          selectedDetails.type === "blocked"
                            ? "var(--color-amber)"
                            : selectedDetails.type === "completed"
                              ? "var(--color-emerald)"
                              : "var(--color-primary)",
                      }}
                    >
                      {selectedDetails.type.toUpperCase()}
                    </span>
                  </div>

                  <div className="meta-item">
                    <span className="meta-label">Tokens Consumed</span>
                    <span className="meta-value" style={{ color: "var(--color-purple)" }}>
                      {selectedDetails.type === "running"
                        ? (selectedDetails.entry as RunningEntry).total_tokens.toLocaleString()
                        : "0"}
                    </span>
                  </div>

                  <div className="meta-item">
                    <span className="meta-label">Branch Resource</span>
                    <span className="meta-value" style={{ color: "var(--color-zinc-400)" }}>
                      {selectedDetails.data?.branch_name || "main"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Execution plan generated by Agent */}
              <div>
                <div className="detail-section-title">Automated Checklist Plan</div>
                {renderPlanChecklist(
                  selectedDetails.type === "running"
                    ? (selectedDetails.entry as RunningEntry).turn_count
                    : selectedDetails.type === "completed"
                      ? 20
                      : 0,
                  selectedDetails.type,
                )}
              </div>

              {/* Vintage macOS Badge Interactive Widget Demo */}
              <div>
                <div className="detail-section-title">Vintage macOS Badge Sandbox</div>
                <div
                  style={{
                    marginBottom: "0.4rem",
                    fontSize: "0.72rem",
                    color: "var(--color-text-muted)",
                  }}
                >
                  Interact with the mini TodoMVC app to test active and completed numeric bucket
                  badges.
                </div>
                <div className="mini-todomvc">
                  <div className="mini-todo-header">React • TodoMVC (Sandbox)</div>

                  <form onSubmit={handleAddMiniTodo} className="mini-todo-input-form">
                    <input
                      type="text"
                      className="mini-todo-input"
                      placeholder="What needs to be done?"
                      value={miniTodoInput}
                      onChange={(e) => setMiniTodoInput(e.target.value)}
                    />
                  </form>

                  <div className="mini-todo-list">
                    {filteredMiniTodos.length === 0 ? (
                      <div
                        style={{
                          textAlign: "center",
                          padding: "1rem",
                          color: "#9c9c9c",
                          fontSize: "0.72rem",
                        }}
                      >
                        No items in bucket
                      </div>
                    ) : (
                      filteredMiniTodos.map((todo) => (
                        <div key={todo.id} className="mini-todo-item">
                          <div className="mini-todo-item-left">
                            <div
                              className={`mini-todo-toggle ${todo.completed ? "completed" : ""}`}
                              onClick={() => handleToggleMiniTodo(todo.id)}
                            />
                            <span className={`mini-todo-text ${todo.completed ? "completed" : ""}`}>
                              {todo.text}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="mini-todo-delete"
                            onClick={() => handleDeleteMiniTodo(todo.id)}
                          >
                            ✖
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="mini-todo-footer">
                    <span>{miniActiveCount} items left</span>

                    <div className="mini-todo-tabs">
                      <div
                        className={`mini-todo-tab ${miniTodoFilter === "all" ? "selected" : ""}`}
                        onClick={() => setMiniTodoFilter("all")}
                      >
                        All
                      </div>
                      <div
                        className={`mini-todo-tab ${miniTodoFilter === "active" ? "selected" : ""}`}
                        onClick={() => setMiniTodoFilter("active")}
                      >
                        Active <span className="macos-badge">{miniActiveCount}</span>
                      </div>
                      <div
                        className={`mini-todo-tab ${miniTodoFilter === "completed" ? "selected" : ""}`}
                        onClick={() => setMiniTodoFilter("completed")}
                      >
                        Completed <span className="macos-badge">{miniCompletedCount}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Human Action Center for Blocked Handoff */}
              {selectedDetails.type === "blocked" && (
                <div className="handoff-panel">
                  <div
                    className="detail-section-title"
                    style={{ color: "var(--color-amber)", borderBottom: "none", marginBottom: 0 }}
                  >
                    Skrvm Operator Handoff
                  </div>

                  <span className="handoff-reason">
                    <strong>Blocker:</strong> {(selectedDetails.entry as BlockedEntry).error}
                  </span>

                  <textarea
                    className="handoff-input"
                    rows={3}
                    placeholder="Provide manual instructions to resolve this blocker..."
                    value={operatorInput}
                    onChange={(e) => setOperatorInput(e.target.value)}
                  />

                  <button
                    className="btn-premium"
                    style={{
                      background: "var(--color-amber)",
                      borderColor: "var(--color-amber)",
                      color: "var(--bg-primary)",
                      width: "100%",
                      fontWeight: 600,
                    }}
                    onClick={handleResolveBlock}
                  >
                    Resolve and Resume
                  </button>
                </div>
              )}

              {/* Streaming Live Console Logs */}
              <div>
                <div className="detail-section-title">Live Execution Logs</div>
                <div className="console-panel">
                  <div className="console-header">
                    <span>Terminal Stream</span>
                    <span>stdout</span>
                  </div>
                  <div className="console-body">
                    {(
                      liveLogs[selectedIssueId || ""] || [
                        "Console connected. Awaiting stream updates...",
                      ]
                    ).map((log: string, index: number) => (
                      <div key={index} className="console-row">
                        <span className="console-prompt">&gt;</span>
                        <span>{log}</span>
                      </div>
                    ))}
                    <div ref={consoleBottomRef}></div>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state" style={{ height: "100%", justifyContent: "center" }}>
            <span>Select a ticket on the board to inspect</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
