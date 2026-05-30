import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";

// Mock Tauri Core APIs
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

describe("Skrvm Frontend React App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock scrollIntoView for jsdom since it does not implement layout functions
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("should render the header bar and metric metrics correctly", async () => {
    // Mock initial empty orchestrator state
    const mockState = {
      poll_interval_ms: 10000,
      max_concurrent_agents: 2,
      running: {},
      completed: [],
      claimed: [],
      blocked: {},
      retry_attempts: {},
      codex_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        seconds_running: 0.0,
      },
      last_error: null,
    };

    vi.mocked(invoke).mockResolvedValue(mockState);

    await act(async () => {
      render(<App />);
    });

    // Verify header title
    expect(screen.getByText("Skrvm Orchestrator Console")).toBeInTheDocument();

    // Verify metric cards
    expect(screen.getByText("Active Workers")).toBeInTheDocument();
    expect(screen.getByText("Claims in Queue")).toBeInTheDocument();
    expect(screen.getByText("Blocked Handoffs")).toBeInTheDocument();
    expect(screen.getByText("Total Tokens Consumed")).toBeInTheDocument();
  });

  it("should render the Kanban board with active tickets and handle detail drawer inspection", async () => {
    // Mock state containing running, blocked, retry and completed issues
    const mockState = {
      poll_interval_ms: 10000,
      max_concurrent_agents: 2,
      running: {
        "running-id": {
          pid: 12345,
          identifier: "DEMO-101",
          issue: {
            id: "running-id",
            identifier: "DEMO-101",
            title: "Implement filter badges",
            description: "Mock description for badge features",
            priority: 2,
            state: "In Progress",
            branch_name: "feature/demo-badges",
            url: null,
            assignee_id: "me",
            blocked_by: [],
            labels: [],
            assigned_to_worker: true,
            created_at: null,
            updated_at: null,
          },
          worker_host: "127.0.0.1",
          workspace_path: "/dummy/workspaces/DEMO-101",
          session_id: "test-sess",
          last_event: "turn_completed",
          last_message: "Done turn",
          last_event_at: "2026-05-30T12:00:00Z",
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          turn_count: 5,
          retry_attempt: 0,
          started_at: "2026-05-30T12:00:00Z",
        },
      },
      completed: ["done-id"],
      claimed: ["running-id", "done-id"],
      blocked: {
        "blocked-id": {
          issue_id: "blocked-id",
          identifier: "DEMO-102",
          issue: {
            id: "blocked-id",
            identifier: "DEMO-102",
            title: "Blocked by inputs",
            description: "Awaiting operator key input",
            priority: 3,
            state: "Human Review",
            branch_name: null,
            url: null,
            assignee_id: "me",
            blocked_by: [],
            labels: [],
            assigned_to_worker: true,
            created_at: null,
            updated_at: null,
          },
          session_id: "sess-blocked",
          error: "Operator input required",
          blocked_at: "2026-05-30T12:05:00Z",
        },
      },
      retry_attempts: {
        "retry-id": {
          issue_id: "retry-id",
          identifier: "DEMO-103",
          attempt: 1,
          due_at_ms: 1777777777777,
          error: Some("Timeout"),
        },
      },
      codex_totals: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        seconds_running: 10.0,
      },
      last_error: null,
    };

    vi.mocked(invoke).mockResolvedValue(mockState);

    let renderResult: any;
    await act(async () => {
      renderResult = render(<App />);
    });

    const { container } = renderResult;

    // Verify tickets are rendered inside columns
    expect(screen.getByText("Implement filter badges")).toBeInTheDocument();
    expect(screen.getByText("Blocked by inputs")).toBeInTheDocument();

    // Verify columns count badges
    const counts = container.querySelectorAll(".kanban-column-count");
    expect(counts[0].textContent).toBe("1"); // Todo/Retry column
    expect(counts[1].textContent).toBe("1"); // In Progress
    expect(counts[2].textContent).toBe("1"); // Human Review
    expect(counts[3].textContent).toBe("1"); // Done (completed done-id)

    // Click on active ticket to open Slide-Out Inspector Drawer
    const activeCard = screen.getByText("Implement filter badges");
    await act(async () => {
      fireEvent.click(activeCard);
    });

    // Drawer should open and display inspection headers
    expect(screen.getByText("Issue Inspector")).toBeInTheDocument();
    expect(screen.getByText("feature/demo-badges")).toBeInTheDocument();
    expect(screen.getByText("12345")).toBeInTheDocument(); // PID
    expect(screen.getAllByText("150")[0]).toBeInTheDocument(); // Tokens matching at least one token card
  });

  it("should handle TodoMVC sandbox add, delete, and badge filter count operations cleanly in the drawer", async () => {
    // Mock active state so we have a ticket to select and open drawer
    const mockState = {
      poll_interval_ms: 10000,
      max_concurrent_agents: 2,
      running: {
        "running-id": {
          pid: 12345,
          identifier: "DEMO-101",
          issue: {
            id: "running-id",
            identifier: "DEMO-101",
            title: "Implement filter badges",
            description: "Mock description for badge features",
            priority: 2,
            state: "In Progress",
            branch_name: "feature/demo-badges",
            url: null,
            assignee_id: "me",
            blocked_by: [],
            labels: [],
            assigned_to_worker: true,
            created_at: null,
            updated_at: null,
          },
          worker_host: "127.0.0.1",
          workspace_path: "/dummy/workspaces/DEMO-101",
          session_id: "test-sess",
          last_event: "turn_completed",
          last_message: "Done turn",
          last_event_at: "2026-05-30T12:00:00Z",
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          turn_count: 5,
          retry_attempt: 0,
          started_at: "2026-05-30T12:00:00Z",
        },
      },
      completed: [],
      claimed: ["running-id"],
      blocked: {},
      retry_attempts: {},
      codex_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        seconds_running: 0.0,
      },
      last_error: null,
    };

    vi.mocked(invoke).mockResolvedValue(mockState);

    await act(async () => {
      render(<App />);
    });

    // Select the card to open the drawer
    const card = screen.getByText("Implement filter badges");
    await act(async () => {
      fireEvent.click(card);
    });

    // Verify initial TodoMVC states are now visible in the drawer
    expect(screen.getByText("React • TodoMVC (Sandbox)")).toBeInTheDocument();
    expect(screen.getByText("Milk")).toBeInTheDocument();
    expect(screen.getByText("Apples")).toBeInTheDocument();

    // Add a new todo item
    const input = screen.getByPlaceholderText("What needs to be done?");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Buy Bread" } });
    });

    const form = input.closest("form");
    await act(async () => {
      fireEvent.submit(form!);
    });

    // Bread should now render on screen
    expect(screen.getByText("Buy Bread")).toBeInTheDocument();

    // Check count in filter badge
    expect(screen.getByText("3 items left")).toBeInTheDocument();
  });
});

// Mock type check support helper
function Some(val: string): string {
  return val;
}
