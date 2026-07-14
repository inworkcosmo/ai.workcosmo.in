import { auth, signOut } from "./firebase.js";
import { getCompanyId, initAuthGuard } from "./auth-guard.js";

const state = {
  companyId: "",
  company: null,
  profile: null,
  creditsRemaining: 0,
  conversationId: null,
  conversations: [],
  sending: false,
  editingConversationId: null,
  searchQuery: ""
};

let currentAbortController = null;

const els = {
  workspaceTitle: document.getElementById("workspace-title"),
  userLabel: document.getElementById("user-label"),
  creditsLabel: document.getElementById("credits-label"),
  conversationList: document.getElementById("conversation-list"),
  messages: document.getElementById("messages"),
  emptyState: document.getElementById("empty-state"),
  composerForm: document.getElementById("composer-form"),
  composerInput: document.getElementById("composer-input"),
  sendBtn: document.getElementById("send-btn"),
  newChatBtn: document.getElementById("new-chat-btn"),
  signOutBtn: document.getElementById("sign-out-btn"),
  conversationSearch: document.getElementById("conversation-search"),
  memoryBtn: document.getElementById("memory-btn"),
  memoryCountBadge: document.getElementById("memory-count-badge"),
  memoryModal: document.getElementById("memory-modal"),
  closeMemoryModal: document.getElementById("close-memory-modal"),
  memoryList: document.getElementById("memory-list"),
  voiceBtn: document.getElementById("voice-btn"),
  stopBtn: document.getElementById("stop-btn"),
  stopContainer: document.getElementById("stop-generation-container"),
  scrollBottomBtn: document.getElementById("scroll-bottom-btn"),
  exportBtn: document.getElementById("export-chat-btn")
};

function apiBase() {
  const host = window.location.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") {
    return "https://ai.workcosmo.in";
  }
  return "";
}

async function authHeaders() {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken(true);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text || `Server error (${res.status})`);
  }
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseInlineMarkdown(text) {
  let escaped = escapeHtml(text);
  
  // Bold **text**
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  
  // Italic *text*
  escaped = escaped.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  
  // Inline code `code`
  escaped = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
  
  // Links [text](url)
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  
  return escaped;
}

function parseMarkdown(text = "") {
  const lines = text.split("\n");
  const htmlResult = [];
  let inUnorderedList = false;
  let inOrderedList = false;
  let inCodeBlock = false;
  let inTable = false;
  let tableHeader = true;
  let codeBlockContent = [];
  let codeBlockLang = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code blocks
    if (trimmed.startsWith("```")) {
      if (inTable) { htmlResult.push("</tbody></table>"); inTable = false; }
      if (inUnorderedList) { htmlResult.push("</ul>"); inUnorderedList = false; }
      if (inOrderedList) { htmlResult.push("</ol>"); inOrderedList = false; }
      if (inCodeBlock) {
        inCodeBlock = false;
        const codeText = escapeHtml(codeBlockContent.join("\n"));
        htmlResult.push(`
          <div class="code-block-wrapper">
            <div class="code-block-header">
              <span class="code-block-lang">${codeBlockLang || 'code'}</span>
              <button class="copy-code-btn" type="button"><i class="far fa-copy"></i> Copy</button>
            </div>
            <pre class="code-block"><code class="${codeBlockLang ? 'language-' + codeBlockLang : ''}">${codeText}</code></pre>
          </div>
        `);
        codeBlockContent = [];
        codeBlockLang = "";
      } else {
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Markdown Table parsing
    const isTableLine = trimmed.startsWith("|") && trimmed.endsWith("|");
    if (isTableLine) {
      if (inUnorderedList) { htmlResult.push("</ul>"); inUnorderedList = false; }
      if (inOrderedList) { htmlResult.push("</ol>"); inOrderedList = false; }
      
      const cells = trimmed.split("|").slice(1, -1).map(c => c.trim());
      const isSeparator = cells.every(c => /^:?-+:?$/.test(c));
      
      if (isSeparator) {
        tableHeader = false;
        continue;
      }
      
      if (!inTable) {
        inTable = true;
        tableHeader = true;
        htmlResult.push("<table><thead>");
      }
      
      if (tableHeader) {
        htmlResult.push("<tr>" + cells.map(c => `<th>${parseInlineMarkdown(c)}</th>`).join("") + "</tr>");
        htmlResult.push("</thead><tbody>");
        tableHeader = false;
      } else {
        htmlResult.push("<tr>" + cells.map(c => `<td>${parseInlineMarkdown(c)}</td>`).join("") + "</tr>");
      }
      continue;
    } else {
      if (inTable) {
        htmlResult.push("</tbody></table>");
        inTable = false;
      }
    }

    // Horizontal Rule
    if (trimmed === "---" || trimmed === "***" || trimmed === "___") {
      if (inUnorderedList) { htmlResult.push("</ul>"); inUnorderedList = false; }
      if (inOrderedList) { htmlResult.push("</ol>"); inOrderedList = false; }
      htmlResult.push("<hr>");
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (inUnorderedList) { htmlResult.push("</ul>"); inUnorderedList = false; }
      if (inOrderedList) { htmlResult.push("</ol>"); inOrderedList = false; }
      const level = headingMatch[1].length;
      const hTag = `h${Math.min(level + 1, 6)}`;
      htmlResult.push(`<${hTag}>${parseInlineMarkdown(headingMatch[2])}</${hTag}>`);
      continue;
    }

    // Unordered List
    const bulletMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bulletMatch) {
      if (inOrderedList) { htmlResult.push("</ol>"); inOrderedList = false; }
      if (!inUnorderedList) {
        inUnorderedList = true;
        htmlResult.push("<ul>");
      }
      htmlResult.push(`<li>${parseInlineMarkdown(bulletMatch[1])}</li>`);
      continue;
    }

    // Ordered List
    const numberMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (numberMatch) {
      if (inUnorderedList) { htmlResult.push("</ul>"); inUnorderedList = false; }
      if (!inOrderedList) {
        inOrderedList = true;
        htmlResult.push("<ol>");
      }
      htmlResult.push(`<li>${parseInlineMarkdown(numberMatch[2])}</li>`);
      continue;
    }

    // Blank line
    if (!trimmed) {
      if (inUnorderedList) { htmlResult.push("</ul>"); inUnorderedList = false; }
      if (inOrderedList) { htmlResult.push("</ol>"); inOrderedList = false; }
      htmlResult.push("<br>");
      continue;
    }

    // Regular line
    if (inUnorderedList) { htmlResult.push("</ul>"); inUnorderedList = false; }
    if (inOrderedList) { htmlResult.push("</ol>"); inOrderedList = false; }
    htmlResult.push(`<p>${parseInlineMarkdown(line)}</p>`);
  }

  if (inTable) htmlResult.push("</tbody></table>");
  if (inUnorderedList) htmlResult.push("</ul>");
  if (inOrderedList) htmlResult.push("</ol>");
  if (inCodeBlock && codeBlockContent.length > 0) {
    const codeText = escapeHtml(codeBlockContent.join("\n"));
    htmlResult.push(`
      <div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-block-lang">${codeBlockLang || 'code'}</span>
          <button class="copy-code-btn" type="button"><i class="far fa-copy"></i> Copy</button>
        </div>
        <pre class="code-block"><code>${codeText}</code></pre>
      </div>
    `);
  }

  return htmlResult.join("\n");
}

