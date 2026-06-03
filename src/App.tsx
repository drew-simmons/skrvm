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
  backlog: Issue[];
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

  // Setup Wizard State
  const [isSetupOpen, setIsSetupOpen] = useState<boolean>(false);
  const [isSavingWorkflow, setIsSavingWorkflow] = useState<boolean>(false);

  // Guided wizard navigation (1: Profile, 2: Tracker, 3: Agent, 4: Workspace, 5: Review)
  const [wizardStep, setWizardStep] = useState<number>(1);
  const [teamProfile, setTeamProfile] = useState<"solo" | "small" | "large">("small");

  // Setup Wizard Form & Auto-Detect States
  const [projectDir, setProjectDir] = useState<string>("");
  const [presetSelection, setPresetSelection] = useState<string>("local_git");
  const [showCustomHooks, setShowCustomHooks] = useState<boolean>(false);
  const [detectedGitInfo, setDetectedGitInfo] = useState<{
    project_dir: string;
    project_slug: string | null;
    detected_tracker: string | null;
  } | null>(null);

  const applyDetectedGitSettings = () => {
    if (detectedGitInfo) {
      if (detectedGitInfo.project_dir) {
        setProjectDir(detectedGitInfo.project_dir);
      }
      if (detectedGitInfo.project_slug) {
        setTrackerProjectSlug(detectedGitInfo.project_slug);
      }
      if (detectedGitInfo.detected_tracker) {
        setTrackerKind(detectedGitInfo.detected_tracker);
      }
    }
  };

  // Verification states per step
  const [step1Verified, setStep1Verified] = useState<boolean>(false);
  const [step1Loading, setStep1Loading] = useState<boolean>(false);
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [step1SuccessMsg, setStep1SuccessMsg] = useState<string | null>(null);

  const [step2Verified, setStep2Verified] = useState<boolean>(false);
  const [step2Loading, setStep2Loading] = useState<boolean>(false);
  const [step2Error, setStep2Error] = useState<string | null>(null);
  const [step2SuccessMsg, setStep2SuccessMsg] = useState<string | null>(null);

  const [step3Verified, setStep3Verified] = useState<boolean>(false);
  const [step3Loading, setStep3Loading] = useState<boolean>(false);
  const [step3Error, setStep3Error] = useState<string | null>(null);
  const [step3SuccessMsg, setStep3SuccessMsg] = useState<string | null>(null);

  const [step4Verified, setStep4Verified] = useState<boolean>(false);
  const [step4Loading, setStep4Loading] = useState<boolean>(false);
  const [step4Error, setStep4Error] = useState<string | null>(null);
  const [step4SuccessMsg, setStep4SuccessMsg] = useState<string | null>(null);

  // Form states
  const [trackerKind, setTrackerKind] = useState<string>("github");
  const [trackerEndpoint, setTrackerEndpoint] = useState<string>("https://api.github.com");
  const [trackerApiKey, setTrackerApiKey] = useState<string>("$GITHUB_TOKEN");
  const [trackerProjectSlug, setTrackerProjectSlug] = useState<string>("");
  const [trackerAssignee, setTrackerAssignee] = useState<string>("$GITHUB_ASSIGNEE");
  const [trackerActiveStates, setTrackerActiveStates] = useState<string>("Todo, In Progress");
  const [trackerTerminalStates, setTrackerTerminalStates] = useState<string>("Closed, Done");
  // Opt-in worker label gate (comma separated). Empty = pick up every assigned issue.
  const [trackerRequiredLabels, setTrackerRequiredLabels] = useState<string>("");

  const [pollingInterval, setPollingInterval] = useState<number>(30000);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>("~/dev/scratch/skrvm/workspaces");

  const [agentMaxConcurrent, setAgentMaxConcurrent] = useState<number>(3);
  const [agentMaxTurns, setAgentMaxTurns] = useState<number>(20);
  const [agentMaxRetryBackoff, setAgentMaxRetryBackoff] = useState<number>(300000);

  const [agentSelection, setAgentSelection] = useState<"codex" | "kiro" | "antigravity" | "custom">(
    "codex",
  );
  const [agentCommand, setAgentCommand] = useState<string>("codex app-server");
  const [agentProtocol, setAgentProtocol] = useState<string>("jsonrpc");
  const [agentThreadSandbox, setAgentThreadSandbox] = useState<string>("workspace-write");
  const [agentTurnTimeout, setAgentTurnTimeout] = useState<number>(3600000);

  const [hooksAfterCreate, setHooksAfterCreate] = useState<string>(
    "git clone git@github.com:{{ project_slug }}.git . && git checkout -b skrvm-{{ issue.identifier }}",
  );
  const [hooksBeforeRun, setHooksBeforeRun] = useState<string>("");
  const [hooksAfterRun, setHooksAfterRun] = useState<string>(
    "git add . && git commit -m 'skrvm: turn progression progress' --allow-empty && git push -u origin HEAD:skrvm-{{ issue.identifier }}",
  );
  const [hooksBeforeRemove, setHooksBeforeRemove] = useState<string>("");
  const [hooksTimeout, setHooksTimeout] = useState<number>(120000);

  const [promptTemplate, setPromptTemplate] =
    useState<string>(`You are an elite agentic coding assistant spawned by the Skrvm
orchestrator to resolve issue **{{ issue.identifier }}**.

{% if attempt > 0 %}

### Continuation Context

- **Retry Attempt**: #{{ attempt }} (the ticket remains in an active state).
- **Strategy**: Resume directly from the current workspace state instead of
  restarting investigation.
- **Efficiency**: Avoid repeating already completed planning, implementation, or
  verification unless directly affected by new modifications.
- **Handoff**: Do not end the turn prematurely unless a hard external blocker
  (missing credentials or tooling) exists.

{% endif %}

### Task Overview

- **Title**: {{ issue.title }}
- **Status**: {{ issue.state }}

#### Description

\`\`\`markdown
{{ issue.description }}
\`\`\`

### Default Posture & Execution Guidelines

- **Reproduce First**: Always replicate the issue, bug signal, or target
  behavior before writing any code changes. Make sure your fix target is
  completely explicit and verified first.
- **Surgical Boundaries**: Touch only what is strictly necessary to solve the
  issue. If you discover dead code, unrelated formatting issues, or major
  refactoring opportunities, do not modify them. Instead, log them in your final
  report or file a separate follow-up ticket.
- **Persistent Skrvm Workpad**:
  - Treat a single persistent comment in the issue tracker (starting with the
    header \`## Skrvm Workpad\`) as the source of truth for the task's state.
  - If a Workpad comment does not exist yet, create one. If it does exist,
    update it at the start and end of every turn. Do not post separate progress
    or "done" comments.
  - Use the Workpad to track your current checklist, verification steps, and any
    obstacles.

### Technical Guidelines

1. Analyze the sandbox workspace directory.
2. Code your solutions cleanly, respecting existing code styles.
3. Validate and verify your changes before completing your turn.
4. Update the persistent tracker Workpad comment to document completed items and
  test results.
5. Once all verification checks pass and the issue is resolved, conclude the
  turn.`); // Background effect to auto-detect Git & Agent commands on mount
  useEffect(() => {
    if (!isSetupOpen) return;

    const detectAll = async () => {
      // 1. Auto-detect Git Info
      try {
        const gitInfo: any = await invoke("detect_local_git_info");
        if (gitInfo) {
          setDetectedGitInfo({
            project_dir: gitInfo.project_dir,
            project_slug: gitInfo.project_slug || null,
            detected_tracker: gitInfo.detected_tracker || null,
          });
          if (!projectDir && gitInfo.project_dir) {
            setProjectDir(gitInfo.project_dir);
          }
          if (gitInfo.project_slug) {
            setTrackerProjectSlug((prev) => prev || gitInfo.project_slug || "");
          }
          if (gitInfo.detected_tracker) {
            setTrackerKind((prev) => prev || gitInfo.detected_tracker || "github");
          }
        }
      } catch (e) {
        console.warn("Failed to auto-detect Git/project info:", e);
      }

      // 2. Auto-detect installed agents in PATH
      const agentsList = [
        { key: "codex", cmd: "codex app-server" },
        { key: "kiro", cmd: "kiro-cli acp" },
        { key: "antigravity", cmd: "agy --print -" },
      ];

      let firstAvailableSelection: "codex" | "kiro" | "antigravity" | null = null;

      for (const agent of agentsList) {
        try {
          await invoke("verify_agent_command", { command: agent.cmd });
          if (!firstAvailableSelection) {
            firstAvailableSelection = agent.key as any;
          }
        } catch {
          // not in path
        }
      }

      // If current agentCommand is empty or custom, and we found an available agent, set it
      if (!agentCommand && firstAvailableSelection) {
        if (firstAvailableSelection === "codex") {
          setAgentSelection("codex");
          setAgentCommand("codex app-server");
          setAgentProtocol("jsonrpc");
        } else if (firstAvailableSelection === "kiro") {
          setAgentSelection("kiro");
          setAgentCommand("kiro-cli acp");
          setAgentProtocol("jsonrpc");
        } else if (firstAvailableSelection === "antigravity") {
          setAgentSelection("antigravity");
          setAgentCommand("agy --print -");
          setAgentProtocol("oneshot");
        }
      }
    };

    detectAll();
  }, [isSetupOpen]);

  // Step 1: Workspace setup verification
  useEffect(() => {
    if (!isSetupOpen) return;
    if (!projectDir && !workspaceRoot) return;

    setStep1Loading(true);
    setStep1Error(null);
    setStep1SuccessMsg(null);

    const timer = setTimeout(async () => {
      try {
        await invoke("verify_workspace_setup", { projectDir, workspaceRoot });
        setStep1Verified(true);
        setStep1SuccessMsg("Workspace setup verified successfully!");
      } catch (err: any) {
        setStep1Verified(false);
        setStep1Error(String(err));
      } finally {
        setStep1Loading(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [projectDir, workspaceRoot, isSetupOpen]);

  // Step 2: Tracker connection verification
  useEffect(() => {
    if (!isSetupOpen) return;
    if (!projectDir) {
      setStep2Verified(false);
      setStep2Error("Project Directory is required to test connection.");
      return;
    }

    setStep2Loading(true);
    setStep2Error(null);
    setStep2SuccessMsg(null);

    const activeStatesList = trackerActiveStates
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const terminalStatesList = trackerTerminalStates
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const trackerPayload = {
      kind: trackerKind,
      endpoint: trackerEndpoint,
      api_key: trackerApiKey ? trackerApiKey : null,
      project_slug: trackerProjectSlug,
      assignee: trackerAssignee ? trackerAssignee : null,
      active_states: activeStatesList,
      terminal_states: terminalStatesList,
      required_labels: trackerRequiredLabels
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };

    const timer = setTimeout(async () => {
      try {
        const issueCount = await invoke<number>("test_tracker_connection", {
          tracker: trackerPayload,
          projectDir,
        });
        setStep2Verified(true);
        setStep2SuccessMsg(`Connection successful! Found ${issueCount} candidate issues.`);
      } catch (err: any) {
        setStep2Verified(false);
        setStep2Error(String(err));
      } finally {
        setStep2Loading(false);
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [
    trackerKind,
    trackerEndpoint,
    trackerApiKey,
    trackerProjectSlug,
    trackerAssignee,
    trackerActiveStates,
    trackerTerminalStates,
    trackerRequiredLabels,
    projectDir,
    isSetupOpen,
  ]);

  // Step 3: Coding agent command verification
  useEffect(() => {
    if (!isSetupOpen) return;
    if (!agentCommand) {
      setStep3Verified(false);
      setStep3Error("Agent command cannot be empty.");
      return;
    }

    setStep3Loading(true);
    setStep3Error(null);
    setStep3SuccessMsg(null);

    const timer = setTimeout(async () => {
      try {
        await invoke("verify_agent_command", { command: agentCommand });
        setStep3Verified(true);
        setStep3SuccessMsg("Coding agent verified. Executable is present in system PATH.");
      } catch (err: any) {
        setStep3Verified(false);
        setStep3Error(String(err));
      } finally {
        setStep3Loading(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [agentCommand, isSetupOpen]);

  // Step 4: Prompt template jinja validation
  useEffect(() => {
    if (!isSetupOpen) return;

    setStep4Loading(true);
    setStep4Error(null);
    setStep4SuccessMsg(null);

    const timer = setTimeout(async () => {
      try {
        await invoke("verify_prompt_template", { template: promptTemplate });
        setStep4Verified(true);
        setStep4SuccessMsg("Prompt template MiniJinja syntax is valid.");
      } catch (err: any) {
        setStep4Verified(false);
        setStep4Error(String(err));
      } finally {
        setStep4Loading(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [promptTemplate, isSetupOpen]);

  // Auto-populate defaults when tracker kind changes
  const handleTrackerKindChange = (kind: string) => {
    setTrackerKind(kind);
    if (kind === "github") {
      setTrackerEndpoint("https://api.github.com");
      setTrackerApiKey("$GITHUB_TOKEN");
      setTrackerActiveStates("Todo, In Progress");
      setTrackerTerminalStates("Closed, Done");
    } else if (kind === "gitlab") {
      setTrackerEndpoint("https://gitlab.com");
      setTrackerApiKey("$GITLAB_TOKEN");
      setTrackerActiveStates("opened");
      setTrackerTerminalStates("closed");
    } else if (kind === "jira") {
      setTrackerEndpoint("https://your-domain.atlassian.net");
      setTrackerApiKey("$JIRA_API_KEY");
      setTrackerActiveStates("Todo, In Progress");
      setTrackerTerminalStates("Closed, Done");
    } else if (kind === "linear") {
      setTrackerEndpoint("https://api.linear.app/v1/graphql");
      setTrackerApiKey("$LINEAR_API_KEY");
      setTrackerActiveStates("Todo, In Progress");
      setTrackerTerminalStates("Done, Cancelled");
    } else if (kind === "memory") {
      setTrackerEndpoint("");
      setTrackerApiKey("");
      setTrackerActiveStates("Todo, In Progress");
      setTrackerTerminalStates("Done");
    }
  };

  // Auto-populate defaults when agent selection changes
  const handleAgentSelectionChange = (selection: "codex" | "kiro" | "antigravity" | "custom") => {
    setAgentSelection(selection);
    if (selection === "codex") {
      setAgentCommand("codex app-server");
      setAgentProtocol("jsonrpc");
    } else if (selection === "kiro") {
      setAgentCommand("kiro-cli acp");
      setAgentProtocol("jsonrpc");
    } else if (selection === "antigravity") {
      setAgentCommand("agy --print -");
      setAgentProtocol("oneshot");
    }
  };

  // Auto-populate hooks when lifecycle preset changes
  const applyPreset = (preset: string) => {
    setPresetSelection(preset);
    if (preset === "local_git") {
      setHooksAfterCreate(
        "git clone {{ project_dir }} . && git checkout -b {{ issue.branch_name }} || (git clone {{ project_dir }} . && git checkout {{ issue.branch_name }})",
      );
      setHooksBeforeRun("");
      setHooksAfterRun(
        "git add . && git commit -m 'chore(skrvm): turn progression progress' --allow-empty && git push -u origin HEAD:{{ issue.branch_name }}",
      );
    } else if (preset === "github_remote") {
      setHooksAfterCreate(
        "git clone git@github.com:{{ project_slug }}.git . && git checkout -b {{ issue.branch_name }}",
      );
      setHooksBeforeRun("");
      setHooksAfterRun(
        "git add . && git commit -m 'chore(skrvm): turn progression progress' --allow-empty && git push -u origin HEAD:{{ issue.branch_name }} && gh pr create --title '{{ issue.title }}' --body 'Automated changes by Skrvm.' --head '{{ issue.branch_name }}' || true",
      );
    } else if (preset === "gitlab_remote") {
      setHooksAfterCreate(
        "git clone git@gitlab.com:{{ project_slug }}.git . && git checkout -b {{ issue.branch_name }}",
      );
      setHooksBeforeRun("");
      setHooksAfterRun(
        "git add . && git commit -m 'chore(skrvm): turn progression progress' --allow-empty && git push -u origin HEAD:{{ issue.branch_name }} && glab mr create --title '{{ issue.title }}' --description 'Automated changes by Skrvm.' --source-branch '{{ issue.branch_name }}' || true",
      );
    } else if (preset === "local_copy") {
      setHooksAfterCreate(
        "rsync -av --exclude='.git' --exclude='node_modules' {{ project_dir }}/ .",
      );
      setHooksBeforeRun("");
      setHooksAfterRun("");
    }
  };

  // Remote presets clone over SSH from a tracker slug; local presets work from a
  // local checkout, so the Workspace step swaps which directory input it shows.
  const presetIsRemote = presetSelection === "github_remote" || presetSelection === "gitlab_remote";

  // Team-size profile drives concurrency, polling cadence and scoping defaults so
  // solo users get a simple single-worker setup while large orgs run many workers
  // and gate work behind an opt-in label to avoid claiming human-owned tickets.
  const applyTeamProfile = (profile: "solo" | "small" | "large") => {
    setTeamProfile(profile);
    if (profile === "solo") {
      setAgentMaxConcurrent(1);
      setPollingInterval(30000);
      setTrackerRequiredLabels("");
    } else if (profile === "small") {
      setAgentMaxConcurrent(3);
      setPollingInterval(30000);
      setTrackerRequiredLabels("");
    } else if (profile === "large") {
      setAgentMaxConcurrent(8);
      setPollingInterval(15000);
      // Recommend an opt-in label gate on large shared trackers.
      setTrackerRequiredLabels((prev) => prev || "skrvm");
    }
  };

  // Tab switching state
  const [activeTab, setActiveTab] = useState<"kanban" | "history">("kanban");

  // SDD states
  interface SddTask {
    id: string;
    text: string;
    status: "todo" | "in_progress" | "completed";
    dependencies: string[];
  }

  interface Scorecard {
    passed: boolean;
    score: number;
    feedback: string;
  }

  interface SddState {
    current_stage: "triage" | "requirements" | "design" | "tasks" | "execution" | "done";
    is_sdd: boolean;
    drafts: Record<string, string>;
    reviews: Record<string, Scorecard>;
    approvals: Record<string, boolean>;
    tasks: SddTask[];
  }

  const [sddState, setSddState] = useState<SddState | null>(null);
  const [activeSddTab, setActiveSddTab] = useState<
    "triage" | "requirements" | "design" | "tasks" | "execution"
  >("triage");
  const [editingDraftText, setEditingDraftText] = useState<string>("");

  const fetchSddState = async (issueId: string) => {
    if (!orchState) return;

    let wsPath: string | null = null;
    const running = Object.values(orchState.running).find((r) => r.issue.id === issueId);
    if (running && running.workspace_path) {
      wsPath = running.workspace_path;
    } else {
      const cached = issueCache[issueId];
      if (cached) {
        const sanitizedKey =
          `${cached.identifier.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${cached.title.toLowerCase().replace(/[^a-z0-9]/g, "-")}`.slice(
            0,
            50,
          );
        const workflow = await invoke<any>("get_current_workflow");
        if (workflow && workflow.settings && workflow.settings.workspace) {
          const root = workflow.settings.workspace.root;
          wsPath = `${root}/${sanitizedKey}`;
        }
      }
    }

    if (!wsPath) return;

    try {
      const state: SddState | null = await invoke("get_sdd_state", { workspacePath: wsPath });
      setSddState(state);
    } catch (e) {
      console.error("Failed to fetch SDD state:", e);
    }
  };

  const handleTriggerSddStep = async (stepName: string) => {
    if (!selectedIssueId || !orchState) return;

    let wsPath: string | null = null;
    const running = Object.values(orchState.running).find((r) => r.issue.id === selectedIssueId);
    if (running && running.workspace_path) {
      wsPath = running.workspace_path;
    } else {
      const cached = issueCache[selectedIssueId];
      if (cached) {
        const sanitizedKey =
          `${cached.identifier.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${cached.title.toLowerCase().replace(/[^a-z0-9]/g, "-")}`.slice(
            0,
            50,
          );
        const workflow = await invoke<any>("get_current_workflow");
        if (workflow && workflow.settings && workflow.settings.workspace) {
          const root = workflow.settings.workspace.root;
          wsPath = `${root}/${sanitizedKey}`;
        }
      }
    }

    if (!wsPath) {
      alert("Could not determine workspace path for this issue.");
      return;
    }

    const cached = issueCache[selectedIssueId];
    const issueTitle = cached?.title || "Issue";
    const issueDescription = cached?.description || "Description";

    try {
      const state: SddState = await invoke("trigger_sdd_step", {
        workspacePath: wsPath,
        stepName,
        issueTitle,
        issueDescription,
      });
      setSddState(state);
      if (stepName === "triage") {
        setActiveSddTab("triage");
      } else if (stepName === "requirements") {
        setActiveSddTab("requirements");
        setEditingDraftText(state.drafts["requirements"] || "");
      } else if (stepName === "design") {
        setActiveSddTab("design");
        setEditingDraftText(state.drafts["design"] || "");
      } else if (stepName === "tasks") {
        setActiveSddTab("tasks");
        setEditingDraftText(state.drafts["tasks"] || "");
      } else if (stepName === "execute") {
        setActiveSddTab("execution");
      }
      fetchState();
    } catch (e) {
      alert(`Failed to trigger SDD step: ${e}`);
    }
  };

  const handleSaveSddDraft = async (stage: string, content: string) => {
    if (!selectedIssueId || !sddState || !orchState) return;

    let wsPath: string | null = null;
    const running = Object.values(orchState.running).find((r) => r.issue.id === selectedIssueId);
    if (running && running.workspace_path) {
      wsPath = running.workspace_path;
    } else {
      const cached = issueCache[selectedIssueId];
      if (cached) {
        const sanitizedKey =
          `${cached.identifier.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${cached.title.toLowerCase().replace(/[^a-z0-9]/g, "-")}`.slice(
            0,
            50,
          );
        const workflow = await invoke<any>("get_current_workflow");
        if (workflow && workflow.settings && workflow.settings.workspace) {
          const root = workflow.settings.workspace.root;
          wsPath = `${root}/${sanitizedKey}`;
        }
      }
    }

    if (!wsPath) return;

    const newState = {
      ...sddState,
      drafts: {
        ...sddState.drafts,
        [stage]: content,
      },
    };

    try {
      await invoke("save_sdd_state", { workspacePath: wsPath, state: newState });
      setSddState(newState);
    } catch (e) {
      alert(`Failed to save draft: ${e}`);
    }
  };

  // Sync SDD state periodically when selectedIssueId changes
  useEffect(() => {
    if (selectedIssueId) {
      fetchSddState(selectedIssueId);
      const sddInterval = setInterval(() => {
        fetchSddState(selectedIssueId);
      }, 1500);
      return () => clearInterval(sddInterval);
    } else {
      setSddState(null);
    }
  }, [selectedIssueId]);

  // History states
  const [histories, setHistories] = useState<any[]>([]);
  const [isLoadingHistories, setIsLoadingHistories] = useState<boolean>(false);
  const [selectedHistory, setSelectedHistory] = useState<any | null>(null);
  const [historyTranscript, setHistoryTranscript] = useState<any[]>([]);
  const [isLoadingTranscript, setIsLoadingTranscript] = useState<boolean>(false);
  const [historySearchQuery, setHistorySearchQuery] = useState<string>("");

  const fetchHistories = async () => {
    setIsLoadingHistories(true);
    try {
      const data: any[] = await invoke("get_session_histories");
      setHistories(data);
    } catch (e) {
      console.error("Failed to fetch session histories:", e);
    } finally {
      setIsLoadingHistories(false);
    }
  };

  const openHistoryTranscript = async (entry: any) => {
    setSelectedHistory(entry);
    setHistoryTranscript([]);
    setIsLoadingTranscript(true);
    try {
      const data: any[] = await invoke("get_session_transcript", { filePath: entry.file_path });
      setHistoryTranscript(data);
    } catch (e) {
      alert(`Failed to load transcript: ${e}`);
    } finally {
      setIsLoadingTranscript(false);
    }
  };

  // Open setup and fetch current settings if they exist
  const openSetupWizard = async () => {
    let loadedProjectDir = "";
    try {
      const data: any = await invoke("get_current_workflow");
      if (data && data.settings) {
        const s = data.settings;
        if (s.tracker) {
          setTrackerKind(s.tracker.kind || "github");
          setTrackerEndpoint(s.tracker.endpoint || "");
          setTrackerApiKey(s.tracker.api_key || "");
          setTrackerProjectSlug(s.tracker.project_slug || "");
          setTrackerAssignee(s.tracker.assignee || "");
          if (s.tracker.active_states) {
            setTrackerActiveStates(s.tracker.active_states.join(", "));
          }
          if (s.tracker.terminal_states) {
            setTrackerTerminalStates(s.tracker.terminal_states.join(", "));
          }
          setTrackerRequiredLabels(
            s.tracker.required_labels ? s.tracker.required_labels.join(", ") : "",
          );
        }
        if (s.polling) {
          setPollingInterval(s.polling.interval_ms || 30000);
        }
        if (s.workspace) {
          setWorkspaceRoot(s.workspace.root || "");
        }
        if (s.agent) {
          setAgentMaxConcurrent(s.agent.max_concurrent_agents || 3);
          setAgentMaxTurns(s.agent.max_turns || 20);
          setAgentMaxRetryBackoff(s.agent.max_retry_backoff_ms || 300000);
          if (s.agent.team_profile === "solo" || s.agent.team_profile === "large") {
            setTeamProfile(s.agent.team_profile);
          } else {
            setTeamProfile("small");
          }
        }
        if (s.codex) {
          setAgentCommand(s.codex.command || "");
          setAgentProtocol(s.codex.protocol || "jsonrpc");
          setAgentThreadSandbox(s.codex.thread_sandbox || "workspace-write");
          setAgentTurnTimeout(s.codex.turn_timeout_ms || 3600000);

          if (s.codex.command === "codex app-server" && s.codex.protocol === "jsonrpc") {
            setAgentSelection("codex");
          } else if (s.codex.command === "kiro-cli acp" && s.codex.protocol === "jsonrpc") {
            setAgentSelection("kiro");
          } else if (s.codex.command === "agy --print -" && s.codex.protocol === "oneshot") {
            setAgentSelection("antigravity");
          } else {
            setAgentSelection("custom");
          }
        }
        if (s.hooks) {
          setHooksAfterCreate(s.hooks.after_create || "");
          setHooksBeforeRun(s.hooks.before_run || "");
          setHooksAfterRun(s.hooks.after_run || "");
          setHooksBeforeRemove(s.hooks.before_remove || "");
          setHooksTimeout(s.hooks.timeout_ms || 120000);

          const ac = s.hooks.after_create || "";
          if (ac.includes("rsync")) {
            setPresetSelection("local_copy");
          } else if (ac.includes("gitlab.com")) {
            setPresetSelection("gitlab_remote");
          } else if (ac.includes("github.com")) {
            setPresetSelection("github_remote");
          } else if (ac.includes("project_dir") || ac.includes("projectDir")) {
            setPresetSelection("local_git");
          } else {
            setPresetSelection("custom");
          }
        }
        if (data.prompt_template) {
          setPromptTemplate(data.prompt_template);
        }
        if (data.project_dir) {
          loadedProjectDir = data.project_dir;
          setProjectDir(data.project_dir);
        }
      }
    } catch (e) {
      console.error("Failed to load current workflow settings:", e);
    }

    try {
      const gitInfo: any = await invoke("detect_local_git_info");
      if (gitInfo) {
        if (!loadedProjectDir && gitInfo.project_dir) {
          setProjectDir(gitInfo.project_dir);
        }
        if (gitInfo.project_slug) {
          setTrackerProjectSlug((prev) => prev || gitInfo.project_slug || "");
        }
        if (gitInfo.detected_tracker) {
          setTrackerKind((prev) => prev || gitInfo.detected_tracker || "github");
        }
      }
    } catch (e) {
      console.warn("Failed to auto-detect Git/project info:", e);
    }

    setStep1Verified(false);
    setStep1Loading(false);
    setStep1Error(null);
    setStep1SuccessMsg(null);

    setStep2Verified(false);
    setStep2Loading(false);
    setStep2Error(null);
    setStep2SuccessMsg(null);

    setStep3Verified(false);
    setStep3Loading(false);
    setStep3Error(null);
    setStep3SuccessMsg(null);

    setStep4Verified(false);
    setStep4Loading(false);
    setStep4Error(null);
    setStep4SuccessMsg(null);

    setWizardStep(1);
    setIsSetupOpen(true);
  };

  const handleSaveWorkflow = async () => {
    setIsSavingWorkflow(true);
    try {
      const activeStatesList = trackerActiveStates
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const terminalStatesList = trackerTerminalStates
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const requiredLabelsList = trackerRequiredLabels
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const payload = {
        settings: {
          tracker: {
            kind: trackerKind,
            endpoint: trackerEndpoint,
            api_key: trackerApiKey ? trackerApiKey : null,
            project_slug: trackerProjectSlug,
            assignee: trackerAssignee ? trackerAssignee : null,
            active_states: activeStatesList,
            terminal_states: terminalStatesList,
            required_labels: requiredLabelsList,
          },
          polling: {
            interval_ms: Number(pollingInterval),
          },
          workspace: {
            root: workspaceRoot,
          },
          agent: {
            max_concurrent_agents: Number(agentMaxConcurrent),
            max_turns: Number(agentMaxTurns),
            max_retry_backoff_ms: Number(agentMaxRetryBackoff),
            max_concurrent_agents_by_state: {},
            team_profile: teamProfile,
          },
          codex: {
            command: agentCommand,
            protocol: agentProtocol,
            approval_policy: {
              reject: {
                sandbox_approval: true,
                rules: true,
                mcp_elicitations: true,
              },
            },
            thread_sandbox: agentThreadSandbox,
            turn_sandbox_policy: null,
            turn_timeout_ms: Number(agentTurnTimeout),
            read_timeout_ms: 5000,
            stall_timeout_ms: 300000,
          },
          hooks: {
            after_create: hooksAfterCreate ? hooksAfterCreate : null,
            before_run: hooksBeforeRun ? hooksBeforeRun : null,
            after_run: hooksAfterRun ? hooksAfterRun : null,
            before_remove: hooksBeforeRemove ? hooksBeforeRemove : null,
            timeout_ms: Number(hooksTimeout),
          },
          server: {
            port: null,
            host: "127.0.0.1",
          },
        },
        prompt_template: promptTemplate,
        project_dir: projectDir ? projectDir : null,
      };

      await invoke("save_workflow", { payload });
      setReloadMsg("Workflow initialized successfully!");
      fetchState();
      setIsSetupOpen(false);
      setTimeout(() => setReloadMsg(null), 3000);
    } catch (e) {
      alert(`Initialization failed: ${e}`);
    } finally {
      setIsSavingWorkflow(false);
    }
  };

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
          if (stateSnapshot.backlog) {
            stateSnapshot.backlog.forEach((issue) => {
              next[issue.id] = issue;
            });
          }
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

    // Fetch initial workflow info to detect if we are in zero-config offline demo mode
    invoke<any>("get_current_workflow")
      .then((data) => {
        if (data && data.settings && data.settings.tracker) {
          setTrackerKind(data.settings.tracker.kind || "github");
        }
      })
      .catch((err) => {
        console.error("Failed to load initial workflow info:", err);
      });

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

  const formatIdentifier = (id: string | null | undefined): string => {
    if (!id) return "";
    return /^\d+$/.test(id) ? `#${id}` : id;
  };

  const renderInlineMarkdown = (text: string): React.ReactNode[] => {
    const combinedRegex = /(\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s]+|\*\*[^*]+\*\*|\*[^*]+\*)/g;
    const parts = text.split(combinedRegex);

    return parts.map((part, index) => {
      const namedLinkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (namedLinkMatch) {
        return (
          <a
            key={index}
            href={namedLinkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--color-primary)", textDecoration: "underline" }}
          >
            {namedLinkMatch[1]}
          </a>
        );
      }

      const nakedUrlMatch = part.match(/^https?:\/\/[^\s]+$/);
      if (nakedUrlMatch) {
        let url = nakedUrlMatch[0];
        let trailing = "";
        const trailingMatch = url.match(/([.,;:)]+)$/);
        if (trailingMatch) {
          url = url.slice(0, -trailingMatch[0].length);
          trailing = trailingMatch[0];
        }
        return (
          <span key={index}>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--color-primary)", textDecoration: "underline" }}
            >
              {url}
            </a>
            {trailing}
          </span>
        );
      }

      const boldMatch = part.match(/^\*\*([^*]+)\*\*$/);
      if (boldMatch) {
        return (
          <strong key={index} style={{ fontWeight: "bold", color: "var(--color-text-main)" }}>
            {boldMatch[1]}
          </strong>
        );
      }

      const italicsMatch = part.match(/^\*([^*]+)\*$/);
      if (italicsMatch) {
        return (
          <em key={index} style={{ fontStyle: "italic" }}>
            {italicsMatch[1]}
          </em>
        );
      }

      return part;
    });
  };

  const parseMarkdownToReact = (text: string | null | undefined): React.ReactNode => {
    if (!text) return null;

    const lines = text.split(/\r?\n/);
    const elements: React.ReactNode[] = [];
    let currentList: string[] = [];

    const flushList = (key: string | number) => {
      if (currentList.length > 0) {
        elements.push(
          <ul
            key={`list-${key}`}
            style={{ paddingLeft: "1.2rem", margin: "0.4rem 0", listStyleType: "disc" }}
          >
            {currentList.map((item, idx) => (
              <li key={idx} style={{ marginBottom: "0.2rem" }}>
                {renderInlineMarkdown(item)}
              </li>
            ))}
          </ul>,
        );
        currentList = [];
      }
    };

    lines.forEach((line, index) => {
      const trimmed = line.trim();

      if (/^[-*+]\s+/.test(trimmed)) {
        const itemContent = trimmed.replace(/^[-*+]\s+/, "");
        currentList.push(itemContent);
      } else {
        flushList(index);

        if (!trimmed) return;

        if (/^(?:---|\*\*\*|___)$/.test(trimmed)) {
          elements.push(
            <hr
              key={index}
              style={{
                border: "none",
                borderTop: "1px solid rgba(255, 255, 255, 0.08)",
                margin: "0.8rem 0",
              }}
            />,
          );
        } else if (/^#{1,6}\s+/.test(trimmed)) {
          const level = (trimmed.match(/^#+/) || ["#"])[0].length;
          const headingText = trimmed.replace(/^#+\s+/, "");
          const fontSize = level === 1 ? "1.2rem" : level === 2 ? "1.1rem" : "0.95rem";
          elements.push(
            <div
              key={index}
              style={{
                fontWeight: 600,
                fontSize,
                color: "var(--color-text-main)",
                marginTop: "0.6rem",
                marginBottom: "0.3rem",
              }}
            >
              {renderInlineMarkdown(headingText)}
            </div>,
          );
        } else {
          elements.push(
            <p key={index} style={{ margin: "0.4rem 0", lineHeight: 1.45 }}>
              {renderInlineMarkdown(trimmed)}
            </p>,
          );
        }
      }
    });

    flushList("end");

    return <div className="markdown-body">{elements}</div>;
  };

  // Compile Kanban board columns
  const runningArray = orchState ? Object.values(orchState.running) : [];
  const blockedArray = orchState ? Object.values(orchState.blocked) : [];
  const retryArray = orchState ? Object.values(orchState.retry_attempts) : [];
  const completedIds = orchState ? orchState.completed : [];

  // Group tickets by column
  // Column 1: Todo (Retrying & open candidate issues not yet running/blocked/completed)
  const backlogIssues = orchState?.backlog
    ? orchState.backlog
        .filter((issue) => {
          const isRunning = runningArray.some((r) => r.issue.id === issue.id);
          const isBlocked = blockedArray.some((b) => b.issue_id === issue.id);
          const isRetry = retryArray.some((r) => r.issue_id === issue.id);
          const isDone = completedIds.includes(issue.id);
          return !isRunning && !isBlocked && !isRetry && !isDone;
        })
        .map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          priority: issue.priority,
          state: "Todo",
          type: "backlog" as const,
          error: null,
          attempt: 0,
          due_at_ms: 0,
          issue: issue,
        }))
    : [];

  const retryTickets = retryArray.map((retry) => {
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

  const todoColumnTickets = [...backlogIssues, ...retryTickets];

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
  const doneColumnTickets = completedIds
    .filter((id) => {
      const isRunning = runningArray.some((r) => r.issue.id === id);
      const isBlocked = blockedArray.some((b) => b.issue_id === id);
      const isRetry = retryArray.some((r) => r.issue_id === id);
      const isBacklog = orchState?.backlog?.some((issue) => issue.id === id);
      return !isRunning && !isBlocked && !isRetry && !isBacklog;
    })
    .map((id) => {
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

    // Check Backlog
    const backlog = orchState?.backlog?.find((b) => b.id === selectedIssueId);
    if (backlog) return { type: "backlog" as const, data: backlog, entry: backlog };

    return null;
  };

  const selectedDetails = getSelectedTicketDetails();

  // Generate automated checklist plan items based on current turn count or parsed description checkboxes
  const renderPlanChecklist = (turnCount: number, type: string) => {
    const isDone = type === "completed";
    const issue = selectedDetails?.data;
    const identifier = issue?.identifier || "";
    const description = issue?.description || "";
    const title = issue?.title || "";

    // Determine if this is the TodoMVC badges demo issue
    const isDemoIssue =
      identifier === "DEMO-101" ||
      identifier === "demo-issue-1" ||
      title.toLowerCase().includes("todomvc") ||
      description.toLowerCase().includes("todomvc");

    interface ChecklistStep {
      text: string;
      completed: boolean;
      activeTurn?: number;
    }

    interface ChecklistPhase {
      title: string;
      steps: ChecklistStep[];
    }

    let checklistPhases: ChecklistPhase[] = [];

    if (isDemoIssue) {
      // Fallback to the hardcoded TodoMVC checklist
      checklistPhases = [
        {
          title: "1. Inspect existing TodoMVC footer filter implementation",
          steps: [
            {
              text: "Locate React component rendering filter tabs",
              completed: isDone || turnCount > 1,
              activeTurn: 1,
            },
            {
              text: "Identify how active/completed counts are computed",
              completed: isDone || turnCount > 2,
              activeTurn: 2,
            },
            {
              text: "Review shared CSS to understand layout constraints",
              completed: isDone || turnCount > 3,
              activeTurn: 3,
            },
          ],
        },
        {
          title: "2. Extend filter markup to support badges without changing behavior",
          steps: [
            {
              text: "Add badge rendering for Active",
              completed: isDone || turnCount > 4,
              activeTurn: 4,
            },
            {
              text: "Add badge rendering for Completed",
              completed: isDone || turnCount > 5,
              activeTurn: 5,
            },
            {
              text: "Ensure badges render even if count is 0",
              completed: isDone || turnCount > 6,
              activeTurn: 6,
            },
            {
              text: "Keep All tab unchanged and preserve routing/selection",
              completed: isDone || turnCount > 7,
              activeTurn: 7,
            },
          ],
        },
        {
          title: "3. Add styling for a compact vintage macOS-style badge",
          steps: [
            {
              text: "Add local CSS overrides rather than changing upstream CSS",
              completed: isDone || turnCount > 8,
              activeTurn: 8,
            },
            {
              text: "Style badge as a small gray rounded pill with highlight",
              completed: isDone || turnCount > 9,
              activeTurn: 9,
            },
            {
              text: "Keep spacing tight and visually consistent",
              completed: isDone || turnCount > 10,
              activeTurn: 10,
            },
            {
              text: "Avoid introducing layout regressions in filter row",
              completed: isDone || turnCount > 11,
              activeTurn: 11,
            },
          ],
        },
        {
          title: "4. Rebuild generated artifacts",
          steps: [
            {
              text: "Compile the TypeScript sources",
              completed: isDone || turnCount > 12,
              activeTurn: 12,
            },
            {
              text: "Rebuild the browser bundle so generated files sync",
              completed: isDone || turnCount > 13,
              activeTurn: 13,
            },
          ],
        },
        {
          title: "5. Validate the final behavior",
          steps: [
            {
              text: "Confirm Active and Completed both show numeric badges",
              completed: isDone || turnCount > 14,
              activeTurn: 14,
            },
          ],
        },
      ];
    } else {
      // Parse checklist dynamically from the description
      const lines = description.split(/\r?\n/);
      let currentPhase: ChecklistPhase | null = null;

      const checkboxRegex = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const checkboxMatch = line.match(checkboxRegex);
        if (checkboxMatch) {
          const completed = checkboxMatch[1].toLowerCase() === "x";
          const text = checkboxMatch[2].trim();

          if (!currentPhase) {
            currentPhase = { title: "Tasks", steps: [] };
            checklistPhases.push(currentPhase);
          }
          currentPhase.steps.push({ text, completed });
        } else {
          // Heuristic to detect section titles/headers
          const isHeader =
            trimmed.startsWith("#") ||
            (trimmed.startsWith("**") && trimmed.endsWith("**")) ||
            trimmed.endsWith(":") ||
            (trimmed.length < 60 && !trimmed.includes("[") && !trimmed.includes("]"));

          if (isHeader) {
            let phaseTitle = trimmed
              .replace(/^#{1,6}\s+/, "")
              .replace(/^\*\*|\*\*$/g, "")
              .trim();

            phaseTitle = phaseTitle.replace(/^[-*+]\s+/, "");
            if (phaseTitle.endsWith(":")) {
              phaseTitle = phaseTitle.slice(0, -1).trim();
            }

            if (phaseTitle.length > 0) {
              currentPhase = { title: phaseTitle, steps: [] };
              checklistPhases.push(currentPhase);
            }
          }
        }
      }

      // Filter out empty phases
      checklistPhases = checklistPhases.filter((p) => p.steps.length > 0);
    }

    if (checklistPhases.length === 0) {
      return (
        <div style={{ padding: "0.5rem", fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
          No checklist plan defined in the issue description.
        </div>
      );
    }

    // For dynamic checklists, find the first incomplete item and mark it as active if running
    let firstIncompleteFound = false;

    return (
      <div className="checklist-container">
        {checklistPhases.map((phase, pIdx) => {
          // Check if any step in this phase is incomplete
          const isPhasePending = !isDone && phase.steps.every((s) => !s.completed);

          return (
            <div key={pIdx} style={{ marginBottom: "0.5rem" }}>
              <div
                className="checklist-phase-title"
                style={{
                  opacity: isPhasePending ? 0.4 : 1,
                }}
              >
                {phase.title}
              </div>

              {phase.steps.map((step, sIdx) => {
                let isStepCompleted = step.completed;
                let isStepInProgress = false;

                if (isDemoIssue) {
                  // For the hardcoded demo, use the original activeTurn logic
                  isStepCompleted = isDone || turnCount > (step as any).activeTurn;
                  isStepInProgress = !isDone && turnCount === (step as any).activeTurn;
                } else {
                  // For dynamic checklists: if not completed, and we are running and it's the first incomplete one, mark as active
                  if (!isStepCompleted && !isDone && type === "running" && !firstIncompleteFound) {
                    isStepInProgress = true;
                    firstIncompleteFound = true;
                  }
                }

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
          <img src="/logo.png" alt="Skrvm Logo" className="brand-logo" />
          <div className="pulse-dot"></div>
          <h1 className="brand-title">Skrvm Orchestrator Console</h1>
        </div>

        <div className="controls-section">
          {reloadMsg && (
            <span className="queue-label" style={{ color: "#00f0ff", fontSize: "0.75rem" }}>
              {reloadMsg}
            </span>
          )}
          <button className="btn-premium" onClick={openSetupWizard}>
            Setup Wizard
          </button>
          <button className="btn-premium" onClick={handleReload} disabled={isReloading}>
            {isReloading ? "Reloading..." : "Reload Config"}
          </button>
        </div>
      </header>

      {/* Zero-Config Demo Mode Banner */}
      {trackerKind === "memory" && (
        <div className="demo-mode-banner">
          <div className="demo-banner-content">
            <span className="demo-badge-pulse">
              <span className="demo-badge-dot"></span>
              Offline Demo
            </span>
            <div className="demo-banner-text">
              <span className="demo-banner-title">Zero-Config Offline Simulation Mode Active</span>
              <span className="demo-banner-desc">
                Skrvm is currently running in-memory with local mock tickets and a simulated coding
                agent. No API keys or repository files are needed. To connect your actual coding
                workspaces, open the <a onClick={openSetupWizard}>Setup Wizard</a>.
              </span>
            </div>
          </div>
          <button className="btn-demo-wizard" onClick={openSetupWizard}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path>
            </svg>
            Connect Real Tracker
          </button>
        </div>
      )}

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

      {/* View Selector Tabs */}
      <div className="view-selector-tabs">
        <button
          className={`btn-tab ${activeTab === "kanban" ? "active" : ""}`}
          onClick={() => setActiveTab("kanban")}
        >
          Kanban Board
        </button>
        <button
          className={`btn-tab ${activeTab === "history" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("history");
            fetchHistories();
          }}
        >
          Session History
        </button>
      </div>

      {activeTab === "kanban" ? (
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
                          <span className="issue-tag">{formatIdentifier(ticket.identifier)}</span>
                        </div>
                        {ticket.priority && (
                          <span className="card-priority">{ticket.priority}</span>
                        )}
                      </div>
                      <span className="card-title">{ticket.title}</span>
                      <div className="card-footer">
                        {ticket.type === "retry" ? (
                          <>
                            <div className="card-meta-left">
                              <div className="status-dot retrying"></div>
                              <span>Attempt #{ticket.attempt}</span>
                            </div>
                            <span style={{ color: "var(--color-purple)", fontFamily: "monospace" }}>
                              Retrying
                            </span>
                          </>
                        ) : (
                          <>
                            <div className="card-meta-left">
                              <div
                                className="status-dot backlog"
                                style={{ backgroundColor: "var(--color-zinc-400)" }}
                              ></div>
                              <span>Open</span>
                            </div>
                            <span
                              style={{ color: "var(--color-zinc-400)", fontFamily: "monospace" }}
                            >
                              Backlog
                            </span>
                          </>
                        )}
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
                    <span className="empty-state-subtitle">
                      Idle. Awaiting candidate tickets...
                    </span>
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
                            <span className="issue-tag">{formatIdentifier(ticket.identifier)}</span>
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
                          <div
                            className="progress-bar-bg"
                            title={`${turnProgress}% turns completed`}
                          >
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
                          <span className="issue-tag">{formatIdentifier(ticket.identifier)}</span>
                        </div>
                        {ticket.priority && (
                          <span className="card-priority">{ticket.priority}</span>
                        )}
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
                          <span className="issue-tag">{formatIdentifier(ticket.identifier)}</span>
                        </div>
                        {ticket.priority && (
                          <span className="card-priority">{ticket.priority}</span>
                        )}
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
      ) : (
        /* Session History Area */
        <section className="history-container">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span
              className="detail-section-title"
              style={{ margin: 0, border: "none", padding: 0 }}
            >
              Completed & Pending Sessions
            </span>
            <input
              type="text"
              placeholder="Search history..."
              className="history-search-input"
              value={historySearchQuery}
              onChange={(e) => setHistorySearchQuery(e.target.value)}
            />
          </div>

          <div className="history-card-list">
            {isLoadingHistories ? (
              <div className="empty-state">
                <span className="empty-state-subtitle">Loading histories...</span>
              </div>
            ) : histories.filter(
                (h) =>
                  h.identifier.toLowerCase().includes(historySearchQuery.toLowerCase()) ||
                  h.title.toLowerCase().includes(historySearchQuery.toLowerCase()),
              ).length === 0 ? (
              <div className="empty-state">
                <span className="empty-state-subtitle">No session histories found</span>
              </div>
            ) : (
              histories
                .filter(
                  (h) =>
                    h.identifier.toLowerCase().includes(historySearchQuery.toLowerCase()) ||
                    h.title.toLowerCase().includes(historySearchQuery.toLowerCase()),
                )
                .map((entry) => (
                  <div
                    key={entry.session_id}
                    className="history-card"
                    onClick={() => openHistoryTranscript(entry)}
                  >
                    <div className="history-card-left">
                      <div className="history-card-title-row">
                        <span className="issue-tag">{formatIdentifier(entry.identifier)}</span>
                        <span className="history-card-title">{entry.title}</span>
                      </div>
                      <div className="history-card-meta">
                        <span>Attempt: #{entry.attempt}</span>
                        <span>•</span>
                        <span>Started: {new Date(entry.started_at).toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="history-card-right">
                      <button className="btn-premium">View Log</button>
                    </div>
                  </div>
                ))
            )}
          </div>
        </section>
      )}

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
                      {formatIdentifier(selectedDetails.data?.identifier || "MT-COMP")}
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
                  <div className="ticket-description">
                    {parseMarkdownToReact(selectedDetails.data.description)}
                  </div>
                )}
              </div>

              {/* SDD Workflow Wizard */}
              <div style={{ marginTop: "1rem", marginBottom: "1rem" }}>
                <div
                  className="detail-section-title"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
                    paddingBottom: "4px",
                    marginBottom: "8px",
                  }}
                >
                  <span>Spec-Driven Development (SDD)</span>
                  {!sddState && (
                    <button
                      className="btn-premium"
                      style={{ fontSize: "0.7rem", padding: "0.2rem 0.5rem" }}
                      onClick={() => handleTriggerSddStep("triage")}
                    >
                      Enable SDD Workflow
                    </button>
                  )}
                </div>

                {sddState ? (
                  <div className="sdd-wizard">
                    <div
                      className="sdd-wizard-tabs"
                      style={{
                        display: "flex",
                        gap: "4px",
                        marginBottom: "8px",
                        overflowX: "auto",
                        paddingBottom: "4px",
                      }}
                    >
                      <button
                        className={`btn-tab ${activeSddTab === "triage" ? "active" : ""}`}
                        style={{ fontSize: "0.7rem", padding: "4px 8px" }}
                        onClick={() => setActiveSddTab("triage")}
                      >
                        1. Triage
                      </button>
                      <button
                        className={`btn-tab ${activeSddTab === "requirements" ? "active" : ""}`}
                        style={{ fontSize: "0.7rem", padding: "4px 8px" }}
                        onClick={() => {
                          setActiveSddTab("requirements");
                          setEditingDraftText(sddState.drafts["requirements"] || "");
                        }}
                      >
                        2. Requirements
                      </button>
                      <button
                        className={`btn-tab ${activeSddTab === "design" ? "active" : ""}`}
                        style={{ fontSize: "0.7rem", padding: "4px 8px" }}
                        onClick={() => {
                          setActiveSddTab("design");
                          setEditingDraftText(sddState.drafts["design"] || "");
                        }}
                      >
                        3. Design
                      </button>
                      <button
                        className={`btn-tab ${activeSddTab === "tasks" ? "active" : ""}`}
                        style={{ fontSize: "0.7rem", padding: "4px 8px" }}
                        onClick={() => {
                          setActiveSddTab("tasks");
                          setEditingDraftText(sddState.drafts["tasks"] || "");
                        }}
                      >
                        4. Tasks
                      </button>
                      <button
                        className={`btn-tab ${activeSddTab === "execution" ? "active" : ""}`}
                        style={{ fontSize: "0.7rem", padding: "4px 8px" }}
                        onClick={() => setActiveSddTab("execution")}
                      >
                        5. Execution
                      </button>
                    </div>

                    <div
                      className="sdd-wizard-content"
                      style={{
                        background: "rgba(255, 255, 255, 0.02)",
                        padding: "10px",
                        borderRadius: "6px",
                        border: "1px solid rgba(255, 255, 255, 0.05)",
                      }}
                    >
                      {activeSddTab === "triage" && (
                        <div>
                          <div style={{ fontSize: "0.8rem", marginBottom: "8px" }}>
                            <strong>Triage Recommendation:</strong>{" "}
                            {sddState.is_sdd ? (
                              <span
                                style={{
                                  color: "var(--color-primary)",
                                  textShadow: "0 0 8px rgba(0, 240, 255, 0.3)",
                                }}
                              >
                                Complex issue, SDD Recommended
                              </span>
                            ) : (
                              <span style={{ color: "var(--color-zinc-400)" }}>
                                Simple issue, Standard Flow Recommended
                              </span>
                            )}
                          </div>
                          <div style={{ display: "flex", gap: "8px" }}>
                            <button
                              className="btn-premium"
                              onClick={async () => {
                                const newState = { ...sddState, is_sdd: !sddState.is_sdd };
                                let wsPath: string | null = null;
                                const running = orchState
                                  ? Object.values(orchState.running).find(
                                      (r) => r.issue.id === selectedIssueId,
                                    )
                                  : undefined;
                                if (running && running.workspace_path) {
                                  wsPath = running.workspace_path;
                                } else {
                                  const cached = issueCache[selectedIssueId || ""];
                                  if (cached) {
                                    const sanitizedKey =
                                      `${cached.identifier.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${cached.title.toLowerCase().replace(/[^a-z0-9]/g, "-")}`.slice(
                                        0,
                                        50,
                                      );
                                    const workflow = await invoke<any>("get_current_workflow");
                                    if (
                                      workflow &&
                                      workflow.settings &&
                                      workflow.settings.workspace
                                    ) {
                                      const root = workflow.settings.workspace.root;
                                      wsPath = `${root}/${sanitizedKey}`;
                                    }
                                  }
                                }
                                if (wsPath) {
                                  await invoke("save_sdd_state", {
                                    workspacePath: wsPath,
                                    state: newState,
                                  });
                                  setSddState(newState);
                                }
                              }}
                            >
                              Toggle SDD: {sddState.is_sdd ? "Disable" : "Enable"}
                            </button>
                            <button
                              className="btn-premium"
                              style={{
                                background: "var(--color-primary)",
                                borderColor: "var(--color-primary)",
                                color: "var(--bg-primary)",
                                fontWeight: 600,
                              }}
                              onClick={() => handleTriggerSddStep("requirements")}
                            >
                              Proceed to Requirements
                            </button>
                          </div>
                        </div>
                      )}

                      {(activeSddTab === "requirements" ||
                        activeSddTab === "design" ||
                        activeSddTab === "tasks") && (
                        <div>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              marginBottom: "8px",
                              alignItems: "center",
                            }}
                          >
                            <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>
                              Draft {activeSddTab}.md
                            </span>
                            <button
                              className="btn-premium"
                              style={{ fontSize: "0.65rem", padding: "2px 6px" }}
                              onClick={() => handleSaveSddDraft(activeSddTab, editingDraftText)}
                            >
                              Save Draft
                            </button>
                          </div>
                          <textarea
                            style={{
                              width: "100%",
                              background: "rgba(0, 0, 0, 0.2)",
                              color: "#c9c9c9",
                              border: "1px solid rgba(255, 255, 255, 0.1)",
                              borderRadius: "4px",
                              fontFamily: "monospace",
                              fontSize: "0.75rem",
                              padding: "8px",
                              minHeight: "120px",
                              resize: "vertical",
                            }}
                            value={editingDraftText}
                            onChange={(e) => setEditingDraftText(e.target.value)}
                          />

                          {sddState.reviews[activeSddTab] && (
                            <div
                              className="scorecard-box"
                              style={{
                                marginTop: "10px",
                                padding: "8px",
                                background: "rgba(255, 255, 255, 0.03)",
                                borderRadius: "4px",
                                borderLeft: "3px solid var(--color-primary)",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  marginBottom: "4px",
                                }}
                              >
                                <span style={{ fontSize: "0.75rem", fontWeight: 600 }}>
                                  Subagent Scorecard
                                </span>
                                <span
                                  className="macos-badge"
                                  style={{
                                    background: sddState.reviews[activeSddTab].passed
                                      ? "rgba(16, 185, 129, 0.15)"
                                      : "rgba(239, 68, 68, 0.15)",
                                    color: sddState.reviews[activeSddTab].passed
                                      ? "var(--color-emerald)"
                                      : "var(--color-red)",
                                  }}
                                >
                                  Score: {sddState.reviews[activeSddTab].score}/100 (
                                  {sddState.reviews[activeSddTab].passed ? "Passed" : "Failed"})
                                </span>
                              </div>
                              <div
                                style={{
                                  fontSize: "0.7rem",
                                  color: "var(--color-text-muted)",
                                  fontStyle: "italic",
                                }}
                              >
                                {sddState.reviews[activeSddTab].feedback}
                              </div>
                            </div>
                          )}

                          <div style={{ marginTop: "10px", display: "flex", gap: "8px" }}>
                            <button
                              className="btn-premium"
                              style={{
                                background: "var(--color-primary)",
                                borderColor: "var(--color-primary)",
                                color: "var(--bg-primary)",
                                fontWeight: 600,
                              }}
                              onClick={() => {
                                const nextTab =
                                  activeSddTab === "requirements"
                                    ? "design"
                                    : activeSddTab === "design"
                                      ? "tasks"
                                      : "execute";
                                handleTriggerSddStep(nextTab);
                              }}
                            >
                              Approve & Proceed
                            </button>
                          </div>
                        </div>
                      )}

                      {activeSddTab === "execution" && (
                        <div>
                          <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "8px" }}>
                            Task Execution DAG Checklist
                          </div>
                          <div
                            className="task-dag-container"
                            style={{ display: "flex", flexDirection: "column", gap: "8px" }}
                          >
                            {sddState.tasks.map((task) => {
                              const statusColor =
                                task.status === "completed"
                                  ? "var(--color-emerald)"
                                  : task.status === "in_progress"
                                    ? "var(--color-primary)"
                                    : "var(--color-zinc-400)";
                              return (
                                <div
                                  key={task.id}
                                  className="task-node"
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyItems: "center",
                                    justifyContent: "space-between",
                                    padding: "6px 10px",
                                    background: "rgba(0, 0, 0, 0.15)",
                                    border: "1px solid rgba(255, 255, 255, 0.05)",
                                    borderRadius: "4px",
                                  }}
                                >
                                  <div
                                    style={{ display: "flex", alignItems: "center", gap: "8px" }}
                                  >
                                    <div
                                      className={`status-dot ${task.status}`}
                                      style={{
                                        width: "8px",
                                        height: "8px",
                                        borderRadius: "50%",
                                        background: statusColor,
                                      }}
                                    ></div>
                                    <span
                                      style={{
                                        fontSize: "0.75rem",
                                        color:
                                          task.status === "completed"
                                            ? "var(--color-text-muted)"
                                            : "var(--color-text-main)",
                                        textDecoration:
                                          task.status === "completed" ? "line-through" : "none",
                                      }}
                                    >
                                      {task.text}
                                    </span>
                                  </div>
                                  <span
                                    style={{
                                      fontSize: "0.65rem",
                                      textTransform: "uppercase",
                                      color: statusColor,
                                      fontWeight: task.status === "in_progress" ? 600 : 400,
                                    }}
                                  >
                                    {task.status}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                          {sddState.current_stage !== "execution" &&
                            sddState.current_stage !== "done" && (
                              <button
                                className="btn-premium"
                                style={{
                                  width: "100%",
                                  marginTop: "12px",
                                  background: "var(--color-primary)",
                                  borderColor: "var(--color-primary)",
                                  color: "var(--bg-primary)",
                                  fontWeight: 600,
                                }}
                                onClick={() => handleTriggerSddStep("execute")}
                              >
                                Launch SDD Execution DAG
                              </button>
                            )}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--color-text-muted)",
                      fontStyle: "italic",
                      padding: "0.5rem",
                      background: "rgba(255, 255, 255, 0.01)",
                      border: "1px dashed rgba(255, 255, 255, 0.05)",
                      borderRadius: "4px",
                    }}
                  >
                    SDD is not enabled for this issue. Use the button above to enable the structured
                    Spec-Driven Development workflow.
                  </div>
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
              {(() => {
                const issue = selectedDetails.data;
                const identifier = issue?.identifier || "";
                const description = issue?.description || "";
                const title = issue?.title || "";

                const isDemoIssue =
                  identifier === "DEMO-101" ||
                  identifier === "demo-issue-1" ||
                  title.toLowerCase().includes("todomvc") ||
                  description.toLowerCase().includes("todomvc");

                let hasChecklist = isDemoIssue;
                if (!isDemoIssue && description) {
                  const lines = description.split(/\r?\n/);
                  const checkboxRegex = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/;
                  hasChecklist = lines.some((line) => checkboxRegex.test(line));
                }

                if (!hasChecklist) return null;

                const headingTitle = isDemoIssue ? "Automated Checklist Plan" : "Issue Checklist";

                return (
                  <div>
                    <div className="detail-section-title">{headingTitle}</div>
                    {renderPlanChecklist(
                      selectedDetails.type === "running"
                        ? (selectedDetails.entry as RunningEntry).turn_count
                        : selectedDetails.type === "completed"
                          ? 20
                          : 0,
                      selectedDetails.type,
                    )}
                  </div>
                );
              })()}

              {/* Vintage macOS Badge Interactive Widget Demo */}
              {(() => {
                const issue = selectedDetails.data;
                const identifier = issue?.identifier || "";
                const description = issue?.description || "";
                const title = issue?.title || "";
                const isDemoIssue =
                  identifier === "DEMO-101" ||
                  identifier === "demo-issue-1" ||
                  title.toLowerCase().includes("todomvc") ||
                  description.toLowerCase().includes("todomvc");

                if (!isDemoIssue) return null;

                return (
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
                                <span
                                  className={`mini-todo-text ${todo.completed ? "completed" : ""}`}
                                >
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
                );
              })()}

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

      {/* History Transcript Modal Overlay */}
      {selectedHistory && (
        <div className="modal-backdrop" onClick={() => setSelectedHistory(null)}>
          <div
            className="setup-modal-content"
            style={{ maxWidth: "800px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="setup-modal-header">
              <span
                className="setup-modal-title"
                style={{ display: "flex", gap: "8px", alignItems: "center" }}
              >
                <span className="issue-tag">{formatIdentifier(selectedHistory.identifier)}</span>
                <span>{selectedHistory.title} — Transcript Log</span>
              </span>
              <button className="setup-modal-close" onClick={() => setSelectedHistory(null)}>
                &times;
              </button>
            </div>

            <div className="setup-modal-body transcript-modal-body">
              <div className="meta-grid">
                <div className="meta-item">
                  <span className="meta-label">Session ID</span>
                  <span className="meta-value">{selectedHistory.session_id}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Attempt</span>
                  <span className="meta-value">#{selectedHistory.attempt}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Started At</span>
                  <span className="meta-value">
                    {new Date(selectedHistory.started_at).toLocaleString()}
                  </span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Source Path</span>
                  <span className="meta-value" title={selectedHistory.file_path}>
                    {selectedHistory.file_path}
                  </span>
                </div>
              </div>

              <div className="detail-section-title">Execution Log Console</div>
              <div className="transcript-console">
                {isLoadingTranscript ? (
                  <div className="empty-state">
                    <span className="empty-state-subtitle">Loading execution logs...</span>
                  </div>
                ) : historyTranscript.length === 0 ? (
                  <div className="empty-state">
                    <span className="empty-state-subtitle">No logs recorded for this session</span>
                  </div>
                ) : (
                  historyTranscript.map((log: any, index: number) => {
                    const isError =
                      log.event.toLowerCase().includes("fail") ||
                      log.event.toLowerCase().includes("err");
                    const isSuccess =
                      log.event.toLowerCase().includes("complete") ||
                      log.event.toLowerCase().includes("success");
                    const isWarning =
                      log.event.toLowerCase().includes("block") ||
                      log.event.toLowerCase().includes("warn") ||
                      log.event.toLowerCase().includes("input");

                    let eventClass = "";
                    if (isError) eventClass = "error";
                    else if (isSuccess) eventClass = "success";
                    else if (isWarning) eventClass = "warning";

                    const time = new Date(log.timestamp).toLocaleTimeString();

                    return (
                      <div key={index} className="transcript-row">
                        <span className="transcript-time">[{time}]</span>
                        <span className={`transcript-event ${eventClass}`}>{log.event}</span>
                        {log.message && <span className="transcript-message">: {log.message}</span>}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Setup Modal */}
      {isSetupOpen && (
        <div className="modal-backdrop" onClick={() => setIsSetupOpen(false)}>
          <div
            className="setup-modal-content wizard-modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="setup-modal-header">
              <span className="setup-modal-title">
                Skrvm Setup {"\u0026"} Initialization Wizard
              </span>
              <button
                className="setup-modal-close"
                onClick={() => setIsSetupOpen(false)}
                aria-label="Close setup wizard"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>

            {/* Stepper bar */}
            <div className="setup-steps-bar" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
              {WIZARD_STEPS.map((label, idx) => {
                const n = idx + 1;
                const isActive = wizardStep === n;
                const isDone = wizardStep > n;
                return (
                  <div
                    key={label}
                    className={`setup-step-indicator ${isActive ? "active" : isDone ? "done" : ""}`}
                    onClick={() => setWizardStep(n)}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        justifyContent: "center",
                      }}
                    >
                      {isDone ? (
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          style={{ color: "var(--color-emerald)" }}
                        >
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      ) : (
                        <span
                          className={`step-num-badge ${isActive ? "active" : ""}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: "16px",
                            height: "16px",
                            borderRadius: "50%",
                            fontSize: "0.6rem",
                            background: isActive
                              ? "rgba(6, 182, 212, 0.2)"
                              : "rgba(255, 255, 255, 0.05)",
                            border: isActive
                              ? "1px solid var(--color-primary)"
                              : "1px solid rgba(255, 255, 255, 0.1)",
                            color: isActive ? "var(--color-primary)" : "var(--color-text-muted)",
                          }}
                        >
                          {n}
                        </span>
                      )}
                      <span>{label}</span>
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="setup-modal-body">
              {/* Step 1: Team Profile */}
              {wizardStep === 1 && (
                <div className="wizard-step-body">
                  <div className="wizard-step-heading">
                    <span className="wizard-step-title">Team Profile</span>
                    <span className="wizard-step-subtitle">
                      Pick the profile that matches your team. This sets sensible defaults for
                      worker concurrency, polling cadence, and how aggressively Skrvm claims
                      tickets. You can fine-tune everything in later steps.
                    </span>
                  </div>

                  <div className="profile-cards-grid">
                    <div
                      className={`agent-setup-card ${teamProfile === "solo" ? "selected" : ""}`}
                      onClick={() => applyTeamProfile("solo")}
                    >
                      <span className="agent-card-title">Solo</span>
                      <span className="agent-card-desc">
                        One developer, one workspace at a time. Calm and predictable.
                      </span>
                      <div className="profile-card-meta">
                        <span className="profile-pill">1 worker</span>
                        <span className="profile-pill">no label gate</span>
                      </div>
                    </div>
                    <div
                      className={`agent-setup-card ${teamProfile === "small" ? "selected" : ""}`}
                      onClick={() => applyTeamProfile("small")}
                    >
                      <span className="agent-card-title">Small Team</span>
                      <span className="agent-card-desc">
                        A handful of contributors sharing a tracker with light automation.
                      </span>
                      <div className="profile-card-meta">
                        <span className="profile-pill">3 workers</span>
                        <span className="profile-pill">assignee scope</span>
                      </div>
                    </div>
                    <div
                      className={`agent-setup-card ${teamProfile === "large" ? "selected" : ""}`}
                      onClick={() => applyTeamProfile("large")}
                    >
                      <span className="agent-card-title">Large Org</span>
                      <span className="agent-card-desc">
                        Busy shared tracker. Gate work behind an opt-in label so the bot never grabs
                        human-owned tickets.
                      </span>
                      <div className="profile-card-meta">
                        <span className="profile-pill">8 workers</span>
                        <span className="profile-pill">label gate</span>
                      </div>
                    </div>
                  </div>

                  <div className="setup-tip">
                    Derived defaults: <strong>{agentMaxConcurrent}</strong> concurrent worker(s),
                    polling every <strong>{Math.round(pollingInterval / 1000)}s</strong>
                    {trackerRequiredLabels
                      ? `, only issues labeled "${trackerRequiredLabels}".`
                      : ", every assigned issue is eligible."}
                  </div>
                </div>
              )}

              {/* Step 2: Tracker */}
              {wizardStep === 2 && (
                <div className="wizard-step-body">
                  <div className="wizard-step-heading">
                    <span className="wizard-step-title">Issue Tracker</span>
                    <span className="wizard-step-subtitle">
                      Connect the tracker your team works out of and scope which issues Skrvm is
                      allowed to pick up.
                    </span>
                  </div>

                  {detectedGitInfo && (
                    <div className="zero-config-helper-alert">
                      <svg
                        className="zero-config-helper-icon"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="16" x2="12" y2="12"></line>
                        <line x1="12" y1="8" x2="12.01" y2="8"></line>
                      </svg>
                      <div className="zero-config-helper-body">
                        <span className="zero-config-helper-title">
                          Zero-Config Auto-Detect Helper
                        </span>
                        <span className="zero-config-helper-desc">
                          We auto-detected your local Git repository slug and tracker provider:
                        </span>
                        <div className="zero-config-helper-details">
                          <div className="zero-config-helper-detail-item">
                            <span className="zero-config-helper-detail-label">
                              Detected Repo Slug:
                            </span>
                            <span
                              className="zero-config-helper-detail-val"
                              title={detectedGitInfo.project_slug || "None"}
                            >
                              {detectedGitInfo.project_slug || "None"}
                            </span>
                          </div>
                          <div className="zero-config-helper-detail-item">
                            <span className="zero-config-helper-detail-label">
                              Detected Tracker:
                            </span>
                            <span
                              className="zero-config-helper-detail-val"
                              style={{ textTransform: "capitalize" }}
                            >
                              {detectedGitInfo.detected_tracker || "None"}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn-zero-config-apply"
                          onClick={applyDetectedGitSettings}
                        >
                          Apply Auto-Detected Settings
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="setup-form-group">
                    <label className="setup-label">Tracker Provider</label>
                    <select
                      className="setup-select"
                      value={trackerKind}
                      onChange={(e) => handleTrackerKindChange(e.target.value)}
                    >
                      <option value="github">GitHub Issues</option>
                      <option value="gitlab">GitLab Issues</option>
                      <option value="jira">Jira Software</option>
                      <option value="linear">Linear</option>
                      <option value="memory">In-Memory (Local Only)</option>
                    </select>
                  </div>

                  {trackerKind !== "memory" && (
                    <>
                      <div className="setup-form-group">
                        <label className="setup-label">Tracker Endpoint URL</label>
                        <input
                          type="text"
                          className="setup-input"
                          value={trackerEndpoint}
                          onChange={(e) => setTrackerEndpoint(e.target.value)}
                          placeholder="e.g. https://api.github.com"
                        />
                      </div>

                      <div className="setup-form-group">
                        <label className="setup-label">
                          API Key / Token (or Environment Var Reference)
                        </label>
                        <input
                          type="text"
                          className="setup-input"
                          value={trackerApiKey}
                          onChange={(e) => setTrackerApiKey(e.target.value)}
                          placeholder="e.g. $GITHUB_TOKEN or raw token key"
                        />
                        {!trackerApiKey && (
                          <div className="setup-tip-warning">
                            ⚠️ Tracker API key is missing. Prefer an environment variable like
                            <code> $GITHUB_TOKEN</code> over a hardcoded token.
                          </div>
                        )}
                      </div>

                      <div className="setup-form-group">
                        <label className="setup-label">Project Identifier / Slug</label>
                        <input
                          type="text"
                          className="setup-input"
                          value={trackerProjectSlug}
                          onChange={(e) => setTrackerProjectSlug(e.target.value)}
                          placeholder="e.g. drew-simmons/skrvm"
                        />
                      </div>

                      <div className="advanced-settings-row">
                        <div className="setup-form-group">
                          <label className="setup-label">Assignee Scope (optional)</label>
                          <input
                            type="text"
                            className="setup-input"
                            value={trackerAssignee}
                            onChange={(e) => setTrackerAssignee(e.target.value)}
                            placeholder="e.g. $GITHUB_ASSIGNEE or me"
                          />
                        </div>
                        <div className="setup-form-group">
                          <label className="setup-label">Required Labels (opt-in gate)</label>
                          <input
                            type="text"
                            className="setup-input"
                            value={trackerRequiredLabels}
                            onChange={(e) => setTrackerRequiredLabels(e.target.value)}
                            placeholder="e.g. skrvm, automate"
                          />
                        </div>
                      </div>
                      {teamProfile === "large" && !trackerRequiredLabels && (
                        <div className="setup-tip-warning">
                          ⚠️ On a shared tracker, leaving the label gate empty lets Skrvm claim
                          every assigned issue. Add a label like <code>skrvm</code> so only opted-in
                          tickets are picked up.
                        </div>
                      )}

                      <div className="advanced-settings-row">
                        <div className="setup-form-group">
                          <label className="setup-label">Active States (Comma Sep)</label>
                          <input
                            type="text"
                            className="setup-input"
                            value={trackerActiveStates}
                            onChange={(e) => setTrackerActiveStates(e.target.value)}
                            placeholder="Todo, In Progress"
                          />
                        </div>
                        <div className="setup-form-group">
                          <label className="setup-label">Terminal States (Comma Sep)</label>
                          <input
                            type="text"
                            className="setup-input"
                            value={trackerTerminalStates}
                            onChange={(e) => setTrackerTerminalStates(e.target.value)}
                            placeholder="Done, Closed"
                          />
                        </div>
                      </div>
                    </>
                  )}

                  <div
                    className={`verification-card ${step2Verified ? "success" : step2Error ? "failed" : ""}`}
                  >
                    <div className="verification-card-header">
                      <span className="verify-title">Tracker Connection</span>
                      <span className="verify-status">
                        {step2Loading ? (
                          <span className="verify-spinner"></span>
                        ) : step2Verified ? (
                          "✓"
                        ) : (
                          "✗"
                        )}
                      </span>
                    </div>
                    {step2Error && <div className="verify-error-msg">{step2Error}</div>}
                    {step2SuccessMsg && !step2Error && (
                      <div className="verify-success-msg">{step2SuccessMsg}</div>
                    )}
                  </div>
                </div>
              )}

              {/* Step 3: Coding Agent */}
              {wizardStep === 3 && (
                <div className="wizard-step-body">
                  <div className="wizard-step-heading">
                    <span className="wizard-step-title">Coding Agent</span>
                    <span className="wizard-step-subtitle">
                      Choose the agent CLI Skrvm will spawn for each ticket. Detected executables in
                      your PATH are verified automatically.
                    </span>
                  </div>

                  <div className="agent-cards-grid">
                    <div
                      className={`agent-setup-card ${agentSelection === "codex" ? "selected" : ""}`}
                      onClick={() => handleAgentSelectionChange("codex")}
                    >
                      <span className="agent-card-title">Codex</span>
                      <span className="agent-card-desc">Conversational JSON-RPC client</span>
                    </div>
                    <div
                      className={`agent-setup-card ${agentSelection === "kiro" ? "selected" : ""}`}
                      onClick={() => handleAgentSelectionChange("kiro")}
                    >
                      <span className="agent-card-title">Kiro CLI</span>
                      <span className="agent-card-desc">Interactive ACP server</span>
                    </div>
                    <div
                      className={`agent-setup-card ${agentSelection === "antigravity" ? "selected" : ""}`}
                      onClick={() => handleAgentSelectionChange("antigravity")}
                    >
                      <span className="agent-card-title">Antigravity</span>
                      <span className="agent-card-desc">Fast, single-shot execution</span>
                    </div>
                  </div>

                  <div className="advanced-settings-row">
                    <div className="setup-form-group">
                      <label className="setup-label">Custom Command Override</label>
                      <input
                        type="text"
                        className="setup-input"
                        value={agentCommand}
                        onChange={(e) => {
                          setAgentCommand(e.target.value);
                          setAgentSelection("custom");
                        }}
                        placeholder="e.g. codex app-server"
                      />
                    </div>
                    <div className="setup-form-group">
                      <label className="setup-label">Protocol</label>
                      <select
                        className="setup-select"
                        value={agentProtocol}
                        onChange={(e) => {
                          setAgentProtocol(e.target.value);
                          setAgentSelection("custom");
                        }}
                      >
                        <option value="jsonrpc">JSON-RPC (Multi-turn)</option>
                        <option value="oneshot">One-Shot (Single execution)</option>
                      </select>
                    </div>
                  </div>

                  <div
                    className={`verification-card ${step3Verified ? "success" : step3Error ? "failed" : ""}`}
                  >
                    <div className="verification-card-header">
                      <span className="verify-title">Coding Agent PATH</span>
                      <span className="verify-status">
                        {step3Loading ? (
                          <span className="verify-spinner"></span>
                        ) : step3Verified ? (
                          "✓"
                        ) : (
                          "✗"
                        )}
                      </span>
                    </div>
                    {step3Error && <div className="verify-error-msg">{step3Error}</div>}
                    {step3SuccessMsg && !step3Error && (
                      <div className="verify-success-msg">{step3SuccessMsg}</div>
                    )}
                  </div>
                </div>
              )}

              {/* Step 4: Workspace & Hooks */}
              {wizardStep === 4 && (
                <div className="wizard-step-body">
                  <div className="wizard-step-heading">
                    <span className="wizard-step-title">Workspace & Lifecycle</span>
                    <span className="wizard-step-subtitle">
                      Skrvm runs each ticket in an isolated sandbox. Start by choosing how a
                      workspace is sourced and committed, then point Skrvm at the right directories.
                    </span>
                  </div>

                  <div className="section-subtitle">1 · Workspace Lifecycle</div>
                  <div className="preset-cards-grid">
                    <div
                      className={`agent-setup-card ${presetSelection === "local_git" ? "selected" : ""}`}
                      onClick={() => applyPreset("local_git")}
                    >
                      <span className="agent-card-title">Local Branch-Aware Clone</span>
                      <span className="agent-card-desc">
                        Clones from a local project path and works off the current branch.
                      </span>
                    </div>
                    <div
                      className={`agent-setup-card ${presetSelection === "github_remote" ? "selected" : ""}`}
                      onClick={() => applyPreset("github_remote")}
                    >
                      <span className="agent-card-title">Remote GitHub Clone</span>
                      <span className="agent-card-desc">
                        Clones from GitHub and opens a pull request on completion.
                      </span>
                    </div>
                    <div
                      className={`agent-setup-card ${presetSelection === "gitlab_remote" ? "selected" : ""}`}
                      onClick={() => applyPreset("gitlab_remote")}
                    >
                      <span className="agent-card-title">Remote GitLab Clone</span>
                      <span className="agent-card-desc">
                        Clones from GitLab and opens a merge request on completion.
                      </span>
                    </div>
                    <div
                      className={`agent-setup-card ${presetSelection === "local_copy" ? "selected" : ""}`}
                      onClick={() => applyPreset("local_copy")}
                    >
                      <span className="agent-card-title">Local Copy (No Git)</span>
                      <span className="agent-card-desc">
                        Direct rsync copy of a local directory. No branch tracking.
                      </span>
                    </div>
                  </div>

                  <div className="section-subtitle">2 · Directories</div>

                  {detectedGitInfo && (
                    <div className="zero-config-helper-alert" style={{ marginBottom: "0.8rem" }}>
                      <svg
                        className="zero-config-helper-icon"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                      </svg>
                      <div className="zero-config-helper-body">
                        <span className="zero-config-helper-title">Auto-Detected Project Path</span>
                        <span className="zero-config-helper-desc">
                          Your local repository folder checkout was detected at:
                        </span>
                        <div
                          style={{
                            background: "rgba(0, 0, 0, 0.3)",
                            padding: "0.4rem 0.6rem",
                            borderRadius: "4px",
                            fontSize: "0.7rem",
                            fontFamily: "monospace",
                            color: "#a7f3d0",
                            border: "1px solid rgba(255, 255, 255, 0.03)",
                            marginTop: "0.15rem",
                            wordBreak: "break-all",
                          }}
                        >
                          {detectedGitInfo.project_dir}
                        </div>
                        <button
                          type="button"
                          className="btn-zero-config-apply"
                          onClick={() => setProjectDir(detectedGitInfo.project_dir)}
                        >
                          Use Auto-Detected Path
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="advanced-settings-row">
                    {presetIsRemote ? (
                      <div className="setup-form-group">
                        <label className="setup-label">Repository Slug</label>
                        <input
                          type="text"
                          className="setup-input"
                          value={trackerProjectSlug}
                          onChange={(e) => setTrackerProjectSlug(e.target.value)}
                          placeholder="e.g. my-org/my-project"
                        />
                        <span className="setup-field-help">
                          Cloned over SSH from your remote host. No local checkout required.
                        </span>
                      </div>
                    ) : (
                      <div className="setup-form-group">
                        <label className="setup-label">Project Directory</label>
                        <input
                          type="text"
                          className="setup-input"
                          value={projectDir}
                          onChange={(e) => setProjectDir(e.target.value)}
                          placeholder="e.g. /Users/username/dev/project"
                        />
                        <span className="setup-field-help">
                          The local repo Skrvm clones or copies each workspace from.
                        </span>
                      </div>
                    )}
                    <div className="setup-form-group">
                      <label className="setup-label">Sandbox Root Directory</label>
                      <input
                        type="text"
                        className="setup-input"
                        value={workspaceRoot}
                        onChange={(e) => setWorkspaceRoot(e.target.value)}
                        placeholder="e.g. ~/dev/scratch/skrvm/workspaces"
                      />
                      <span className="setup-field-help">
                        Isolated parent folder where per-ticket workspaces are created.
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn-setup-secondary"
                    style={{
                      fontSize: "0.75rem",
                      padding: "0.3rem 0.6rem",
                      marginTop: "0.6rem",
                      alignSelf: "flex-start",
                    }}
                    onClick={() => setShowCustomHooks(!showCustomHooks)}
                  >
                    {showCustomHooks
                      ? "Hide Advanced Hook Scripts ▲"
                      : "Advanced: Edit Hook Scripts ▼"}
                  </button>

                  {showCustomHooks && (
                    <div
                      className="custom-hooks-fields"
                      style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}
                    >
                      <span className="setup-field-help">
                        Shell hooks run inside each workspace. Leave a hook empty to skip it. Use{" "}
                        {"{{ project_dir }}"}, {"{{ project_slug }}"} and{" "}
                        {"{{ issue.branch_name }}"} as template variables.
                      </span>
                      <div className="setup-form-group">
                        <label className="setup-label">Post-Creation Hook (after_create)</label>
                        <input
                          type="text"
                          className="setup-input"
                          value={hooksAfterCreate}
                          onChange={(e) => {
                            setHooksAfterCreate(e.target.value);
                            setPresetSelection("custom");
                          }}
                          placeholder="e.g. git clone {{ project_dir }} . && git checkout -b {{ issue.branch_name }}"
                        />
                      </div>
                      <div className="setup-form-group">
                        <label className="setup-label">Pre-Execution Hook (before_run)</label>
                        <input
                          type="text"
                          className="setup-input"
                          value={hooksBeforeRun}
                          onChange={(e) => {
                            setHooksBeforeRun(e.target.value);
                            setPresetSelection("custom");
                          }}
                          placeholder="e.g. pnpm install · pip install -r requirements.txt · cargo build"
                        />
                        <span className="setup-field-help">
                          Optional dependency setup. Leave blank if your repo needs none.
                        </span>
                      </div>
                      <div className="setup-form-group">
                        <label className="setup-label">Post-Execution Hook (after_run)</label>
                        <input
                          type="text"
                          className="setup-input"
                          value={hooksAfterRun}
                          onChange={(e) => {
                            setHooksAfterRun(e.target.value);
                            setPresetSelection("custom");
                          }}
                          placeholder="e.g. git add . && git commit -m '...' && git push -u origin HEAD:{{ issue.branch_name }}"
                        />
                      </div>
                    </div>
                  )}

                  <div
                    className={`verification-card ${step1Verified ? "success" : step1Error ? "failed" : ""}`}
                  >
                    <div className="verification-card-header">
                      <span className="verify-title">Workspace & Sandbox Safety</span>
                      <span className="verify-status">
                        {step1Loading ? (
                          <span className="verify-spinner"></span>
                        ) : step1Verified ? (
                          "✓"
                        ) : (
                          "✗"
                        )}
                      </span>
                    </div>
                    {step1Error && <div className="verify-error-msg">{step1Error}</div>}
                    {step1SuccessMsg && !step1Error && (
                      <div className="verify-success-msg">{step1SuccessMsg}</div>
                    )}
                  </div>
                </div>
              )}

              {/* Step 5: Review & Initialize */}
              {wizardStep === 5 && (
                <div className="wizard-step-body">
                  <div className="wizard-step-heading">
                    <span className="wizard-step-title">Review & Initialize</span>
                    <span className="wizard-step-subtitle">
                      Confirm the configuration below. All audits must pass before Skrvm can be
                      initialized.
                    </span>
                  </div>

                  <div className="wizard-review-list">
                    <div className="wizard-review-row">
                      <span className="wizard-review-key">Team Profile</span>
                      <span className="wizard-review-val">{teamProfile}</span>
                    </div>
                    <div className="wizard-review-row">
                      <span className="wizard-review-key">Tracker</span>
                      <span className="wizard-review-val">
                        {trackerKind} ({trackerProjectSlug || "no slug"})
                      </span>
                    </div>
                    <div className="wizard-review-row">
                      <span className="wizard-review-key">Worker Scope</span>
                      <span className="wizard-review-val">
                        {agentMaxConcurrent} worker(s)
                        {trackerRequiredLabels ? ` · labels: ${trackerRequiredLabels}` : ""}
                        {trackerAssignee ? ` · assignee: ${trackerAssignee}` : ""}
                      </span>
                    </div>
                    <div className="wizard-review-row">
                      <span className="wizard-review-key">Agent</span>
                      <span className="wizard-review-val">{agentCommand || "None"}</span>
                    </div>
                    <div className="wizard-review-row">
                      <span className="wizard-review-key">Sandbox Root</span>
                      <span className="wizard-review-val">{workspaceRoot || "None"}</span>
                    </div>
                    <div className="wizard-review-row">
                      <span className="wizard-review-key">Env API Key</span>
                      <span
                        className={`wizard-review-val ${trackerApiKey ? "success-text" : "warning-text"}`}
                      >
                        {trackerApiKey ? "Configured" : "Not Found"}
                      </span>
                    </div>
                  </div>

                  <div className="section-subtitle">Automated System Audits</div>
                  <div className="verification-grid">
                    <div
                      className={`verification-card ${step1Verified ? "success" : step1Error ? "failed" : ""}`}
                    >
                      <div className="verification-card-header">
                        <span className="verify-title">1. Workspace & Sandbox</span>
                        <span className="verify-status">
                          {step1Loading ? (
                            <span className="verify-spinner"></span>
                          ) : step1Verified ? (
                            "✓"
                          ) : (
                            "✗"
                          )}
                        </span>
                      </div>
                      {step1Error && <div className="verify-error-msg">{step1Error}</div>}
                    </div>
                    <div
                      className={`verification-card ${step2Verified ? "success" : step2Error ? "failed" : ""}`}
                    >
                      <div className="verification-card-header">
                        <span className="verify-title">2. Tracker Connection</span>
                        <span className="verify-status">
                          {step2Loading ? (
                            <span className="verify-spinner"></span>
                          ) : step2Verified ? (
                            "✓"
                          ) : (
                            "✗"
                          )}
                        </span>
                      </div>
                      {step2Error && <div className="verify-error-msg">{step2Error}</div>}
                    </div>
                    <div
                      className={`verification-card ${step3Verified ? "success" : step3Error ? "failed" : ""}`}
                    >
                      <div className="verification-card-header">
                        <span className="verify-title">3. Coding Agent PATH</span>
                        <span className="verify-status">
                          {step3Loading ? (
                            <span className="verify-spinner"></span>
                          ) : step3Verified ? (
                            "✓"
                          ) : (
                            "✗"
                          )}
                        </span>
                      </div>
                      {step3Error && <div className="verify-error-msg">{step3Error}</div>}
                    </div>
                    <div
                      className={`verification-card ${step4Verified ? "success" : step4Error ? "failed" : ""}`}
                    >
                      <div className="verification-card-header">
                        <span className="verify-title">4. Template Jinja Syntax</span>
                        <span className="verify-status">
                          {step4Loading ? (
                            <span className="verify-spinner"></span>
                          ) : step4Verified ? (
                            "✓"
                          ) : (
                            "✗"
                          )}
                        </span>
                      </div>
                      {step4Error && <div className="verify-error-msg">{step4Error}</div>}
                    </div>
                  </div>

                  <div
                    className="setup-form-group"
                    style={{ display: "flex", flexDirection: "column", marginTop: "0.4rem" }}
                  >
                    <label className="setup-label">WORKFLOW.md Prompt Template</label>
                    <textarea
                      className="setup-textarea"
                      style={{ minHeight: "140px", fontFamily: "monospace", fontSize: "0.75rem" }}
                      value={promptTemplate}
                      onChange={(e) => setPromptTemplate(e.target.value)}
                    />
                    {step4SuccessMsg && !step4Error && (
                      <div className="verify-success-msg">{step4SuccessMsg}</div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="setup-modal-footer">
              <div className="wizard-footer-nav">
                {wizardStep > 1 ? (
                  <button
                    className="btn-setup-secondary"
                    onClick={() => setWizardStep((s) => Math.max(1, s - 1))}
                  >
                    ← Back
                  </button>
                ) : (
                  <button className="btn-setup-secondary" onClick={() => setIsSetupOpen(false)}>
                    Cancel
                  </button>
                )}
                <span className="wizard-step-progress">Step {wizardStep} of 5</span>
              </div>

              {wizardStep < 5 ? (
                <button
                  className="btn-setup-primary"
                  onClick={() => setWizardStep((s) => Math.min(5, s + 1))}
                  disabled={
                    (wizardStep === 2 && !step2Verified) ||
                    (wizardStep === 3 && !step3Verified) ||
                    (wizardStep === 4 && !step1Verified)
                  }
                  title={
                    (wizardStep === 2 && !step2Verified) ||
                    (wizardStep === 3 && !step3Verified) ||
                    (wizardStep === 4 && !step1Verified)
                      ? "Resolve this step's audit before continuing"
                      : "Continue to the next step"
                  }
                >
                  Next →
                </button>
              ) : (
                <button
                  className="btn-setup-success"
                  onClick={handleSaveWorkflow}
                  disabled={
                    isSavingWorkflow ||
                    !(step1Verified && step2Verified && step3Verified && step4Verified)
                  }
                  title={
                    !(step1Verified && step2Verified && step3Verified && step4Verified)
                      ? "All four audits must pass before initializing"
                      : "Save and apply workflow configurations"
                  }
                >
                  {isSavingWorkflow ? "Initializing..." : "Save & Initialize"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const WIZARD_STEPS = ["Team", "Tracker", "Agent", "Workspace", "Review"];

export default App;
