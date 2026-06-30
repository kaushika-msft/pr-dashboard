const STORAGE_KEYS = {
  repos: "pr-dashboard.repos",
  viewerLogin: "pr-dashboard.viewer-login",
  githubToken: "pr-dashboard.github-token",
  boardState: "pr-dashboard.board-state",
  teamUpdates: "pr-dashboard.team-updates",
  dateWindowDays: "pr-dashboard.date-window-days",
  legacyNotes: "pr-dashboard.notes"
};

const DEFAULT_REPO = "microsoft/vscode";

const TRACKED_LABELS = [
  { name: "#sign-off comment", bucket: "attention", description: "Comment added when a PR is ready for review." },
  { name: "Out-of-band", bucket: "blocked", description: "Request to schedule the PR for a specific publishing time." },
  { name: "In CPM Triage", bucket: "attention", description: "The PR is in review by the CPM." },
  { name: "cpm/approved", bucket: "done", description: "The PR is approved by the CPM." },
  { name: "cpm/rejected", bucket: "blocked", description: "The PR is rejected by the CPM." },
  { name: "cpm/on-hold", bucket: "blocked", description: "The PR is kept on hold by the CPM." },
  { name: "Back to submitter", bucket: "blocked", description: "Returned to the contributor for changes." },
  { name: "Large pull request", bucket: "attention", description: "The PR has more than 10 files." },
  { name: "edit/in-progress", bucket: "attention", description: "The PR is in review by a Writer." },
  { name: "In SME Review @ <SME/SME pool>", bucket: "attention", description: "The PR is in technical review." },
  { name: "Extended SME Review", bucket: "attention", description: "The SME has a question for the contributor." },
  { name: "SME Approved", bucket: "done", description: "The PR is reviewed and approved by the SME." },
  { name: "No SME Approval", bucket: "blocked", description: "No SME approved the PR within the SLA timeframe." },
  { name: "Merge large pull request", bucket: "done", description: "The PR is ready to be merged to Main." },
  { name: "Sign off", bucket: "done", description: "The PR is ready to be merged to Main." },
  { name: "Admin review", bucket: "blocked", description: "The PR needs repo admin review." }
];

const TRACKED_LABEL_ORDER = TRACKED_LABELS.map((label) => label.name);
const TRACKED_LABEL_LOOKUP = Object.fromEntries(TRACKED_LABELS.map((label) => [label.name.toLowerCase(), label]));

const STATUS_DEFS = [
  { key: "on-track", label: "On Track", tone: "on-track", description: "Moving as planned" },
  { key: "blocked", label: "Blocked", tone: "blocked", description: "Needs a quick unblock" },
  { key: "attention", label: "Needs Attention", tone: "attention", description: "Watch this closely" },
  { key: "done", label: "Done", tone: "done", description: "Ready to ship or already landed" }
];

const STATUS_LOOKUP = Object.fromEntries(STATUS_DEFS.map((status) => [status.key, status]));

const GITHUB_STATE_DEFS = [
  { key: "draft", label: "Draft", tone: "draft", description: "Work in progress" },
  { key: "open", label: "Open", tone: "open", description: "Ready for review" },
  { key: "merged", label: "Merged", tone: "merged", description: "Completed and merged" },
  { key: "closed", label: "Closed", tone: "closed", description: "Completed without merge" }
];

const GITHUB_STATE_LOOKUP = Object.fromEntries(GITHUB_STATE_DEFS.map((status) => [status.key, status]));

const state = {
  repos: loadJson(STORAGE_KEYS.repos, [DEFAULT_REPO]),
  viewerLogin: localStorage.getItem(STORAGE_KEYS.viewerLogin) || "",
  githubToken: localStorage.getItem(STORAGE_KEYS.githubToken) || "",
  dateWindowDays: clampDateWindow(Number(localStorage.getItem(STORAGE_KEYS.dateWindowDays) || 1)),
  boardState: loadJson(STORAGE_KEYS.boardState, {}),
  teamUpdates: loadJson(STORAGE_KEYS.teamUpdates, []),
  pulls: [],
  filteredPulls: [],
  refreshErrors: [],
  draggedPullId: null
};

const elements = {
  repoForm: document.getElementById("repo-form"),
  repoInput: document.getElementById("repo-input"),
  repoList: document.getElementById("repo-list"),
  repoCount: document.getElementById("repo-count"),
  heroPullCount: document.getElementById("hero-pr-count"),
  statusFilter: document.getElementById("status-filter"),
  labelFilter: document.getElementById("label-filter"),
  searchFilter: document.getElementById("search-filter"),
  dateRange: document.getElementById("date-range"),
  dateRangeValue: document.getElementById("date-range-value"),
  viewerInput: document.getElementById("viewer-input"),
  tokenInput: document.getElementById("token-input"),
  testTokenBtn: document.getElementById("test-token-btn"),
  viewerStatus: document.getElementById("viewer-status"),
  viewFilter: document.getElementById("view-filter"),
  oauthLoginBtn: document.getElementById("oauth-login-btn"),
  detectViewerBtn: document.getElementById("detect-viewer-btn"),
  refreshBtn: document.getElementById("refresh-btn"),
  refreshStatus: document.getElementById("refresh-status"),
  kpiGrid: document.getElementById("kpi-grid"),
  signalGrid: document.getElementById("signal-grid"),
  labelFocusGrid: document.getElementById("label-focus-grid"),
  statusChart: document.getElementById("status-chart"),
  boardColumns: document.getElementById("board-columns"),
  resultCount: document.getElementById("result-count"),
  updateForm: document.getElementById("update-form"),
  updateAuthor: document.getElementById("update-author"),
  updateStatus: document.getElementById("update-status"),
  updateInput: document.getElementById("update-input"),
  updateList: document.getElementById("update-list"),
  assigneeSuggestions: document.getElementById("assignee-suggestions"),
  prCardTemplate: document.getElementById("pr-card-template")
};