const actionToolbarHtml = `
  <div class="message-actions">
    <button type="button" class="msg-action-btn msg-action-btn--speak" title="Speak reply">
      <i class="fas fa-volume-high"></i>
    </button>
    <button type="button" class="msg-action-btn msg-action-btn--copy" title="Copy reply">
      <i class="far fa-copy"></i>
    </button>
    <button type="button" class="msg-action-btn msg-action-btn--regenerate" title="Regenerate response">
      <i class="fas fa-rotate-right"></i>
    </button>
    <button type="button" class="msg-action-btn msg-action-btn--thumb-up" title="Good response">
      <i class="far fa-thumbs-up"></i>
    </button>
    <button type="button" class="msg-action-btn msg-action-btn--thumb-down" title="Bad response">
      <i class="far fa-thumbs-down"></i>
    </button>
  </div>
`;

function formatActionLabel(action, params) {
  switch (action) {
    case 'create_job':
      return `Create job posting "${params.title || 'Untitled'}"`;
    case 'update_record':
      return `Update record in ${params.collection} (ID: ${params.id})`;
    case 'delete_record':
      return `Delete record from ${params.collection} (ID: ${params.id})`;
    case 'create_candidate':
      return `Add candidate "${params.name || 'Unnamed'}"`;
    case 'schedule_interview':
      return `Schedule interview for Candidate (ID: ${params.candidateId})`;
    case 'create_offer':
      return `Create offer for Candidate (ID: ${params.candidateId}) as ${params.designation || 'Specialist'}`;
    case 'save_memory':
      return `Remember: "${params.content || ''}" (${params.category || 'fact'})`;
    case 'delete_memory':
      return `Forget memory (ID: ${params.id})`;
    default:
      return `Action: ${action}`;
  }
}

function renderActionFields(action, params = {}, index) {
  let fieldsHtml = "";
  switch (action) {
    case 'create_job':
      fieldsHtml = `
        <div class="action-field-group">
          <label>Job Title*</label>
          <input type="text" class="action-field-input" data-param="title" value="${escapeHtml(params.title || '')}" required>
        </div>
        <div class="action-field-group">
          <label>Department</label>
          <input type="text" class="action-field-input" data-param="department" value="${escapeHtml(params.department || '')}">
        </div>
        <div class="action-field-group">
          <label>Designation</label>
          <input type="text" class="action-field-input" data-param="designation" value="${escapeHtml(params.designation || '')}">
        </div>
        <div class="action-field-group">
          <label>Location</label>
          <input type="text" class="action-field-input" data-param="location" value="${escapeHtml(params.location || '')}">
        </div>
        <div class="action-field-group">
          <label>Budget (LPA)</label>
          <input type="number" step="0.1" class="action-field-input" data-param="budget" value="${params.budget || ''}">
        </div>
        <div class="action-field-group">
          <label>Priority</label>
          <select class="action-field-input" data-param="priority">
            <option value="Urgent" ${params.priority === 'Urgent' ? 'selected' : ''}>Urgent</option>
            <option value="Medium" ${params.priority !== 'Urgent' && params.priority !== 'Low' ? 'selected' : ''}>Medium</option>
            <option value="Low" ${params.priority === 'Low' ? 'selected' : ''}>Low</option>
          </select>
        </div>
      `;
      break;
    case 'create_candidate':
      fieldsHtml = `
        <div class="action-field-group">
          <label>Name*</label>
          <input type="text" class="action-field-input" data-param="name" value="${escapeHtml(params.name || '')}" required>
        </div>
        <div class="action-field-group">
          <label>Email*</label>
          <input type="email" class="action-field-input" data-param="email" value="${escapeHtml(params.email || '')}" required>
        </div>
        <div class="action-field-group">
          <label>Phone</label>
          <input type="text" class="action-field-input" data-param="phone" value="${escapeHtml(params.phone || '')}">
        </div>
        <div class="action-field-group">
          <label>Stage</label>
          <input type="text" class="action-field-input" data-param="stage" value="${escapeHtml(params.stage || 'Screening')}">
        </div>
        <div class="action-field-group">
          <label>Job ID / Placeholder</label>
          <input type="text" class="action-field-input" data-param="jobId" value="${escapeHtml(params.jobId || '')}" required>
        </div>
      `;
      break;
    case 'schedule_interview':
      let dtVal = params.dateTime || '';
      if (dtVal && dtVal.includes('Z')) {
        try { dtVal = new Date(dtVal).toISOString().slice(0, 16); } catch {}
      }
      fieldsHtml = `
        <div class="action-field-group">
          <label>Candidate ID / Placeholder</label>
          <input type="text" class="action-field-input" data-param="candidateId" value="${escapeHtml(params.candidateId || '')}" required>
        </div>
        <div class="action-field-group">
          <label>Interview Date & Time*</label>
          <input type="datetime-local" class="action-field-input" data-param="dateTime" value="${dtVal}" required>
        </div>
        <div class="action-field-group">
          <label>Mode</label>
          <input type="text" class="action-field-input" data-param="mode" value="${escapeHtml(params.mode || 'Online')}">
        </div>
        <div class="action-field-group">
          <label>Interviewers (comma separated)</label>
          <input type="text" class="action-field-input" data-param="interviewers" value="${escapeHtml(Array.isArray(params.interviewers) ? params.interviewers.join(', ') : params.interviewers || '')}">
        </div>
      `;
      break;
    case 'create_offer':
      fieldsHtml = `
        <div class="action-field-group">
          <label>Candidate ID / Placeholder</label>
          <input type="text" class="action-field-input" data-param="candidateId" value="${escapeHtml(params.candidateId || '')}" required>
        </div>
        <div class="action-field-group">
          <label>Designation*</label>
          <input type="text" class="action-field-input" data-param="designation" value="${escapeHtml(params.designation || '')}" required>
        </div>
        <div class="action-field-group">
          <label>Status</label>
          <select class="action-field-input" data-param="status">
            <option value="Draft" ${params.status === 'Draft' ? 'selected' : ''}>Draft</option>
            <option value="Sent" ${params.status === 'Sent' ? 'selected' : ''}>Sent</option>
            <option value="Accepted" ${params.status === 'Accepted' ? 'selected' : ''}>Accepted</option>
            <option value="Rejected" ${params.status === 'Rejected' ? 'selected' : ''}>Rejected</option>
          </select>
        </div>
      `;
      break;
    case 'update_record':
      fieldsHtml = `
        <div class="action-field-group">
          <label>Collection</label>
          <input type="text" class="action-field-input" data-param="collection" value="${escapeHtml(params.collection || '')}" disabled>
        </div>
        <div class="action-field-group">
          <label>Record ID</label>
          <input type="text" class="action-field-input" data-param="id" value="${escapeHtml(params.id || '')}" disabled>
        </div>
        <div class="action-field-group">
          <label>Update Data (JSON)</label>
          <textarea class="action-field-input" data-param="data" rows="3">${escapeHtml(JSON.stringify(params.data || {}, null, 2))}</textarea>
        </div>
      `;
      break;
    case 'delete_record':
      fieldsHtml = `
        <div class="action-field-group">
          <label>Collection</label>
          <input type="text" class="action-field-input" data-param="collection" value="${escapeHtml(params.collection || '')}" disabled>
        </div>
        <div class="action-field-group">
          <label>Record ID</label>
          <input type="text" class="action-field-input" data-param="id" value="${escapeHtml(params.id || '')}" disabled>
        </div>
      `;
      break;
    default:
      fieldsHtml = `
        <div class="action-field-group">
          <label>Params (JSON)</label>
          <textarea class="action-field-input" data-raw-params="true" rows="4">${escapeHtml(JSON.stringify(params, null, 2))}</textarea>
        </div>
      `;
  }
  return fieldsHtml;
}

