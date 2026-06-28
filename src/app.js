import { auth, signOut } from "./firebase.js";
import { getCompanyId, initAuthGuard } from "./auth-guard.js";

const state = {
  companyId: "",
  company: null,
  profile: null,
  creditsRemaining: 0,
  conversationId: null,
  conversations: [],
  sending: false
};

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
  signOutBtn: document.getElementById("sign-out-btn")
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

function renderMessages(messages = []) {
  const existing = els.messages.querySelectorAll(".message");
  existing.forEach((node) => node.remove());
  renderEmptyState(!messages.length);

  messages.forEach((msg) => {
    const bubble = document.createElement("article");
    bubble.className = `message message--${msg.role}`;
    bubble.innerHTML = `
      <div class="message-avatar">${msg.role === "assistant" ? '<i class="fas fa-brain"></i>' : '<i class="fas fa-user"></i>'}</div>
      <div class="message-body">${escapeHtml(msg.content).replace(/\n/g, "<br>")}</div>
    `;
    els.messages.appendChild(bubble);
  });

  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderConversationList() {
  els.conversationList.innerHTML = state.conversations.map((item) => `
    <div class="conversation-item ${item.id === state.conversationId ? "active" : ""}" data-id="${escapeHtml(item.id)}">
      <button type="button" class="conversation-open" data-open="${escapeHtml(item.id)}">
        <span class="conversation-title">${escapeHtml(item.title)}</span>
        <span class="conversation-meta">${item.messageCount} messages</span>
      </button>
      <button type="button" class="conversation-delete" data-delete="${escapeHtml(item.id)}" title="Delete chat">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `).join("") || `<p class="sidebar-empty">No chats yet</p>`;
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

async function sendMessage(message) {
  if (state.sending) return;
  state.sending = true;
  els.sendBtn.disabled = true;

  const headers = await authHeaders();
  const priorMessages = [...els.messages.querySelectorAll(".message")].map(() => null);
  void priorMessages;

  const userBubble = document.createElement("article");
  userBubble.className = "message message--user";
  userBubble.innerHTML = `
    <div class="message-avatar"><i class="fas fa-user"></i></div>
    <div class="message-body">${escapeHtml(message).replace(/\n/g, "<br>")}</div>
  `;
  renderEmptyState(false);
  els.messages.appendChild(userBubble);

  const typing = document.createElement("article");
  typing.className = "message message--assistant message--typing";
  typing.innerHTML = `
    <div class="message-avatar"><i class="fas fa-brain"></i></div>
    <div class="message-body"><span class="typing-dots"><span></span><span></span><span></span></span></div>
  `;
  els.messages.appendChild(typing);
  els.messages.scrollTop = els.messages.scrollHeight;

  try {
    const res = await fetch(`${apiBase()}/api/ai/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        companyId: state.companyId,
        conversationId: state.conversationId,
        message
      })
    });
    const data = await safeJson(res);
    typing.remove();

    if (!res.ok) {
      throw new Error(data.error || "Chat request failed");
    }

    state.conversationId = data.conversationId;
    state.creditsRemaining = data.creditsRemaining ?? state.creditsRemaining;
    updateCreditsLabel();

    const assistantBubble = document.createElement("article");
    assistantBubble.className = "message message--assistant";
    assistantBubble.innerHTML = `
      <div class="message-avatar"><i class="fas fa-brain"></i></div>
      <div class="message-body">${escapeHtml(data.reply).replace(/\n/g, "<br>")}</div>
    `;
    els.messages.appendChild(assistantBubble);
    els.messages.scrollTop = els.messages.scrollHeight;

    await loadConversations();
    if (state.conversationId) {
      const active = state.conversations.find((c) => c.id === state.conversationId);
      if (active) renderConversationList();
    }
  } catch (error) {
    typing.remove();
    const errBubble = document.createElement("article");
    errBubble.className = "message message--error";
    errBubble.innerHTML = `
      <div class="message-avatar"><i class="fas fa-circle-exclamation"></i></div>
      <div class="message-body">${escapeHtml(error.message)}</div>
    `;
    els.messages.appendChild(errBubble);
    els.messages.scrollTop = els.messages.scrollHeight;
  } finally {
    state.sending = false;
    els.sendBtn.disabled = false;
  }
}

els.composerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = els.composerInput.value.trim();
  if (!message) return;
  els.composerInput.value = "";
  els.composerInput.style.height = "auto";
  await sendMessage(message);
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

els.conversationList?.addEventListener("click", async (event) => {
  const openId = event.target.closest("[data-open]")?.dataset.open;
  const deleteId = event.target.closest("[data-delete]")?.dataset.delete;
  if (deleteId) {
    await deleteConversation(deleteId);
    return;
  }
  if (openId) {
    await openConversation(openId);
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

  startNewChat();
});