init();

function init() {
  migrateLegacyNotes();
  elements.viewerInput.value = state.viewerLogin;
  elements.tokenInput.value = state.githubToken;
  elements.dateRange.value = String(state.dateWindowDays);
  elements.dateRangeValue.textContent = formatDateWindowLabel(state.dateWindowDays);
  elements.updateAuthor.value = state.viewerLogin || "";
  if (usesLocalProxy()) {
    elements.oauthLoginBtn.hidden = false;
    elements.oauthLoginBtn.disabled = false;
    elements.oauthLoginBtn.textContent = "Sign In With GitHub";
    elements.oauthLoginBtn.title = "Start GitHub OAuth login on the local server";
    elements.detectViewerBtn.textContent = "Detect Session User";
  } else {
    elements.oauthLoginBtn.hidden = false;
    elements.oauthLoginBtn.disabled = true;
    elements.oauthLoginBtn.textContent = "OAuth (Local Server Only)";
    elements.oauthLoginBtn.title = "GitHub OAuth is available when running the local server";
    elements.detectViewerBtn.textContent = "Detect With Token";
    if (!state.viewerLogin) {
      setViewerStatus("Enter your GitHub username, or add a token and click Detect With Token.", "");
    }
  }
  bindEvents();
  renderRepos();
  renderTeamUpdates();
  renderAnalytics();
  detectViewer(true);
  refreshAll();
}

function bindEvents() {
  elements.repoForm.addEventListener("submit", onAddRepo);
  elements.refreshBtn.addEventListener("click", refreshAll);
  elements.testTokenBtn.addEventListener("click", onTestTokenAccess);
  elements.oauthLoginBtn.addEventListener("click", onOAuthLogin);
  elements.detectViewerBtn.addEventListener("click", () => detectViewer(false));
  elements.viewerInput.addEventListener("change", onViewerChanged);
  elements.tokenInput.addEventListener("change", onTokenChanged);
  elements.dateRange.addEventListener("input", onDateWindowChanged);
  elements.updateForm.addEventListener("submit", onPostUpdate);

  [elements.statusFilter, elements.labelFilter, elements.searchFilter, elements.viewFilter].forEach((control) => {
    control.addEventListener("input", applyFilters);
    control.addEventListener("change", applyFilters);
  });
}

function onTokenChanged() {
  state.githubToken = elements.tokenInput.value.trim();
  localStorage.setItem(STORAGE_KEYS.githubToken, state.githubToken);

  if (!usesLocalProxy()) {
    if (state.githubToken) {
      setViewerStatus("Token saved. You can use Detect With Token or enter your username manually.", "ok");
      detectViewer(true);
    } else if (!state.viewerLogin) {
      setViewerStatus("Enter your GitHub username, or add a token and click Detect With Token.", "");
    }
  }

  refreshAll();
}

function onOAuthLogin() {
  window.location.assign("/auth/github/login");
}

async function onTestTokenAccess() {
  if (usesLocalProxy()) {
    setStatus("Local mode uses OAuth/CLI session. Token diagnostics are for hosted mode.", "");
    return;
  }

  if (!state.githubToken) {
    setStatus("Enter a GitHub token first, then click Test Token Access.", "error");
    return;
  }

  const reposToCheck = state.repos.length > 0 ? state.repos : [DEFAULT_REPO];
  const failures = [];

  setStatus("Testing token access for tracked repositories...", "");

  for (const repo of reposToCheck) {
    const repoResponse = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: getGitHubHeaders()
    });

    if (!repoResponse.ok) {
      const payload = await safeJson(repoResponse);
      failures.push(`${repo}: repo metadata denied (${repoResponse.status}) - ${payload?.message || "Unknown error"}`);
      continue;
    }

    const pullsResponse = await fetch(`https://api.github.com/repos/${repo}/pulls?state=all&per_page=1`, {
      headers: getGitHubHeaders()
    });

    if (!pullsResponse.ok) {
      const payload = await safeJson(pullsResponse);
      failures.push(`${repo}: pull request read denied (${pullsResponse.status}) - ${payload?.message || "Unknown error"}`);
    }
  }

  if (failures.length === 0) {
    setStatus("Token access check passed for all tracked repositories.", "ok");
    return;
  }

  setStatus(
    `Token access check failed: ${failures.slice(0, 2).join(" | ")} Ensure repo is granted in fine-grained PAT and org SSO is authorized if required.`,
    "error"
  );
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function migrateLegacyNotes() {
  const notes = loadJson(STORAGE_KEYS.legacyNotes, {});
  let changed = false;

  Object.entries(notes).forEach(([pullId, note]) => {
    if (!note) {
      return;
    }

    const record = state.boardState[pullId] || defaultBoardRecord();
    if (!Array.isArray(record.comments) || record.comments.length === 0) {
      record.comments = [
        {
          id: createId("comment"),
          author: "Local note",
          text: String(note),
          createdAt: new Date().toISOString()
        }
      ];
      changed = true;
    }

    state.boardState[pullId] = record;
  });

  if (changed) {
    persistJson(STORAGE_KEYS.boardState, state.boardState);
  }
}

