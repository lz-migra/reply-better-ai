// A small, focused modal: a searchable list of { id, ...extras } with a "Use
// model" button on each row. Used by the OpenAI-compatible settings to expose
// the provider's GET /models endpoint. Reuses the existing .mp-* CSS so it
// looks identical to ModelPicker without dragging in its tabs/provider-filter.

const ICONS = {
  search: '<svg class="mp-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  empty: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>',
};

// Lightweight HTML-escape so any provider-supplied id (which we never render as
// textContent directly) can't break the page. The list is from a GET against
// the user's own base URL, but they paste arbitrary URLs — defense in depth.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export class ModelListModal {
  constructor({ overlay, title = "Available models", subtitle = "", onUse, onClose }) {
    this.overlay = overlay;
    this.title = title;
    this.subtitle = subtitle;
    this.onUse = onUse;
    this.onClose = onClose;
    this.models = [];
    this.query = "";
    this.currentId = "";
  }

  // Open with an already-fetched list — the caller does the network so we
  // can show "Couldn't reach the server" inline (no modal) when it fails.
  open(models, { currentId = "" } = {}) {
    this.models = Array.isArray(models) ? models : [];
    this.currentId = currentId;
    this.renderShell();
    this.renderBody();
    this.overlay.classList.add("show");
    this.overlay.setAttribute("aria-hidden", "false");
    setTimeout(() => this.searchInput?.focus(), 0);
    this.escapeListener = e => { if (e.key === "Escape") this.close(); };
    document.addEventListener("keydown", this.escapeListener);
  }

  close() {
    this.overlay.classList.remove("show");
    this.overlay.setAttribute("aria-hidden", "true");
    if (this.escapeListener) {
      document.removeEventListener("keydown", this.escapeListener);
      this.escapeListener = null;
    }
    this.card?.replaceChildren();
    this.card = null;
    this.onClose?.();
  }

  renderShell() {
    this.overlay.replaceChildren();
    const card = document.createElement("div");
    card.className = "mp";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", this.title);

    const head = document.createElement("div");
    head.className = "mp-head";
    const titleWrap = document.createElement("div");
    const titleEl = document.createElement("h2");
    titleEl.className = "mp-head-title";
    titleEl.textContent = this.title;
    titleWrap.appendChild(titleEl);
    if (this.subtitle) {
      const sub = document.createElement("p");
      sub.className = "mp-head-sub";
      sub.textContent = this.subtitle;
      titleWrap.appendChild(sub);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mp-back";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = `${ICONS.close} Close`;
    close.addEventListener("click", () => this.close());
    head.append(titleWrap, close);
    card.appendChild(head);

    // Search filter (reuses .mp-filters + .mp-search-wrap from model-picker.css)
    const filters = document.createElement("div");
    filters.className = "mp-filters";
    const searchWrap = document.createElement("div");
    searchWrap.className = "mp-search-wrap";
    searchWrap.innerHTML = ICONS.search;
    const search = document.createElement("input");
    search.type = "search";
    search.className = "mp-search";
    search.placeholder = "Filter models…";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.setAttribute("aria-label", "Filter models");
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "mp-search-clear";
    clear.setAttribute("aria-label", "Clear search");
    clear.innerHTML = ICONS.x;
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      searchWrap.classList.toggle("has-value", !!search.value);
      this.renderBody();
    });
    clear.addEventListener("click", () => {
      search.value = "";
      this.query = "";
      searchWrap.classList.remove("has-value");
      search.focus();
      this.renderBody();
    });
    searchWrap.append(search, clear);
    filters.appendChild(searchWrap);
    card.appendChild(filters);

    const list = document.createElement("div");
    list.className = "mp-list";
    card.appendChild(list);

    this.overlay.appendChild(card);
    this.card = card;
    this.list = list;
    this.searchInput = search;
  }

  renderBody() {
    if (!this.list) return;
    this.list.replaceChildren();
    const q = this.query;
    const filtered = q ? this.models.filter(m => m.id.toLowerCase().includes(q) || (m.owned_by || "").toLowerCase().includes(q)) : this.models;
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.innerHTML = `${ICONS.empty}<div>${q ? "No models match your search." : "No models returned by this provider."}</div>`;
      this.list.appendChild(empty);
      return;
    }
    for (const m of filtered) {
      this.list.appendChild(this.renderRow(m));
    }
  }

  renderRow(m) {
    const row = document.createElement("div");
    row.className = "mp-row";
    if (m.id === this.currentId) {
      row.classList.add("selected");
      row.setAttribute("aria-selected", "true");
    }
    row.tabIndex = 0;

    // Reuse the same avatar/main/aside grid as ModelPicker — providers can't be
    // guessed from a generic { id, owned_by } (which is often null on self-
    // hosted servers), so we render just the id and a provider hint when known.
    const avatar = document.createElement("div");
    avatar.className = "mp-row-avatar";
    avatar.textContent = (m.id.match(/[a-zA-Z]/g)?.[0] || "?").toUpperCase();
    row.appendChild(avatar);

    const main = document.createElement("div");
    main.className = "mp-row-main";
    const name = document.createElement("div");
    name.className = "mp-row-name";
    name.textContent = m.id;
    main.appendChild(name);
    if (m.owned_by) {
      const sub = document.createElement("div");
      sub.className = "mp-row-id";
      sub.textContent = m.owned_by;
      main.appendChild(sub);
    }
    row.appendChild(main);

    const use = document.createElement("button");
    use.type = "button";
    use.className = "rb-btn rb-btn-primary rb-btn-sm";
    use.textContent = m.id === this.currentId ? "In use" : "Use model";
    use.disabled = m.id === this.currentId;
    use.addEventListener("click", e => {
      e.stopPropagation();
      this.onUse?.(m);
    });
    row.appendChild(use);

    row.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!use.disabled) this.onUse?.(m); }
    });

    // No readonly escapes — every piece of user-rendered text is set via
    // .textContent above. escapeHtml is exported (see top) for callers that
    // later want to add a header snippet with HTML.
    return row;
  }
}

export { escapeHtml };