function renderProposedActionsCard(actions = []) {
  if (actions.length === 0) return "";
  
  const itemsHtml = actions.map((act, idx) => {
    const fields = renderActionFields(act.action, act.params || {}, idx);
    return `
      <div class="proposed-action-item" data-index="${idx}" data-action="${escapeHtml(act.action)}" data-placeholder="${escapeHtml(act.id_placeholder || '')}">
        <div class="proposed-action-item-header">
          <input type="checkbox" class="proposed-action-checkbox" checked title="Select action to execute">
          <span class="proposed-action-label">${formatActionLabel(act.action, act.params || {})}</span>
          <button type="button" class="proposed-action-toggle-details" title="Configure details">
            <i class="fas fa-sliders-h"></i>&nbsp;Configure
          </button>
        </div>
        <div class="proposed-action-fields hidden">
          ${fields}
        </div>
      </div>
    `;
  }).join("");

  return `
    <div class="action-proposal-card">
      <div class="action-proposal-header">
        <i class="fas fa-clipboard-list"></i>
        <span>Review Executable Plan</span>
      </div>
      <div class="action-proposal-body">
        ${itemsHtml}
      </div>
      <div class="action-proposal-footer">
        <button type="button" class="action-btn action-btn--execute"><i class="fas fa-play"></i> Execute Selected</button>
        <button type="button" class="action-btn action-btn--cancel"><i class="fas fa-xmark"></i> Cancel Plan</button>
      </div>
    </div>
  `;
}

async function executeProposedActions(conversationId, actions, bubble) {
  const card = bubble.querySelector(".action-proposal-card");
  if (!card) return;

  const selectedActions = [];
  const items = card.querySelectorAll(".proposed-action-item");
  
  items.forEach(item => {
    const checkbox = item.querySelector(".proposed-action-checkbox");
    if (!checkbox || !checkbox.checked) return;

    const action = item.dataset.action;
    const placeholder = item.dataset.placeholder;
    const params = {};

    const paramInputs = item.querySelectorAll("[data-param]");
    paramInputs.forEach(input => {
      const key = input.dataset.param;
      let val = input.value;
      if (input.type === 'number') {
        val = val === '' ? null : Number(val);
      }
      if (key === 'interviewers') {
        val = val.split(',').map(s => s.trim()).filter(Boolean);
      }
      params[key] = val;
    });

    const rawTextarea = item.querySelector("[data-raw-params]");
    if (rawTextarea) {
      try {
        Object.assign(params, JSON.parse(rawTextarea.value));
      } catch (e) {
        console.error("Invalid JSON params", e);
      }
    }

    const actionData = { action, params };
    if (placeholder) {
      actionData.id_placeholder = placeholder;
    }
    selectedActions.push(actionData);
  });

  if (selectedActions.length === 0) {
    alert("Please select at least one action to execute.");
    return;
  }

  const bodyEl = card.querySelector(".action-proposal-body");
  const footerEl = card.querySelector(".action-proposal-footer");
  
  card.querySelectorAll("input, select, textarea, button").forEach(el => el.disabled = true);

  if (footerEl) {
    footerEl.innerHTML = `
      <span class="action-executing-loader">
        <i class="fas fa-spinner fa-spin"></i> Executing actions...
      </span>
    `;
  }

  let progressHtml = `<div class="execution-steps-progress">`;
  selectedActions.forEach((act, idx) => {
    progressHtml += `
      <div class="execution-progress-step running" id="exec-step-${idx}">
        <i class="fas fa-circle-notch fa-spin"></i>
        <span>Executing: ${formatActionLabel(act.action, act.params)}...</span>
      </div>
    `;
  });
  progressHtml += `</div>`;
  bodyEl.insertAdjacentHTML("beforeend", progressHtml);

  try {
    const headers = await authHeaders();
    const res = await fetch(`${apiBase()}/api/ai/execute-actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ companyId: state.companyId, conversationId, actions: selectedActions })
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || "Execution failed");

    const results = data.actionResults || [];
    
    selectedActions.forEach((act, idx) => {
      const stepEl = card.querySelector(`#exec-step-${idx}`);
      if (stepEl) {
        const result = results[idx];
        if (result && result.success) {
          stepEl.className = "execution-progress-step success";
          stepEl.innerHTML = `<i class="fas fa-circle-check"></i> <span>Success: ${escapeHtml(result.summary)}</span>`;
        } else {
          stepEl.className = "execution-progress-step failed";
          stepEl.innerHTML = `<i class="fas fa-circle-xmark"></i> <span>Failed: ${escapeHtml(result ? result.error : "Unknown error")}</span>`;
        }
      }
    });

    const actionHtml = results.map(res => {
      if (res.success) {
        return `
          <div class="action-result-card">
            <div class="action-result-icon"><i class="fas fa-circle-check"></i></div>
            <div class="action-result-content">
              <div class="action-result-title">Action Executed</div>
              <div class="action-result-details">${escapeHtml(res.summary)} (ID: ${escapeHtml(res.id)})</div>
            </div>
          </div>
        `;
      } else {
        return `
          <div class="action-result-card error">
            <div class="action-result-icon"><i class="fas fa-circle-xmark"></i></div>
            <div class="action-result-content">
              <div class="action-result-title">Action Failed</div>
              <div class="action-result-details">${escapeHtml(res.error || "Unknown error")}</div>
            </div>
          </div>
        `;
      }
    }).join("");

    setTimeout(() => {
      card.remove();
      const body = bubble.querySelector(".message-body");
      if (body) {
        const footerEl = body.querySelector(".message-footer");
        if (footerEl) {
          footerEl.insertAdjacentHTML("beforebegin", actionHtml);
        } else {
          body.insertAdjacentHTML("beforeend", actionHtml);
        }
      }
    }, 1200);

    await loadMemories();
  } catch (error) {
    card.querySelectorAll("input, select, textarea, button").forEach(el => el.disabled = false);
    
    const progressEl = card.querySelector(".execution-steps-progress");
    if (progressEl) progressEl.remove();

    if (footerEl) {
      footerEl.innerHTML = `
        <div class="action-execution-error">
          <i class="fas fa-circle-exclamation"></i> ${escapeHtml(error.message)}
          <button type="button" class="action-btn action-btn--execute" style="margin-left: 12px;"><i class="fas fa-rotate"></i> Retry</button>
        </div>
      `;
    }
  }
}