function onViewerChanged() {
  state.viewerLogin = elements.viewerInput.value.trim().toLowerCase();
  localStorage.setItem(STORAGE_KEYS.viewerLogin, state.viewerLogin);
  elements.updateAuthor.value = state.viewerLogin || elements.updateAuthor.value;
  if (state.viewerLogin) {
    setViewerStatus(`Using viewer '${state.viewerLogin}'.`, "ok");
  } else {
    setViewerStatus("Viewer is blank. User-specific views need a GitHub username.", "error");
  }
  applyFilters();
  renderTeamUpdates();
}

function onDateWindowChanged() {
  state.dateWindowDays = clampDateWindow(Number(elements.dateRange.value));
  localStorage.setItem(STORAGE_KEYS.dateWindowDays, String(state.dateWindowDays));
  elements.dateRangeValue.textContent = formatDateWindowLabel(state.dateWindowDays);
  applyFilters();
}

function usesLocalProxy() {
  return ["localhost", "127.0.0.1"].includes(window.location.hostname);
}

function getPullsEndpoint(repo) {
  if (usesLocalProxy()) {
    return `/api/pulls?repo=${encodeURIComponent(repo)}`;
  }

  return `https://api.github.com/repos/${repo}/pulls?state=all&per_page=100&sort=updated&direction=desc`;
}

function getViewerEndpoint() {
  if (usesLocalProxy()) {
    return "/api/me";
  }

  return state.githubToken ? "https://api.github.com/user" : null;
}

function getGitHubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  if (state.githubToken) {
    headers.Authorization = `Bearer ${state.githubToken}`;
  }

  return headers;
}

async function detectViewer(silent) {
  try {
    const endpoint = getViewerEndpoint();

    if (!endpoint) {
      if (!silent && !state.viewerLogin) {
        setViewerStatus("Enter your GitHub username, or add a token and click Detect With Token.", "");
      }
      return;
    }

    const response = await fetch(endpoint, {
      headers: usesLocalProxy() ? {} : getGitHubHeaders()
    });
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!silent) {
        if (usesLocalProxy() && payload?.loginUrl) {
          setViewerStatus("Sign in with GitHub, then click Detect Session User.", "error");
        } else {
          setViewerStatus(
            usesLocalProxy()
              ? "Could not auto-detect viewer from the local session. Enter your GitHub username manually."
              : "Could not detect viewer with this token. Enter your GitHub username manually.",
            ""
          );
        }
      }
      return;
    }

    const me = await response.json();
    if (!me?.login) {
      if (!silent) {
        setViewerStatus("GitHub identity not available from local auth.", "error");
      }
      return;
    }

    state.viewerLogin = String(me.login).trim().toLowerCase();
    elements.viewerInput.value = state.viewerLogin;
    elements.updateAuthor.value = state.viewerLogin;
    localStorage.setItem(STORAGE_KEYS.viewerLogin, state.viewerLogin);
    setViewerStatus(`Detected viewer '${state.viewerLogin}' from GitHub session.`, "ok");
    applyFilters();
    renderTeamUpdates();
  } catch {
    if (!silent) {
      setViewerStatus("Failed to detect viewer from GitHub session.", "error");
    }
  }
}

function onAddRepo(event) {
  event.preventDefault();
  const repo = elements.repoInput.value.trim().toLowerCase();

  if (!isValidRepoName(repo)) {
    alert("Repository must be in the format owner/repo.");
    return;
  }

  if (state.repos.includes(repo)) {
    alert("Repository already tracked.");
    return;
  }

  state.repos.push(repo);
  persistJson(STORAGE_KEYS.repos, state.repos);
  elements.repoInput.value = "";
  renderRepos();
  refreshAll();
}

function renderRepos() {
  elements.repoList.innerHTML = "";
  elements.repoCount.textContent = String(state.repos.length);

  state.repos.forEach((repo) => {
    const item = document.createElement("li");
    item.className = "repo-item";

    const name = document.createElement("span");
    name.textContent = repo;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      state.repos = state.repos.filter((r) => r !== repo);
      persistJson(STORAGE_KEYS.repos, state.repos);
      renderRepos();
      refreshAll();
    });

    item.append(name, removeBtn);
    elements.repoList.append(item);
  });
}

