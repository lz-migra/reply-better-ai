// Groq model picker — much simpler than the OpenRouter one because Groq has
// a small curated catalog (no pricing tiers, no providers to filter, no
// "popular" tab). The list comes from getGroqModels() and is already in the
// shape { id, owned_by, context_window }. We just render rows, let the user
// search by id or owner, and call onSelect.

import { getGroqModels } from "../../lib/groq-models.js";

const ICONS = {
  back: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  search: '<svg class="mp-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  ctx: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  empty: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>',
  refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>',
};

function fmtCtx(n) {
  if (!n || !Number.isFinite(n)) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export class GroqModelPicker {
  constructor({ container, onSelect, onClose, currentModelId }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onClose = onClose;
    this.currentModelId = currentModelId;
    this.searchQuery = "";
    this.models = [];
    this.stale = false;
    this.error = null;
    this.loading = true;
  }

  async open() {
    this.renderShell();
    await this.refresh({ forceRefresh: false });
  }

  async refresh({ forceRefresh = false } = {}) {
    this.loading = true;
    this.error = null;
    this.renderBody();
    try {
      const result = await getGroqModels({ forceRefresh });
      this.models = result.models;
      this.stale = result.stale;
      this.error = result.error || null;
    } catch (err) {
      this.error = err;
      if (this.models.length > 0) this.stale = true;
    } finally {
      this.loading = false;
      this.renderBody();
    }
  }

  renderShell() {
    this.container.replaceChildren();
    const mp = document.createElement("div");
    mp.className = "mp";
    this.mp = mp;

    const head = document.createElement("div");
    head.className = "mp-head";
    const titleWrap = document.createElement("div");
    const title = document.createElement("h2");
    title.className = "mp-head-title";
    title.textContent = "Choose a Groq model";
    const sub = document.createElement("p");
    sub.className = "mp-head-sub";
    sub.textContent = "Free tier · routed through Groq";
    titleWrap.append(title, sub);
    const back = document.createElement("button");
    back.type = "button";
    back.className = "mp-back";
    back.innerHTML = `${ICONS.back} Back`;
    back.addEventListener("click", () => this.onClose?.());
    head.append(titleWrap, back);
    mp.appendChild(head);

    const searchRow = document.createElement("div");
    searchRow.className = "mp-search";
    const searchIcon = document.createElement("span");
    searchIcon.className = "mp-search-wrap";
    searchIcon.innerHTML = ICONS.search;
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Search models…";
    input.className = "mp-search-input";
    input.addEventListener("input", () => {
      this.searchQuery = input.value.trim().toLowerCase();
      this.renderBody();
    });
    searchRow.append(searchIcon, input);
    mp.appendChild(searchRow);

    this.list = document.createElement("div");
    this.list.className = "mp-list";
    mp.appendChild(this.list);

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "mp-refresh";
    refresh.innerHTML = `${ICONS.refresh} Refresh`;
    refresh.addEventListener("click", () => this.refresh({ forceRefresh: true }));
    mp.appendChild(refresh);

    this.container.appendChild(mp);
  }

  renderBody() {
    if (!this.list) return;
    this.list.replaceChildren();

    if (this.loading && this.models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.textContent = "Loading models…";
      this.list.appendChild(empty);
      return;
    }

    if (this.error && this.models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.innerHTML = `<div>${ICONS.empty}</div><div>Couldn't load Groq models.</div><div class="mp-empty-sub">${this.error?.userMessage || this.error?.message || "Check your API key and connection."}</div>`;
      this.list.appendChild(empty);
      return;
    }

    if (this.models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.innerHTML = `<div>${ICONS.empty}</div><div>No models available.</div><div class="mp-empty-sub">Save your Groq API key first, then refresh.</div>`;
      this.list.appendChild(empty);
      return;
    }

    const q = this.searchQuery;
    const filtered = q
      ? this.models.filter(m => (m.id + " " + (m.owned_by || "")).toLowerCase().includes(q))
      : this.models;

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.textContent = `No matches for "${q}".`;
      this.list.appendChild(empty);
      return;
    }

    for (const m of filtered) {
      this.list.appendChild(this.renderRow(m));
    }
  }

  renderRow(m) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mp-row";
    if (m.id === this.currentModelId) row.classList.add("mp-row-current");
    row.dataset.id = m.id;
    const ctx = fmtCtx(m.context_window);
    row.innerHTML = `
      <span class="mp-row-avatar">${(m.id[0] || "?").toUpperCase()}</span>
      <span class="mp-row-body">
        <span class="mp-row-name">${m.id}</span>
        <span class="mp-row-meta">${m.owned_by ? m.owned_by + " · " : ""}${ctx ? ctx + " context" : ""}</span>
      </span>
      ${m.id === this.currentModelId ? '<span class="mp-row-check">' + ICONS.check + "</span>" : ""}
    `;
    row.addEventListener("click", () => {
      this.onSelect?.({ id: m.id, name: m.id });
    });
    return row;
  }
}