function formatCredits(value) {
  return Number(value || 0).toLocaleString("en-IN");
}

function updateCreditsLabel() {
  els.creditsLabel.textContent = `${formatCredits(state.creditsRemaining)} credits`;
}

function renderEmptyState(show) {
  if (els.emptyState) {
    els.emptyState.classList.toggle("hidden", !show);
  }
}

function timeAgo(date) {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";

  const seconds = Math.floor((new Date() - d) / 1000);
  if (seconds < 10) return "Just now";

  const intervals = [
    { label: "year", seconds: 31536000 },
    { label: "month", seconds: 2592000 },
    { label: "day", seconds: 86400 },
    { label: "hour", seconds: 3600 },
    { label: "minute", seconds: 60 }
  ];

  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count >= 1) {
      return `${count} ${interval.label}${count > 1 ? "s" : ""} ago`;
    }
  }

  return "Just now";
}

function renderMessages(messages = []) {
  const existing = els.messages.querySelectorAll(".message");
  existing.forEach((node) => node.remove());
  renderEmptyState(!messages.length);

  messages.forEach((msg) => {
    const bubble = document.createElement("article");
    bubble.className = `message message--${msg.role}`;
    bubble.dataset.raw = msg.content;
    
    let actionHtml = "";
    const results = msg.actionResults || (msg.actionResult ? [msg.actionResult] : []);
    if (results.length > 0) {
      actionHtml = results.map(res => {
        if (res.success) {
          return `
            <div class="action-result-card">
              <div class="action-result-icon"><i class="fas fa-circle-check"></i></div>
              <div class="action-result-content">
                <div class="action-result-title">Action Executed</div>
                <div class="action-result-details">${escapeHtml(res.summary)} (ID: ${escapeHtml(res.id)})</div>
              </div>
            </div>
          `;
        } else {
          return `
            <div class="action-result-card error">
              <div class="action-result-icon"><i class="fas fa-circle-xmark"></i></div>
              <div class="action-result-content">
                <div class="action-result-title">Action Failed</div>
                <div class="action-result-details">${escapeHtml(res.error || "Unknown error")}</div>
              </div>
            </div>
          `;
        }
      }).join("");
    } else if (Array.isArray(msg.proposedActions) && msg.proposedActions.length > 0) {
      actionHtml = renderProposedActionsCard(msg.proposedActions);
      bubble.dataset.proposed = JSON.stringify(msg.proposedActions);
    }

    const timeLabel = msg.createdAt ? `<time class="message-time" title="${new Date(msg.createdAt).toLocaleString()}">${timeAgo(msg.createdAt)}</time>` : "";

    bubble.innerHTML = `
      <div class="message-avatar">${msg.role === "assistant" ? '<i class="fas fa-brain"></i>' : '<i class="fas fa-user"></i>'}</div>
      <div class="message-body">
        <div class="message-text">${parseMarkdown(msg.content)}</div>
        ${actionHtml}
        <div class="message-footer">
          ${timeLabel}
          ${msg.role === "assistant" ? actionToolbarHtml : `
            <div class="message-actions">
              <button type="button" class="msg-action-btn msg-action-btn--edit" title="Edit message">
                <i class="fas fa-pencil"></i>
              </button>
            </div>
          `}
        </div>
      </div>
    `;
    els.messages.appendChild(bubble);
  });

  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderConversationList() {
  const query = (state.searchQuery || "").trim().toLowerCase();
  const filtered = state.conversations.filter(item => 
    !query || (item.title || "").toLowerCase().includes(query)
  );

  els.conversationList.innerHTML = filtered.map((item) => {
    if (item.id === state.editingConversationId) {
      return `
        <div class="conversation-item active-editing" data-id="${escapeHtml(item.id)}" role="listitem">
          <div class="conversation-rename-wrapper">
            <input type="text" class="conversation-rename-input" value="${escapeHtml(item.title)}" aria-label="New chat name">
            <button type="button" class="conversation-action-btn conversation-rename-save" data-save="${escapeHtml(item.id)}" title="Save rename" aria-label="Save rename">
              <i class="fas fa-check"></i>
            </button>
            <button type="button" class="conversation-action-btn conversation-rename-cancel" data-cancel="${escapeHtml(item.id)}" title="Cancel rename" aria-label="Cancel rename">
              <i class="fas fa-xmark"></i>
            </button>
          </div>
        </div>
      `;
    }

    return `
      <div class="conversation-item ${item.id === state.conversationId ? "active" : ""}" data-id="${escapeHtml(item.id)}" role="listitem">
        <button type="button" class="conversation-open" data-open="${escapeHtml(item.id)}" aria-label="Open chat: ${escapeHtml(item.title)}">
          <span class="conversation-title">${escapeHtml(item.title)}</span>
          <span class="conversation-meta">${item.messageCount} messages</span>
        </button>
        <div class="conversation-actions">
          <button type="button" class="conversation-action-btn conversation-rename-trigger" data-rename="${escapeHtml(item.id)}" title="Rename chat" aria-label="Rename chat">
            <i class="fas fa-pencil"></i>
          </button>
          <button type="button" class="conversation-action-btn conversation-action-btn--delete conversation-delete" data-delete="${escapeHtml(item.id)}" title="Delete chat" aria-label="Delete chat">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    `;
  }).join("") || `<p class="sidebar-empty">${query ? "No matches found" : "No chats yet"}</p>`;

  // Auto-focus input if renaming
  if (state.editingConversationId) {
    const input = els.conversationList.querySelector(".conversation-rename-input");
    if (input) {
      input.focus();
      input.select();
    }
  }
}

async function renameConversation(conversationId, newTitle) {
  if (!newTitle || !newTitle.trim()) return;
  const headers = await authHeaders();
  const res = await fetch(`${apiBase()}/api/ai/conversations`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ companyId: state.companyId, conversationId, title: newTitle.trim() })
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data.error || "Could not rename conversation");

  state.editingConversationId = null;
  await loadConversations();
}