async function refreshAll() {
  if (state.repos.length === 0) {
    state.pulls = [];
    state.refreshErrors = [];
    setStatus("No repositories selected.", "");
    applyFilters();
    renderAnalytics();
    renderBoard();
    return;
  }

  setStatus("Refreshing pull requests...", "");
  elements.refreshBtn.textContent = "Refreshing...";
  elements.refreshBtn.disabled = true;

  try {
    const firstPass = await Promise.allSettled(state.repos.map((repo) => fetchRepoPulls(repo)));
    const successful = firstPass.filter((result) => result.status === "fulfilled").map((result) => result.value);
    const failed = firstPass.filter((result) => result.status === "rejected").map((result) => result.reason);

    state.pulls = successful.flat();
    state.refreshErrors = failed;

    syncBoardState(state.pulls);
    buildLabelOptions();
    buildAssigneeSuggestions();
    applyFilters();
    renderAnalytics();
    renderTeamUpdates();

    if (failed.length === 0) {
      setStatus(`Refresh complete. Loaded ${state.pulls.length} pull requests.`, "ok");
    } else {
      const details = failed
        .slice(0, 3)
        .map((error) => error.message)
        .join(" | ");
      const needsAuth = failed.some((error) => shouldPromptForCredentials(error));
      const classicPatPolicyError = failed.some((error) =>
        /forbids access via a personal access tokens \(classic\)/i.test(error?.message || "")
      );
      const hostedTokenRepoAccessError =
        !usesLocalProxy() &&
        Boolean(state.githubToken) &&
        failed.some((error) => Number(error?.status) === 404);
      const authGuidance = needsAuth
        ? usesLocalProxy()
          ? " Sign in with GitHub using the Sign In With GitHub button, then refresh."
          : classicPatPolicyError
            ? " This org blocks long-lived classic PATs. Use a fine-grained token, or create a classic PAT with an expiration of 8 days or less, then update the token in Filters."
            : hostedTokenRepoAccessError
              ? " Token sign-in worked, but this token cannot read the repo. For fine-grained PAT: add this repository and grant Pull requests: Read + Metadata: Read. For classic PAT: authorize the token for org SSO, then refresh."
              : " This repository may be private. Add a GitHub token in Filters or check the repository name."
        : "";
      setStatus(
        `Loaded ${state.pulls.length} PRs with ${failed.length} repo error(s): ${details}${authGuidance}`,
        "error"
      );
    }
  } catch (error) {
    console.error(error);
    setStatus("Unexpected refresh error. Please retry.", "error");
  } finally {
    elements.refreshBtn.textContent = "Refresh Data";
    elements.refreshBtn.disabled = false;
  }
}

async function fetchRepoPulls(repo) {
  const endpoint = getPullsEndpoint(repo);
  const response = await fetch(endpoint, {
    headers: usesLocalProxy() ? {} : getGitHubHeaders()
  });

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const message = payload?.message
      ? `${repo}: ${payload.message}`
      : `Failed to load ${repo} (${response.status})`;

    const detailParts = [payload?.details, payload?.hint].filter(Boolean);
    const details = detailParts.length ? ` - ${detailParts.join(" | ")}` : "";
    const error = new Error(`${message}${details}`);
    error.repo = repo;
    error.status = Number(payload?.status || response.status);
    error.details = payload?.details || "";
    throw error;
  }

  const pulls = await response.json();

  return pulls.map((pr) => ({
    id: `${repo}#${pr.number}`,
    repo,
    number: pr.number,
    title: pr.title,
    author: pr.user?.login || "unknown",
    githubStatus: getGithubStatus(pr),
    workflowStatus: deriveInitialWorkflowStatus(pr),
    labels: pr.labels || [],
    assignees: (pr.assignees || []).map((user) => (user?.login || "").toLowerCase()).filter(Boolean),
    requestedReviewers: (pr.requested_reviewers || [])
      .map((user) => (user?.login || "").toLowerCase())
      .filter(Boolean),
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    htmlUrl: pr.html_url
  }));
}

function getGithubStatus(pr) {
  if (pr.draft) {
    return "draft";
  }
  if (pr.merged_at) {
    return "merged";
  }
  if (pr.state === "open") {
    return "open";
  }
  return "closed";
}

function deriveInitialWorkflowStatus(pr) {
  if (pr.merged_at || pr.state === "closed") {
    return "done";
  }

  const labelNames = (pr.labels || []).map((label) => String(label.name || "").toLowerCase());

  if (labelNames.some((label) => matchesTrackedLabel(label, "done"))) {
    return "done";
  }

  if (labelNames.some((label) => matchesTrackedLabel(label, "blocked") || /blocked|hold|waiting/i.test(label))) {
    return "blocked";
  }

  if (labelNames.some((label) => matchesTrackedLabel(label, "attention") || /attention|at-risk|risk|triage/i.test(label))) {
    return "attention";
  }

  return "on-track";
}

function syncBoardState(pulls) {
  const touched = new Set();

  pulls.forEach((pr) => {
    const existing = state.boardState[pr.id] || defaultBoardRecord();
    const legacyComment = state.boardState[pr.id]?.comments?.length
      ? []
      : migratePullNote(pr.id);

    state.boardState[pr.id] = {
      workflowStatus: STATUS_LOOKUP[existing.workflowStatus] ? existing.workflowStatus : pr.workflowStatus,
      assignee: existing.assignee || inferAssignee(pr),
      comments: normalizeComments(existing.comments || legacyComment),
      updatedAt: existing.updatedAt || pr.updatedAt
    };
    touched.add(pr.id);
  });

  Object.keys(state.boardState).forEach((key) => {
    if (!touched.has(key)) {
      return;
    }
  });

  persistJson(STORAGE_KEYS.boardState, state.boardState);
}

function migratePullNote(pullId) {
  const notes = loadJson(STORAGE_KEYS.legacyNotes, {});
  const note = notes[pullId];

  if (!note) {
    return [];
  }

  return [
    {
      id: createId("comment"),
      author: "Local note",
      text: String(note),
      createdAt: new Date().toISOString()
    }
  ];
}

function normalizeComments(comments) {
  if (!Array.isArray(comments)) {
    return [];
  }

  return comments
    .filter(Boolean)
    .map((comment) => ({
      id: comment.id || createId("comment"),
      author: String(comment.author || "Team"),
      text: String(comment.text || comment.body || "").trim(),
      createdAt: comment.createdAt || comment.created_at || new Date().toISOString()
    }))
    .filter((comment) => comment.text.length > 0);
}

function defaultBoardRecord() {
  return {
    workflowStatus: "on-track",
    assignee: "",
    comments: [],
    updatedAt: new Date().toISOString()
  };
}

