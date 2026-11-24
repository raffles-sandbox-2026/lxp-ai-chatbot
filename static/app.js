"use strict";

const $ = (selector) => document.querySelector(selector);
const storageKey = "lxp-ai-chatbot.chat.v1.";
const tokenStorageKey = "lxp-ai-chatbot.token.";
const maxChats = 20;
const maxStoredMessages = 200;
let chatToken = "";
try {
  for (const part of window.location.hash.replace(/^#/, "").split("&")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator) === "token") {
      chatToken = decodeURIComponent(part.slice(separator + 1));
      break;
    }
  }
  if (chatToken) {
    try { localStorage.setItem(tokenStorageKey, chatToken); } catch { /* Token still works for this visit. */ }
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
} catch { /* Ignore malformed hash tokens. */ }
if (!chatToken) {
  try { chatToken = localStorage.getItem(tokenStorageKey) || ""; } catch { chatToken = ""; }
}
let chats = [];
let currentId = null;
let busy = false;
let ready = false;
let live = false;
let provider = "demo";
let controller = null;
let storageWarning = "";

function validMessages(messages) {
  return Array.isArray(messages) && messages.length <= maxStoredMessages && messages.length % 2 === 0 &&
    messages.every((m, i) => m && m.role === (i % 2 ? "assistant" : "user") &&
      typeof m.content === "string" && m.content.trim().length > 0 && Array.from(m.content).length <= 4000);
}

function readChats() {
  const saved = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(storageKey)) continue;
    try {
      const c = JSON.parse(localStorage.getItem(key));
      if (c && typeof c.id === "string" && key === storageKey + c.id && typeof c.title === "string" &&
          c.title.length <= 80 && validMessages(c.messages) && c.messages.length) saved.push(c);
    } catch { /* Ignore only the damaged entry, not every saved conversation. */ }
  }
  return saved.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

try { chats = readChats().slice(0, maxChats); }
catch { storageWarning = "Browser storage is unavailable. Chats will last only for this visit."; }

function persistChat(chat) {
  let attempts = 0;
  while (true) {
    try {
      localStorage.setItem(storageKey + chat.id, JSON.stringify(chat));
      return;
    } catch (error) {
      attempts += 1;
      let others = [];
      try { others = readChats().filter((saved) => saved.id !== chat.id); } catch { others = []; }
      if (!others.length || attempts > maxChats) throw error;
      try { localStorage.removeItem(storageKey + others[others.length - 1].id); } catch { throw error; }
    }
  }
}

function save(chat, deletedId = null, existing = false) {
  try {
    if (deletedId) localStorage.removeItem(storageKey + deletedId);
    if (chat) {
      if (existing && !localStorage.getItem(storageKey + chat.id) && !storageWarning) {
        showError("This chat was deleted in another tab. Start a new chat to continue.");
        currentId = null;
        chats = readChats().slice(0, maxChats);
        return;
      }
      chat.updatedAt = Date.now();
      persistChat(chat);
    }
    const latest = readChats();
    for (const old of latest.slice(maxChats)) localStorage.removeItem(storageKey + old.id);
    chats = latest.slice(0, maxChats);
  }
  catch {
    storageWarning = "Couldn't save this chat in your browser. It will last only for this visit.";
    showError(storageWarning);
  }
}

function showError(message) {
  $("#error").textContent = message;
  $("#error").hidden = !message;
}

function activeChat() { return chats.find((c) => c.id === currentId); }

function makeMessage(role, content, pending = false) {
  const item = document.createElement("article");
  item.className = `message ${role}${pending ? " pending" : ""}`;
  const name = document.createElement("div");
  name.className = "message-name";
  name.textContent = role === "user" ? "You" : (live ? (provider === "claude" ? "Claude" : "Assistant") : "Demo assistant");
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = content;
  item.append(name, body);
  return item;
}

function updateControls() {
  $("#send").disabled = !busy && (!ready || !$("#prompt").value.trim());
  $("#send").type = busy ? "button" : "submit";
  $("#send").textContent = busy ? "■" : "↑";
  $("#send").setAttribute("aria-label", busy ? "Stop response" : "Send message");
  $("#prompt").disabled = busy;
  $("#new-chat").disabled = busy;
  $("#clear-chat").disabled = busy || !activeChat();
  document.querySelectorAll(".history-item, .suggestion").forEach((b) => { b.disabled = busy || !ready; });
}

function render() {
  const chat = activeChat();
  $("#welcome").hidden = Boolean(chat);
  $("#chat-title").textContent = chat?.title || "New conversation";
  $("#messages").replaceChildren(...(chat?.messages || []).map((m) => makeMessage(m.role, m.content)));
  $("#chat-list").replaceChildren();
  for (const saved of chats) {
    const button = document.createElement("button");
    button.className = "history-item";
    button.textContent = saved.title;
    button.title = saved.title;
    if (saved.id === currentId) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => {
      if (busy) return;
      currentId = saved.id;
      $("#prompt").value = "";
      showError("");
      render();
      scrollToBottom();
    });
    $("#chat-list").append(button);
  }
  $("#history-empty").hidden = chats.length > 0;
  updateControls();
}