async function loadMemories() {
  try {
    const headers = await authHeaders();
    const res = await fetch(`${apiBase()}/api/ai/memory`, {
      method: "GET",
      headers
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || "Could not load memories");

    const memories = data.memories || [];
    if (els.memoryCountBadge) {
      els.memoryCountBadge.textContent = memories.length;
    }
    return memories;
  } catch (error) {
    console.error("Failed to load memories:", error);
    return [];
  }
}

async function renderMemoriesList() {
  if (!els.memoryList) return;
  els.memoryList.innerHTML = `<span style="font-size: 13px; color: var(--muted);"><i class="fas fa-spinner fa-spin"></i> Loading memories...</span>`;
  
  const memories = await loadMemories();
  if (memories.length === 0) {
    els.memoryList.innerHTML = `<p style="font-size: 13px; color: var(--muted); text-align: center; margin: 20px 0;">No memories stored yet. Talk to the AI to save preferences!</p>`;
    return;
  }

  els.memoryList.innerHTML = memories.map(m => `
    <div class="memory-item" data-id="${escapeHtml(m.id)}">
      <div style="flex: 1; min-width: 0;">
        <div class="memory-item-content">${escapeHtml(m.content)}</div>
        <span class="memory-item-category">${escapeHtml(m.category)}</span>
      </div>
      <button type="button" class="memory-item-delete" data-delete-memory="${escapeHtml(m.id)}" title="Forget preference">
        <i class="fas fa-trash-can"></i>
      </button>
    </div>
  `).join("");
}

async function deleteMemoryItem(memoryId) {
  if (!confirm("Are you sure you want the AI to forget this fact/preference?")) return;
  try {
    const headers = await authHeaders();
    const res = await fetch(`${apiBase()}/api/ai/memory`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ companyId: state.companyId, memoryId })
    });
    const data = await safeJson(res);
    if (!res.ok) throw new Error(data.error || "Could not delete memory");
    await renderMemoriesList();
  } catch (error) {
    alert("Error: " + error.message);
  }
}