function inferAssignee(pr) {
  return pr.assignees[0] || pr.requestedReviewers[0] || "";
}

function buildLabelOptions() {
  const selected = elements.labelFilter.value;
  const allLabels = new Set();

  TRACKED_LABEL_ORDER.forEach((label) => allLabels.add(label));
  state.pulls.forEach((pr) => {
    pr.labels.forEach((label) => allLabels.add(label.name));
  });

  const sorted = [...allLabels].sort((a, b) => {
    const aIndex = TRACKED_LABEL_ORDER.indexOf(a);
    const bIndex = TRACKED_LABEL_ORDER.indexOf(b);

    if (aIndex !== -1 || bIndex !== -1) {
      if (aIndex === -1) {
        return 1;
      }
      if (bIndex === -1) {
        return -1;
      }
      return aIndex - bIndex;
    }

    return a.localeCompare(b);
  });

  elements.labelFilter.innerHTML = `<option value="all">All Labels</option>${sorted
    .map((label) => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`)
    .join("")}`;

  elements.labelFilter.value = sorted.includes(selected) ? selected : "all";
}

function buildAssigneeSuggestions() {
  const suggestions = new Set();

  if (state.viewerLogin) {
    suggestions.add(state.viewerLogin);
  }

  state.pulls.forEach((pr) => {
    if (pr.author) {
      suggestions.add(pr.author);
    }

    pr.assignees.forEach((assignee) => suggestions.add(assignee));
    pr.requestedReviewers.forEach((reviewer) => suggestions.add(reviewer));

    const record = state.boardState[pr.id];
    if (record?.assignee) {
      suggestions.add(record.assignee);
    }
  });

  elements.assigneeSuggestions.innerHTML = [...suggestions]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((value) => `<option value="${escapeHtml(value)}"></option>`)
    .join("");
}

function applyFilters() {
  const status = elements.statusFilter.value;
  const label = elements.labelFilter.value;
  const search = elements.searchFilter.value.trim().toLowerCase();
  const viewFilter = elements.viewFilter.value;
  const viewer = state.viewerLogin.trim().toLowerCase();
  const cutoff = Date.now() - state.dateWindowDays * 24 * 60 * 60 * 1000;

  if (viewFilter !== "all" && !viewer) {
    setViewerStatus("Enter your GitHub username to use My View filters.", "");
  }

  state.filteredPulls = state.pulls
    .filter((pr) => {
      const workflowStatus = getWorkflowStatus(pr.id);
      const activityDate = new Date(pr.updatedAt || pr.createdAt || 0).getTime();

      if (!Number.isNaN(activityDate) && activityDate < cutoff) {
        return false;
      }

      if (status !== "all" && pr.githubStatus !== status) {
        return false;
      }

      if (label !== "all" && !pr.labels.some((l) => l.name === label)) {
        return false;
      }

      if (!matchesViewerFilter(pr, viewFilter, viewer)) {
        return false;
      }

      if (!search) {
        return true;
      }

      const assignee = getBoardRecord(pr.id).assignee || "";
      const haystack = `${pr.title} ${pr.author} ${pr.repo} ${assignee}`.toLowerCase();
      return haystack.includes(search);
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  renderAnalytics();
  renderBoard();
}

function renderAnalytics() {
  const counts = getGithubStateCounts(state.filteredPulls);
  const total = state.filteredPulls.length;

  elements.resultCount.textContent = `${total} visible PR${total === 1 ? "" : "s"}`;
  elements.heroPullCount.textContent = String(total);
  elements.dateRangeValue.textContent = formatDateWindowLabel(state.dateWindowDays);

  const tiles = [
    { title: "Tracked Repos", value: state.repos.length, tone: "neutral" },
    { title: "Visible PRs", value: total, tone: "neutral" },
    { title: "Draft", value: counts.draft, tone: "attention" },
    { title: "Open", value: counts.open, tone: "on-track" },
    { title: "Merged", value: counts.merged, tone: "done" },
    { title: "Closed", value: counts.closed, tone: "blocked" }
  ];

  elements.kpiGrid.innerHTML = tiles
    .map(
      (tile) => `
        <article class="kpi kpi-${tile.tone}">
          <p>${escapeHtml(tile.title)}</p>
          <strong>${escapeHtml(String(tile.value))}</strong>
        </article>
      `
    )
    .join("");

  const signalStatuses = STATUS_DEFS.slice(0, 3);
  elements.signalGrid.innerHTML = signalStatuses
    .map((status) => renderSignalCard(status, state.filteredPulls.filter((pr) => getWorkflowStatus(pr.id) === status.key)))
    .join("");

  elements.labelFocusGrid.innerHTML = renderTrackedLabelCards();

  elements.statusChart.innerHTML = renderStatusChart(counts);
}

function renderTrackedLabelCards() {
  const labelCounts = getTrackedLabelCounts(state.pulls);

  return TRACKED_LABELS.map((label) => {
    const count = labelCounts[label.name] || 0;
    return `
      <article class="tracked-label-card tracked-${label.bucket}">
        <p>${escapeHtml(label.name)}</p>
        <strong>${count}</strong>
        <span>${escapeHtml(label.description)}</span>
      </article>
    `;
  }).join("");
}

function renderSignalCard(status, pulls) {
  const labelSummary = topLabelsForPulls(pulls)
    .slice(0, 2)
    .map((entry) => `<span class="signal-label">${escapeHtml(entry.name)} · ${entry.count}</span>`)
    .join("");

  return `
    <article class="signal-card signal-${status.tone}">
      <p>${escapeHtml(status.label)}</p>
      <strong>${pulls.length}</strong>
      <span>${escapeHtml(status.description)}</span>
      <div class="signal-label-row">${labelSummary || '<span class="signal-label muted">No labels yet</span>'}</div>
    </article>
  `;
}

function renderStatusChart(counts) {
  const maxValue = Math.max(...GITHUB_STATE_DEFS.map((status) => counts[status.key] || 0), 1);
  const width = 720;
  const height = 220;
  const chartTop = 34;
  const barHeight = 24;
  const gap = 26;
  const left = 180;
  const barMaxWidth = 470;

  const bars = GITHUB_STATE_DEFS.map((status, index) => {
    const value = counts[status.key] || 0;
    const y = chartTop + index * gap;
    const barWidth = value === 0 ? 12 : Math.max(14, (value / maxValue) * barMaxWidth);
    const percent = state.filteredPulls.length ? Math.round((value / state.filteredPulls.length) * 100) : 0;
    const accent = githubStateColor(status.key);

    return `
      <g>
        <text x="16" y="${y + 16}" class="chart-label">${escapeHtml(status.label)}</text>
        <rect x="${left}" y="${y}" rx="12" ry="12" width="${barMaxWidth}" height="${barHeight}" fill="rgba(17, 42, 70, 0.08)"></rect>
        <rect x="${left}" y="${y}" rx="12" ry="12" width="${barWidth}" height="${barHeight}" fill="${accent}"></rect>
        <text x="${left + barMaxWidth + 16}" y="${y + 16}" class="chart-value">${value} (${percent}%)</text>
      </g>
    `;
  }).join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" class="status-chart-svg" role="img" aria-label="Pull request status distribution">
      <defs>
        <linearGradient id="chartGlow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#e9f5ff" />
          <stop offset="100%" stop-color="#f3fbff" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" rx="22" fill="url(#chartGlow)"></rect>
      ${bars}
    </svg>
  `;
}