function scrollToBottom() {
  const scroll = $("#conversation-scroll");
  scroll.scrollTop = scroll.scrollHeight;
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sendMessage(event) {
  event.preventDefault();
  const content = $("#prompt").value.trim();
  if (busy || !ready || !content) return;
  if (content.length > 4000) { showError("Please keep messages under 4,000 characters."); return; }
  showError("");
  const existing = activeChat();
  const mode = live ? "live" : "demo";
  if (existing && ((existing.mode && existing.mode !== mode) || (existing.provider && existing.provider !== provider))) {
    showError("This chat was saved with a different AI mode. Start a new chat to continue.");
    return;
  }
  const chat = existing || { id: newId(), title: content.slice(0, 60), messages: [], mode, provider };
  chat.mode = chat.mode || mode;
  chat.provider = chat.provider || provider;
  // Send only a recent API window; keep the full transcript in this browser.
  const requestMessages = [...chat.messages.slice(-38), { role: "user", content }];
  $("#welcome").hidden = true;
  $("#messages").append(makeMessage("user", content), makeMessage("assistant", "Thinking…", true));
  $("#prompt").value = "";
  busy = true;
  controller = new AbortController();
  const timeout = setTimeout(() => controller?.abort("timeout"), 38000);
  updateControls();
  scrollToBottom();
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(chatToken ? { "X-Chat-Token": chatToken } : {}) },
      body: JSON.stringify({ messages: requestMessages, mode, provider }),
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Couldn't send your message. Please try again.");
    if (typeof result.reply !== "string" || !result.reply.trim()) throw new Error("The reply was empty. Please try again.");
    chat.messages = [...chat.messages, { role: "user", content }, { role: "assistant", content: result.reply }].slice(-maxStoredMessages);
    chats = [chat, ...chats.filter((c) => c.id !== chat.id)].slice(0, maxChats);
    currentId = chat.id;
    save(chat, null, Boolean(existing));
  } catch (error) {
    $("#prompt").value = content;
    const cancelled = controller.signal.aborted;
    showError(cancelled
      ? (controller.signal.reason === "timeout" ? "The reply took too long. Your message is ready to try again." : "Response stopped. Your message is ready to edit or send again.")
      : (error instanceof TypeError ? "Can't reach the server. Check your connection and try again." : error.message));
  } finally {
    clearTimeout(timeout);
    busy = false;
    controller = null;
    render();
    scrollToBottom();
    $("#prompt").focus();
  }
}

$("#chat-form").addEventListener("submit", sendMessage);
$("#prompt").addEventListener("input", updateControls);
$("#prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("#chat-form").requestSubmit();
  }
});
$("#send").addEventListener("click", () => { if (busy) controller?.abort("stopped"); });
$("#new-chat").addEventListener("click", () => {
  if (busy) return;
  currentId = null;
  $("#prompt").value = "";
  showError("");
  render();
  $("#conversation-scroll").scrollTop = 0;
  $("#prompt").focus();
});
$("#clear-chat").addEventListener("click", () => {
  if (busy || !activeChat()) return;
  if (!confirm("Delete this chat from this browser? This can't be undone.")) return;
  const deletedId = currentId;
  chats = chats.filter((c) => c.id !== deletedId);
  currentId = null;
  $("#prompt").value = "";
  showError("");
  save(null, deletedId);
  render();
});
document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => {
    $("#prompt").value = button.dataset.prompt;
    $("#chat-form").requestSubmit();
  });
});
for (const selector of ["#about-button", "#details-button"]) {
  $(selector).addEventListener("click", () => $("#about-dialog").showModal());
}
$("#close-about").addEventListener("click", () => $("#about-dialog").close());

async function configure() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Configuration unavailable.");
    const config = await response.json();
    live = config.mode === "live";
    provider = config.provider;
    ready = true;
    const service = provider === "claude" ? "Anthropic" : "demo";
    const assistant = live ? "Claude" : "Demo assistant";
    $("#about-button").textContent = live ? `${assistant} configured ↗` : "Demo preview ↗";
    $("#mode-label").textContent = assistant;
    if (live) {
      $("#welcome-note").textContent = `${assistant} configured · Brief answers, unless it's math.`;
      $("#privacy-note").textContent = `AI can make mistakes. Messages are sent to ${service}; chat history is saved in this browser.`;
      $("#about-mode").textContent = `This server is configured for live AI replies through ${service}. AI can make mistakes; check important details.`;
    }
    if (storageWarning) showError(storageWarning);
  } catch {
    $("#about-button").textContent = "Unavailable";
    $("#mode-label").textContent = "Not connected";
    showError("Can't connect to the chat server. Refresh the page to try again.");
  }
  render();
}

render();
configure();

window.addEventListener("storage", (event) => {
  if (busy || (event.key && !event.key.startsWith(storageKey))) return;
  try {
    chats = readChats().slice(0, maxChats);
    if (currentId && !activeChat()) currentId = null;
    render();
  } catch { /* The existing in-memory history remains usable. */ }
});