async function loadConversations() {
  const headers = await authHeaders();
  const res = await fetch(`${apiBase()}/api/ai/conversations?companyId=${encodeURIComponent(state.companyId)}`, {
    method: "GET",
    headers
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data.error || "Could not load conversations");
  state.conversations = data.conversations || [];
  renderConversationList();
}

async function openConversation(conversationId) {
  const headers = await authHeaders();
  const res = await fetch(`${apiBase()}/api/ai/conversations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ companyId: state.companyId, conversationId })
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data.error || "Could not open conversation");

  state.conversationId = conversationId;
  renderConversationList();
  renderMessages(data.conversation?.messages || []);
}

async function deleteConversation(conversationId) {
  if (!confirm("Delete this chat?")) return;
  const headers = await authHeaders();
  const res = await fetch(`${apiBase()}/api/ai/conversations?companyId=${encodeURIComponent(state.companyId)}&conversationId=${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
    headers
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data.error || "Could not delete conversation");

  if (state.conversationId === conversationId) {
    state.conversationId = null;
    renderMessages([]);
  }
  await loadConversations();
}

function startNewChat() {
  state.conversationId = null;
  renderMessages([]);
  renderConversationList();
  els.composerInput.focus();
}

async function sendMessage(message, truncateFromIndex = null) {
  if (state.sending) return;
  state.sending = true;
  els.sendBtn.disabled = true;

  const headers = await authHeaders();

  const userBubble = document.createElement("article");
  userBubble.className = "message message--user";
  userBubble.dataset.raw = message;
  userBubble.innerHTML = `
    <div class="message-avatar"><i class="fas fa-user"></i></div>
    <div class="message-body">
      <div class="message-text">${parseMarkdown(message)}</div>
      <div class="message-footer">
        <div class="message-actions">
          <button type="button" class="msg-action-btn msg-action-btn--edit" title="Edit message">
            <i class="fas fa-pencil"></i>
          </button>
        </div>
      </div>
    </div>
  `;
  renderEmptyState(false);
  els.messages.appendChild(userBubble);

  const typing = document.createElement("article");
  typing.className = "message message--assistant message--typing";
  typing.innerHTML = `
    <div class="message-avatar"><i class="fas fa-brain"></i></div>
    <div class="message-body">
      <div class="typing-container">
        <span class="typing-dots"><span></span><span></span><span></span></span>
        <span class="typing-text">Thinking...</span>
      </div>
    </div>
  `;
  els.messages.appendChild(typing);
  els.messages.scrollTop = els.messages.scrollHeight;

  const thinkingTexts = [
    "Thinking...",
    "Reading workspace data...",
    "Analyzing your request...",
    "Generating response..."
  ];
  let textIndex = 0;
  const textEl = typing.querySelector(".typing-text");
  const typingInterval = setInterval(() => {
    textIndex = (textIndex + 1) % thinkingTexts.length;
    if (textEl) {
      textEl.classList.add("fade-out");
      setTimeout(() => {
        textEl.textContent = thinkingTexts[textIndex];
        textEl.classList.remove("fade-out");
      }, 200);
    }
  }, 2500);

  let assistantBubble = null;
  let replyText = "";

  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();
  els.stopContainer?.classList.remove("hidden");

  try {
    const res = await fetch(`${apiBase()}/api/ai/chat`, {
      method: "POST",
      headers,
      signal: currentAbortController.signal,
      body: JSON.stringify({
        companyId: state.companyId,
        conversationId: state.conversationId,
        message,
        ...(truncateFromIndex !== null ? { truncateFromIndex } : {})
      })
    });

    if (res.status === 402) {
      throw new Error("No AI credits remaining");
    }

    if (!res.ok) {
      const errData = await safeJson(res).catch(() => ({}));
      throw new Error(errData.error || "Chat request failed");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let streamBuffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      streamBuffer += decoder.decode(value, { stream: true });
      let lineBreakIndex;
      while ((lineBreakIndex = streamBuffer.indexOf("\n")) !== -1) {
        const line = streamBuffer.slice(0, lineBreakIndex).trim();
        streamBuffer = streamBuffer.slice(lineBreakIndex + 1);

        if (line.startsWith("data:")) {
          const dataStr = line.slice(5).trim();
          const data = JSON.parse(dataStr);

          if (data.error) {
            throw new Error(data.error);
          }

          if (data.done) {
            state.conversationId = data.conversationId;
            state.creditsRemaining = data.creditsRemaining ?? state.creditsRemaining;
            updateCreditsLabel();
            loadMemories().catch(() => {});

            if (assistantBubble) {
              assistantBubble.dataset.raw = replyText;
            }

            const proposedActions = data.proposedActions || [];
            let actionHtml = "";
            if (proposedActions.length > 0) {
              actionHtml = renderProposedActionsCard(proposedActions);
              if (assistantBubble) {
                assistantBubble.dataset.proposed = JSON.stringify(proposedActions);
              }
            }

            if (assistantBubble) {
              const bodyDiv = assistantBubble.querySelector(".message-body");
              if (bodyDiv) {
                const textDiv = bodyDiv.querySelector(".message-text");
                if (textDiv) {
                  if (proposedActions.length > 0) {
                    textDiv.insertAdjacentHTML("afterend", actionHtml);
                  }
                  
                  const footerHtml = `
                    <div class="message-footer">
                      <time class="message-time" title="${new Date().toLocaleString()}">Just now</time>
                      ${actionToolbarHtml}
                    </div>
                  `;
                  bodyDiv.insertAdjacentHTML("beforeend", footerHtml);
                }
              }
            }
            break;
          }

          if (data.token) {
            if (typingInterval) {
              clearInterval(typingInterval);
            }
            if (typing.parentNode) {
              typing.remove();
            }

            if (!assistantBubble) {
              assistantBubble = document.createElement("article");
              assistantBubble.className = "message message--assistant";
              assistantBubble.innerHTML = `
                <div class="message-avatar"><i class="fas fa-brain"></i></div>
                <div class="message-body">
                  <div class="message-text"></div>
                </div>
              `;
              els.messages.appendChild(assistantBubble);
            }

            replyText += data.token;
            const contentDiv = assistantBubble.querySelector(".message-text");
            if (contentDiv) {
              const wasAtBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 50;
              contentDiv.innerHTML = parseMarkdown(replyText);
              if (wasAtBottom) {
                els.messages.scrollTop = els.messages.scrollHeight;
              }
            }
          }
        }
      }
    }

    await loadConversations();
    if (state.conversationId) {
      const active = state.conversations.find((c) => c.id === state.conversationId);
      if (active) renderConversationList();
    }
  } catch (error) {
    if (typingInterval) clearInterval(typingInterval);
    if (typing.parentNode) typing.remove();
    if (assistantBubble && !replyText) assistantBubble.remove();

    const isTimeout = error.name === "AbortError";
    const errorMsg = isTimeout ? "The request timed out. Please try again." : error.message;
    const isNoCredits = errorMsg.toLowerCase().includes("no ai credits") || errorMsg.toLowerCase().includes("credits remaining");

    const errBubble = document.createElement("article");
    errBubble.className = "message message--error";
    
    let errorBody = "";
    if (isNoCredits) {
      errorBody = `
        <div class="action-proposal-card" style="border-color: var(--error-border); background: var(--error-bg); color: var(--error-text);">
          <div class="action-proposal-header" style="color: var(--error-text);">
            <i class="fas fa-coins"></i>
            <span>No AI Credits Remaining</span>
          </div>
          <div style="font-size: 13px; line-height: 1.5; margin-bottom: 12px;">
            Your company has run out of AI credits. Please purchase more credits in the Access Portal to continue using Workcosmo AI.
          </div>
          <a href="https://space.workcosmo.in/portal" target="_blank" class="action-btn" style="background: var(--error-text); color: #fff; text-decoration: none; display: inline-flex;">
            <i class="fas fa-cart-shopping"></i> Go to Portal
          </a>
        </div>
      `;
    } else {
      errorBody = `
        <div style="color: var(--error-text); font-weight: 500;">Error: ${escapeHtml(errorMsg)}</div>
        <button type="button" class="error-retry-btn" data-retry-msg="${escapeHtml(message)}" style="margin-top: 8px;">
          <i class="fas fa-rotate"></i> Retry
        </button>
      `;
    }

    errBubble.innerHTML = `
      <div class="message-avatar"><i class="fas fa-circle-exclamation" style="color: var(--error-text);"></i></div>
      <div class="message-body">
        ${errorBody}
      </div>
    `;
    els.messages.appendChild(errBubble);
    els.messages.scrollTop = els.messages.scrollHeight;
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    els.stopContainer?.classList.add("hidden");
    currentAbortController = null;
    state.sending = false;
    els.sendBtn.disabled = false;
    els.composerInput?.focus();
  }
}

els.composerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = els.composerInput.value.trim();
  if (!message) return;
  els.composerInput.value = "";
  els.composerInput.style.height = "auto";
  
  let truncateIndex = null;
  if (els.composerForm.dataset.truncateIndex) {
    truncateIndex = parseInt(els.composerForm.dataset.truncateIndex, 10);
    delete els.composerForm.dataset.truncateIndex;
    
    // Remove old messages from DOM
    const messages = [...els.messages.querySelectorAll(".message")];
    for (let i = messages.length - 1; i >= truncateIndex; i--) {
      messages[i].remove();
    }
  }
  
  await sendMessage(message, truncateIndex);
});