function renderBoard() {
  if (state.filteredPulls.length === 0) {
    elements.boardColumns.innerHTML = `<p class="empty-state">No pull requests match the current filters. Try changing the status, label, or search criteria.</p>`;
    return;
  }

  const grouped = groupByGithubState(state.filteredPulls);

  elements.boardColumns.innerHTML = GITHUB_STATE_DEFS.map((status) => {
    const pulls = grouped[status.key] || [];
    return `
      <section class="board-column" data-status="${status.key}">
        <div class="column-head">
          <div>
            <p>${escapeHtml(status.label)}</p>
            <span>${escapeHtml(status.description)}</span>
          </div>
          <strong>${pulls.length}</strong>
        </div>
        <div class="drop-zone" data-drop-status="${status.key}"></div>
      </section>
    `;
  }).join("");

  elements.boardColumns.querySelectorAll(".drop-zone").forEach((zone) => {
    zone.addEventListener("dragover", onColumnDragOver);
    zone.addEventListener("drop", onColumnDrop);
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  });

  GITHUB_STATE_DEFS.forEach((status) => {
    const zone = elements.boardColumns.querySelector(`.drop-zone[data-drop-status="${status.key}"]`);
    const pulls = grouped[status.key] || [];

    pulls.forEach((pr) => {
      zone.append(createPullCard(pr));
    });
  });

  updateDndTargets();
}

function createPullCard(pr) {
  const card = elements.prCardTemplate.content.firstElementChild.cloneNode(true);
  const record = getBoardRecord(pr.id);

  card.dataset.pullId = pr.id;
  card.dataset.workflowStatus = record.workflowStatus;
  card.dataset.githubStatus = pr.githubStatus;
  card.querySelector(".repo-pill").textContent = `${pr.repo} #${pr.number}`;

  const statusEl = card.querySelector(".status-pill");
  statusEl.textContent = pr.githubStatus.toUpperCase();
  statusEl.classList.add(`gh-status-${pr.githubStatus}`);

  card.querySelector(".pr-title").textContent = pr.title;
  card.querySelector(".meta").textContent = `@${pr.author} · Updated ${new Date(pr.updatedAt).toLocaleString()}`;

  const labelsWrap = card.querySelector(".labels");
  labelsWrap.innerHTML = pr.labels.length
    ? pr.labels
        .map(
          (label) =>
            `<span class="label-tag" style="background:#${safeColor(label.color)}">${escapeHtml(label.name)}</span>`
        )
        .join("")
    : `<span class="label-tag label-empty">No labels</span>`;

  const assigneeInput = card.querySelector(".assignee-input");
  const assignBtn = card.querySelector(".assign-btn");
  const assignmentChip = card.querySelector(".assignment-chip");
  assigneeInput.value = record.assignee || "";
  assignmentChip.textContent = record.assignee ? `Assigned to ${record.assignee}` : "Unassigned";

  assignBtn.addEventListener("click", () => {
    saveAssignee(pr.id, assigneeInput.value);
    assignmentChip.textContent = assigneeInput.value.trim() ? `Assigned to ${assigneeInput.value.trim()}` : "Unassigned";
    buildAssigneeSuggestions();
  });

  assigneeInput.addEventListener("change", () => {
    saveAssignee(pr.id, assigneeInput.value);
    assignmentChip.textContent = assigneeInput.value.trim() ? `Assigned to ${assigneeInput.value.trim()}` : "Unassigned";
    buildAssigneeSuggestions();
  });

  const statusSelect = card.querySelector(".status-select");
  statusSelect.value = pr.githubStatus;
  statusSelect.title = "Synced from GitHub";

  const commentList = card.querySelector(".comment-list");
  const commentCount = card.querySelector(".comment-count");
  renderCommentList(commentList, commentCount, record.comments);

  const commentForm = card.querySelector(".comment-form");
  const commentAuthor = card.querySelector(".comment-author");
  const commentInput = card.querySelector(".comment-input");
  commentAuthor.value = state.viewerLogin || "";

  commentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const author = commentAuthor.value.trim() || state.viewerLogin || "Team";
    const text = commentInput.value.trim();
    if (!text) {
      return;
    }

    addComment(pr.id, author, text);
    commentInput.value = "";
  });

  const actions = card.querySelector(".actions");
  actions.append(
    createActionLink("Open PR", pr.htmlUrl),
    createActionLink("Files", `${pr.htmlUrl}/files`),
    createActionLink("Checks", `${pr.htmlUrl}/checks`),
    createCopyButton(pr.htmlUrl)
  );

  card.addEventListener("dragstart", (event) => {
    state.draggedPullId = pr.id;
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", pr.id);
  });

  card.addEventListener("dragend", () => {
    state.draggedPullId = null;
    card.classList.remove("dragging");
    elements.boardColumns.querySelectorAll(".drag-over").forEach((zone) => zone.classList.remove("drag-over"));
  });

  return card;
}

function renderCommentList(container, counter, comments) {
  const items = normalizeComments(comments).slice(-3).reverse();
  counter.textContent = `${items.length} note${items.length === 1 ? "" : "s"}`;

  if (items.length === 0) {
    container.innerHTML = `<p class="empty-comments">No comments yet. Add the first update.</p>`;
    return;
  }

  container.innerHTML = items
    .map(
      (comment) => `
        <article class="comment-item">
          <header>
            <strong>${escapeHtml(comment.author)}</strong>
            <span>${escapeHtml(formatRelativeTime(comment.createdAt))}</span>
          </header>
          <p>${escapeHtml(comment.text)}</p>
        </article>
      `
    )
    .join("");
}

function renderTeamUpdates() {
  const updates = [...state.teamUpdates].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (updates.length === 0) {
    elements.updateList.innerHTML = `<p class="empty-state compact">No team updates yet. Post a quick status note to keep everyone aligned.</p>`;
    return;
  }

  elements.updateList.innerHTML = updates
    .slice(0, 8)
    .map(
      (update) => `
        <article class="update-item update-${escapeHtml(update.status)}">
          <div class="update-top">
            <strong>${escapeHtml(update.author)}</strong>
            <span>${escapeHtml(STATUS_LOOKUP[update.status]?.label || update.status)}</span>
          </div>
          <p>${escapeHtml(update.text)}</p>
          <time>${escapeHtml(formatRelativeTime(update.createdAt))}</time>
        </article>
      `
    )
    .join("");
}

function onPostUpdate(event) {
  event.preventDefault();
  const author = elements.updateAuthor.value.trim() || state.viewerLogin || "Team";
  const status = elements.updateStatus.value;
  const text = elements.updateInput.value.trim();

  if (!text) {
    return;
  }

  state.teamUpdates.unshift({
    id: createId("update"),
    author,
    status,
    text,
    createdAt: new Date().toISOString()
  });

  state.teamUpdates = state.teamUpdates.slice(0, 20);
  persistJson(STORAGE_KEYS.teamUpdates, state.teamUpdates);
  elements.updateInput.value = "";
  renderTeamUpdates();
}

function updateWorkflowStatus(pullId, workflowStatus) {
  const record = getBoardRecord(pullId);
  record.workflowStatus = workflowStatus;
  record.updatedAt = new Date().toISOString();
  state.boardState[pullId] = record;
  persistJson(STORAGE_KEYS.boardState, state.boardState);
  applyFilters();
}

function saveAssignee(pullId, assignee) {
  const record = getBoardRecord(pullId);
  record.assignee = assignee.trim().toLowerCase();
  record.updatedAt = new Date().toISOString();
  state.boardState[pullId] = record;
  persistJson(STORAGE_KEYS.boardState, state.boardState);
  applyFilters();
}

function addComment(pullId, author, text) {
  const record = getBoardRecord(pullId);
  record.comments = normalizeComments(record.comments);
  record.comments.push({
    id: createId("comment"),
    author,
    text,
    createdAt: new Date().toISOString()
  });
  record.updatedAt = new Date().toISOString();
  state.boardState[pullId] = record;
  persistJson(STORAGE_KEYS.boardState, state.boardState);
  applyFilters();
}

function getBoardRecord(pullId) {
  if (!state.boardState[pullId]) {
    state.boardState[pullId] = defaultBoardRecord();
  }

  const record = state.boardState[pullId];
  record.workflowStatus = STATUS_LOOKUP[record.workflowStatus] ? record.workflowStatus : "on-track";
  record.assignee = String(record.assignee || "").trim().toLowerCase();
  record.comments = normalizeComments(record.comments);

  return record;
}

function groupByGithubState(pulls) {
  return pulls.reduce((groups, pr) => {
    const status = pr.githubStatus || "open";
    if (!groups[status]) {
      groups[status] = [];
    }
    groups[status].push(pr);
    return groups;
  }, {});
}

function getWorkflowStatus(pullId) {
  return getBoardRecord(pullId).workflowStatus;
}