els.composerInput?.addEventListener("input", () => {
  els.composerInput.style.height = "auto";
  els.composerInput.style.height = `${Math.min(els.composerInput.scrollHeight, 160)}px`;
});

els.composerInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.composerForm.requestSubmit();
  }
});

els.newChatBtn?.addEventListener("click", startNewChat);

els.signOutBtn?.addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "https://space.workcosmo.in";
});

els.conversationSearch?.addEventListener("input", (e) => {
  state.searchQuery = e.target.value;
  renderConversationList();
});

els.stopBtn?.addEventListener("click", () => {
  if (currentAbortController) {
    currentAbortController.abort();
  }
});

els.messages?.addEventListener("scroll", () => {
  if (!els.scrollBottomBtn) return;
  const isNearBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 50;
  if (isNearBottom) {
    els.scrollBottomBtn.classList.add("hidden");
  } else {
    els.scrollBottomBtn.classList.remove("hidden");
  }
});

els.scrollBottomBtn?.addEventListener("click", () => {
  els.messages?.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" });
});

let recognition = null;
if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  
  recognition.onstart = () => {
    els.voiceBtn?.classList.add("recording");
  };
  
  recognition.onend = () => {
    els.voiceBtn?.classList.remove("recording");
  };
  
  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    if (els.composerInput) {
      els.composerInput.value += (els.composerInput.value ? " " : "") + transcript;
      els.composerInput.dispatchEvent(new Event("input"));
    }
  };
}

els.voiceBtn?.addEventListener("click", () => {
  if (!recognition) {
    alert("Speech recognition is not supported in this browser.");
    return;
  }
  if (els.voiceBtn.classList.contains("recording")) {
    recognition.stop();
  } else {
    recognition.start();
  }
});