function getGithubStateCounts(pulls) {
  const counts = GITHUB_STATE_DEFS.reduce((accumulator, status) => {
    accumulator[status.key] = 0;
    return accumulator;
  }, {});

  pulls.forEach((pr) => {
    const status = GITHUB_STATE_LOOKUP[pr.githubStatus] ? pr.githubStatus : "open";
    counts[status] = (counts[status] || 0) + 1;
  });

  return counts;
}

function getStatusCounts(pulls) {
  const counts = STATUS_DEFS.reduce((accumulator, status) => {
    accumulator[status.key] = 0;
    return accumulator;
  }, {});

  pulls.forEach((pr) => {
    const workflowStatus = getWorkflowStatus(pr.id);
    counts[workflowStatus] = (counts[workflowStatus] || 0) + 1;
  });

  return counts;
}

function topLabelsForPulls(pulls) {
  const tally = new Map();

  pulls.forEach((pr) => {
    pr.labels.forEach((label) => {
      tally.set(label.name, (tally.get(label.name) || 0) + 1);
    });
  });

  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

function topObservedLabels(pulls) {
  const tally = new Map();

  pulls.forEach((pr) => {
    pr.labels.forEach((label) => {
      tally.set(label.name, (tally.get(label.name) || 0) + 1);
    });
  });

  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

function getTrackedLabelCounts(pulls) {
  const counts = Object.fromEntries(TRACKED_LABELS.map((label) => [label.name, 0]));

  pulls.forEach((pr) => {
    pr.labels.forEach((label) => {
      if (Object.prototype.hasOwnProperty.call(counts, label.name)) {
        counts[label.name] += 1;
      }
    });
  });

  return counts;
}

function matchesTrackedLabel(labelName, bucket) {
  const tracked = TRACKED_LABEL_LOOKUP[String(labelName || "").trim().toLowerCase()];
  return Boolean(tracked && tracked.bucket === bucket);
}

function updateDndTargets() {
  elements.boardColumns.querySelectorAll(".drop-zone").forEach((zone) => {
    zone.addEventListener("dragover", onColumnDragOver);
    zone.addEventListener("drop", onColumnDrop);
  });
}

function onColumnDragOver(event) {
  event.preventDefault();
  event.currentTarget.classList.add("drag-over");
  event.dataTransfer.dropEffect = "move";
}

function onColumnDrop(event) {
  event.preventDefault();
  const target = event.currentTarget;
  target.classList.remove("drag-over");

  const pullId = state.draggedPullId || event.dataTransfer.getData("text/plain");
  const status = target.dataset.dropStatus;

  if (!pullId || !status) {
    return;
  }

  updateWorkflowStatus(pullId, status);
}

function createActionLink(text, url) {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = text;
  return link;
}

function createCopyButton(value) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Copy URL";
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(value);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy URL";
    }, 900);
  });
  return button;
}

function statusColor(status) {
  const colors = {
    "on-track": "#1a936f",
    blocked: "#d33f49",
    attention: "#b08900",
    done: "#2156c0"
  };

  return colors[status] || colors["on-track"];
}

function githubStateColor(status) {
  const colors = {
    draft: "#5b5fc7",
    open: "#1a936f",
    merged: "#2156c0",
    closed: "#d33f49"
  };

  return colors[status] || colors.open;
}

function safeColor(color) {
  const cleaned = (color || "8093a5").replace(/[^0-9a-f]/gi, "");
  return cleaned.length === 6 ? cleaned : "8093a5";
}

function isValidRepoName(value) {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value);
}

function loadJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    if (!value) {
      return fallback;
    }
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function persistJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatRelativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "just now";
  }

  const delta = date.getTime() - Date.now();
  const minutes = Math.round(Math.abs(delta) / 60000);

  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ${delta < 0 ? "ago" : "from now"}`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${delta < 0 ? "ago" : "from now"}`;
  }

  const days = Math.round(hours / 24);
  return `${days}d ${delta < 0 ? "ago" : "from now"}`;
}

function formatDateWindowLabel(days) {
  return days >= 365 ? `${Math.round(days / 365)}y` : `${days}d`;
}

function clampDateWindow(days) {
  if (!Number.isFinite(days)) {
    return 1;
  }

  return Math.min(365, Math.max(1, Math.round(days)));
}

function setStatus(message, type) {
  elements.refreshStatus.textContent = message;
  elements.refreshStatus.classList.remove("ok", "error");
  if (type) {
    elements.refreshStatus.classList.add(type);
  }
}

function shouldPromptForCredentials(error) {
  if (!error || typeof error.status !== "number") {
    return false;
  }
  return error.status === 401 || error.status === 403 || error.status === 404;
}

function matchesViewerFilter(pr, viewFilter, viewer) {
  if (viewFilter === "all") {
    return true;
  }

  if (!viewer) {
    return false;
  }

  const author = (pr.author || "").toLowerCase();
  const record = getBoardRecord(pr.id);

  if (viewFilter === "authored") {
    return author === viewer;
  }

  if (viewFilter === "assigned") {
    return record.assignee === viewer || pr.assignees.includes(viewer);
  }

  if (viewFilter === "review") {
    return getWorkflowStatus(pr.id) !== "done" && author !== viewer && pr.requestedReviewers.includes(viewer);
  }

  return true;
}

function setViewerStatus(message, type) {
  elements.viewerStatus.textContent = message;
  elements.viewerStatus.classList.remove("ok", "error");
  if (type) {
    elements.viewerStatus.classList.add(type);
  }
}

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