els.exportBtn?.addEventListener("click", () => {
  const messages = [...els.messages.querySelectorAll(".message")];
  if (messages.length === 0) {
    alert("No messages to export.");
    return;
  }
  
  let exportText = `# Workcosmo AI Chat Export\nDate: ${new Date().toLocaleString()}\n\n`;
  messages.forEach(msg => {
    const role = msg.classList.contains("message--user") ? "User" : "Workcosmo AI";
    const text = msg.dataset.raw || msg.querySelector(".message-body").textContent.trim();
    if (text) {
      exportText += `### ${role}\n${text}\n\n---\n\n`;
    }
  });
  
  const blob = new Blob([exportText], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Workcosmo_Chat_${new Date().toISOString().slice(0,10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

els.conversationList?.addEventListener("click", async (event) => {
  const openId = event.target.closest("[data-open]")?.dataset.open;
  const deleteId = event.target.closest("[data-delete]")?.dataset.delete;
  const renameId = event.target.closest("[data-rename]")?.dataset.rename;
  const saveId = event.target.closest("[data-save]")?.dataset.save;
  const cancelId = event.target.closest("[data-cancel]")?.dataset.cancel;

  if (deleteId) {
    await deleteConversation(deleteId);
    return;
  }
  if (renameId) {
    state.editingConversationId = renameId;
    renderConversationList();
    return;
  }
  if (saveId) {
    const input = els.conversationList.querySelector(".conversation-rename-input");
    if (input) {
      await renameConversation(saveId, input.value);
    }
    return;
  }
  if (cancelId) {
    state.editingConversationId = null;
    renderConversationList();
    return;
  }
  if (openId) {
    await openConversation(openId);
  }
});

els.conversationList?.addEventListener("keydown", async (event) => {
  if (event.target.classList.contains("conversation-rename-input")) {
    if (event.key === "Enter") {
      event.preventDefault();
      const saveBtn = event.target.parentNode.querySelector("[data-save]");
      if (saveBtn) saveBtn.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      const cancelBtn = event.target.parentNode.querySelector("[data-cancel]");
      if (cancelBtn) cancelBtn.click();
    }
  }
});

els.messages?.addEventListener("click", (event) => {
  // 1. Copy code block button
  const copyCodeBtn = event.target.closest(".copy-code-btn");
  if (copyCodeBtn) {
    const wrapper = copyCodeBtn.closest(".code-block-wrapper");
    const codeEl = wrapper?.querySelector("pre code");
    if (codeEl) {
      const text = codeEl.textContent;
      navigator.clipboard.writeText(text).then(() => {
        const originalHtml = copyCodeBtn.innerHTML;
        copyCodeBtn.innerHTML = `<i class="fas fa-check"></i> Copied!`;
        copyCodeBtn.classList.add("success");
        setTimeout(() => {
          copyCodeBtn.innerHTML = originalHtml;
          copyCodeBtn.classList.remove("success");
        }, 2000);
      });
    }
    return;
  }

  // Speak message button
  const speakBtn = event.target.closest(".msg-action-btn--speak");
  if (speakBtn) {
    const bubble = speakBtn.closest(".message");
    const rawContent = bubble?.dataset.raw || bubble?.querySelector(".message-text")?.textContent || "";
    
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      const allSpeakBtns = els.messages.querySelectorAll(".msg-action-btn--speak i");
      allSpeakBtns.forEach(icon => {
        icon.className = "fas fa-volume-high";
      });
      
      if (speakBtn.dataset.speaking === "true") {
        speakBtn.removeAttribute("data-speaking");
        return;
      }
    }

    if (rawContent) {
      let cleanText = rawContent
        .replace(/:::ACTION.*?:::/g, "")
        .replace(/[#*`_~]/g, "")
        .replace(/\[(.*?)\]\(.*?\)/g, "$1")
        .trim();

      if (cleanText) {
        const utterance = new SpeechSynthesisUtterance(cleanText);
        const icon = speakBtn.querySelector("i");

        utterance.onstart = () => {
          speakBtn.dataset.speaking = "true";
          if (icon) icon.className = "fas fa-volume-xmark";
        };

        const resetIcon = () => {
          speakBtn.removeAttribute("data-speaking");
          if (icon) icon.className = "fas fa-volume-high";
        };

        utterance.onend = resetIcon;
        utterance.onerror = resetIcon;

        window.speechSynthesis.speak(utterance);
      }
    }
    return;
  }

  // 2. Copy message button
  const copyMsgBtn = event.target.closest(".msg-action-btn--copy");
  if (copyMsgBtn) {
    const bubble = copyMsgBtn.closest(".message");
    const rawContent = bubble?.dataset.raw || "";
    if (rawContent) {
      navigator.clipboard.writeText(rawContent).then(() => {
        const originalHtml = copyMsgBtn.innerHTML;
        copyMsgBtn.innerHTML = `<i class="fas fa-check"></i>`;
        setTimeout(() => {
          copyMsgBtn.innerHTML = originalHtml;
        }, 1500);
      });
    }
    return;
  }

  // 3. Regenerate button
  const regenBtn = event.target.closest(".msg-action-btn--regenerate");
  if (regenBtn) {
    const messages = [...els.messages.querySelectorAll(".message")];
    const currentBubble = regenBtn.closest(".message");
    const currentIndex = messages.indexOf(currentBubble);
    
    let lastUserMessage = "";
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (messages[i].classList.contains("message--user")) {
        lastUserMessage = messages[i].dataset.raw || messages[i].querySelector(".message-body").textContent || "";
        break;
      }
    }

    if (lastUserMessage) {
      for (let i = messages.length - 1; i >= currentIndex; i--) {
        messages[i].remove();
      }
      sendMessage(lastUserMessage, currentIndex);
    }
    return;
  }

  // 4. Edit user message
  const editBtn = event.target.closest(".msg-action-btn--edit");
  if (editBtn) {
    const bubble = editBtn.closest(".message");
    const rawContent = bubble?.dataset.raw || "";
    els.composerInput.value = rawContent;
    els.composerInput.focus();
    els.composerInput.dispatchEvent(new Event("input"));
    
    const messages = [...els.messages.querySelectorAll(".message")];
    const currentIndex = messages.indexOf(bubble);
    els.composerForm.dataset.truncateIndex = currentIndex;
    
    messages.forEach(m => m.classList.remove("editing"));
    bubble.classList.add("editing");
    return;
  }

  // 5. Thumbs up/down
  const thumbBtn = event.target.closest(".msg-action-btn--thumb-up, .msg-action-btn--thumb-down");
  if (thumbBtn) {
    thumbBtn.classList.toggle("active");
    if (thumbBtn.classList.contains("active")) {
      thumbBtn.querySelector("i").classList.replace("far", "fas");
    } else {
      thumbBtn.querySelector("i").classList.replace("fas", "far");
    }
    return;
  }

  // 6. Suggestion chips clicks
  const chip = event.target.closest(".suggestion-chip");
  if (chip) {
    const prompt = chip.dataset.prompt;
    if (prompt) {
      sendMessage(prompt);
    }
    return;
  }

  // 5. Execute action plan
  const executeBtn = event.target.closest(".action-btn--execute");
  if (executeBtn) {
    const bubble = executeBtn.closest(".message");
    const proposed = bubble?.dataset.proposed ? JSON.parse(bubble.dataset.proposed) : null;
    if (proposed && state.conversationId) {
      executeProposedActions(state.conversationId, proposed, bubble);
    }
    return;
  }

  // 6. Cancel action plan
  const cancelBtn = event.target.closest(".action-btn--cancel");
  if (cancelBtn) {
    const bubble = cancelBtn.closest(".message");
    const card = bubble?.querySelector(".action-proposal-card");
    if (card) {
      card.outerHTML = `
        <div class="action-cancelled-card">
          <i class="fas fa-circle-xmark"></i> Plan cancelled
        </div>
      `;
    }
    return;
  }
});

// Memory modal event listeners
els.memoryBtn?.addEventListener("click", () => {
  els.memoryModal?.classList.remove("hidden");
  renderMemoriesList();
});

els.closeMemoryModal?.addEventListener("click", () => {
  els.memoryModal?.classList.add("hidden");
});

// Close modal when clicking outside content
els.memoryModal?.addEventListener("click", (e) => {
  if (e.target === els.memoryModal) {
    els.memoryModal.classList.add("hidden");
  }
});

// Memory delete trigger using delegation
els.memoryList?.addEventListener("click", async (e) => {
  const deleteBtn = e.target.closest("[data-delete-memory]");
  if (deleteBtn) {
    const memoryId = deleteBtn.dataset.deleteMemory;
    if (memoryId) {
      await deleteMemoryItem(memoryId);
    }
  }
});

// Connection status handler
function updateOnlineStatus() {
  const statusBar = document.getElementById("connection-status");
  if (!statusBar) return;
  if (navigator.onLine) {
    statusBar.classList.add("hidden");
  } else {
    statusBar.classList.remove("hidden");
  }
}

window.addEventListener("online", updateOnlineStatus);
window.addEventListener("offline", updateOnlineStatus);
updateOnlineStatus();

// Keyboard Navigation & Shortcuts
els.conversationList?.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const openButtons = [...els.conversationList.querySelectorAll(".conversation-open")];
    const activeIdx = openButtons.indexOf(document.activeElement);
    if (activeIdx !== -1) {
      e.preventDefault();
      let nextIdx = e.key === "ArrowDown" ? activeIdx + 1 : activeIdx - 1;
      if (nextIdx >= 0 && nextIdx < openButtons.length) {
        openButtons[nextIdx].focus();
      }
    }
  }
});

window.addEventListener("keydown", (e) => {
  // Focus composer: Ctrl/Cmd + K
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    els.composerInput?.focus();
  }
  // New chat: Ctrl/Cmd + Shift + N
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    startNewChat();
  }
  // Escape: Blur input / Close memory modal
  if (e.key === "Escape") {
    if (document.activeElement === els.composerInput) {
      els.composerInput.blur();
    }
    els.memoryModal?.classList.add("hidden");
  }
});

initAuthGuard(async ({ user, profile, company, companyId, creditsRemaining }) => {
  state.companyId = companyId || getCompanyId();
  state.company = company;
  state.profile = profile;
  state.creditsRemaining = creditsRemaining;

  els.workspaceTitle.textContent = company.companyName || company.name || state.companyId;
  els.userLabel.textContent = profile.name || user.email || "User";
  updateCreditsLabel();

  try {
    await loadConversations();
  } catch (error) {
    console.warn("Conversation list load failed:", error);
  }

  // Load personalization memory count
  try {
    await loadMemories();
  } catch (error) {
    console.warn("Memories load failed:", error);
  }

  startNewChat();
});
