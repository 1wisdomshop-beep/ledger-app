(function () {
  "use strict";

  // -------------------------------------------------------------
  // Date helpers (all LOCAL-time based)
  // -------------------------------------------------------------
  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function addDaysLocal(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  function toDateInputValue(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // -------------------------------------------------------------
  // State
  // -------------------------------------------------------------
  const CURRENCIES = ["USD", "EUR", "RUB", "TL", "TRANSFERRED_TL"];
  const MAX_ROWS = CURRENCIES.length;

  const state = {
    lang: localStorage.getItem("ledger_lang") || "en",
    currentView: "submission",
    rowCounter: 0,
    selectedDate: startOfDay(new Date()),
    weeks: [],
    observer: null,
    editingRowIds: new Set(),
    pinnedTooltipEl: null, // the element whose tooltip is "tapped open" (mobile)
  };

  // -------------------------------------------------------------
  // DOM refs
  // -------------------------------------------------------------
  const el = {
    tabbar: document.getElementById("tabbar"),
    langSwitch: document.getElementById("lang-switch"),
    viewSubmission: document.getElementById("view-submission"),
    viewDashboard: document.getElementById("view-dashboard"),
    viewData: document.getElementById("view-data"),
    form: document.getElementById("entry-form"),
    clientName: document.getElementById("client-name"),
    datePrev: document.getElementById("date-prev"),
    dateNext: document.getElementById("date-next"),
    dateDisplay: document.getElementById("date-display"),
    dateNativeInput: document.getElementById("date-native-input"),
    currencyRows: document.getElementById("currency-rows"),
    addCurrencyBtn: document.getElementById("add-currency-btn"),
    submitBtn: document.getElementById("submit-btn"),
    formMessage: document.getElementById("form-message"),
    ratesNote: document.getElementById("rates-note"),
    weeksList: document.getElementById("weeks-list"),
    chartTooltip: document.getElementById("chart-tooltip"),
    toast: document.getElementById("toast"),
    entriesGroups: document.getElementById("entries-groups"),
    entriesGroupsEmpty: document.getElementById("entries-groups-empty"),
    ratesGridBody: document.getElementById("rates-grid-body"),
    addRowBtn: document.getElementById("add-row-btn"),
    exportEntriesBtn: document.getElementById("export-entries-btn"),
    exportRatesBtn: document.getElementById("export-rates-btn"),
    exportBackupBtn: document.getElementById("export-backup-btn"),
    importBackupInput: document.getElementById("import-backup-input"),
    entryModalOverlay: document.getElementById("entry-modal-overlay"),
    entryModalClose: document.getElementById("entry-modal-close"),
    modalClient: document.getElementById("modal-client"),
    modalDate: document.getElementById("modal-date"),
    modalAmounts: document.getElementById("modal-amounts"),
    modalTotal: document.getElementById("modal-total"),
    modalCreated: document.getElementById("modal-created"),
    modalHistoryList: document.getElementById("modal-history-list"),
  };

  // -------------------------------------------------------------
  // i18n helpers
  // -------------------------------------------------------------
  function t(key) {
    return (I18N[state.lang] && I18N[state.lang][key]) || I18N.en[key] || key;
  }
  function currencyLabel(code) {
    return t("currency." + code);
  }
  function applyStaticTranslations() {
    document.documentElement.lang = state.lang;
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      node.textContent = t(node.getAttribute("data-i18n"));
    });
    document
      .querySelectorAll(".lang-option")
      .forEach((btn) => btn.classList.toggle("is-active", btn.dataset.lang === state.lang));
    refreshCurrencySelectLabels();
    renderDateDisplay();
    if (state.currentView === "dashboard") renderWeeks();
    if (state.currentView === "data") renderEntriesGroups();
  }
  function setLang(lang) {
    if (!I18N[lang]) return;
    state.lang = lang;
    localStorage.setItem("ledger_lang", lang);
    applyStaticTranslations();
  }

  // -------------------------------------------------------------
  // View switching (persistent 3-tab nav; a bottom bar on phones)
  // -------------------------------------------------------------
  function showView(name) {
    state.currentView = name;
    el.viewSubmission.classList.toggle("is-active", name === "submission");
    el.viewDashboard.classList.toggle("is-active", name === "dashboard");
    el.viewData.classList.toggle("is-active", name === "data");
    el.tabbar.querySelectorAll(".tab").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.view === name));
    if (name === "dashboard") renderWeeks();
    if (name === "data") renderEntriesGroups();
  }
  el.tabbar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (btn) showView(btn.dataset.view);
  });
  el.langSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest(".lang-option");
    if (btn) setLang(btn.dataset.lang);
  });

  // -------------------------------------------------------------
  // Date stepper
  // -------------------------------------------------------------
  function renderDateDisplay() {
    const today = startOfDay(new Date());
    const isToday = isSameDay(state.selectedDate, today);
    const formatted = new Intl.DateTimeFormat(I18N_LOCALES[state.lang], {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(state.selectedDate);
    el.dateDisplay.textContent = isToday ? `${t("submission.today")} \u00b7 ${formatted}` : formatted;
    el.dateNext.disabled = isToday;
    el.dateNativeInput.max = toDateInputValue(today);
    el.dateNativeInput.value = toDateInputValue(state.selectedDate);
  }
  function shiftDate(days) {
    const today = startOfDay(new Date());
    let next = addDaysLocal(state.selectedDate, days);
    if (next > today) next = today;
    state.selectedDate = next;
    renderDateDisplay();
  }
  el.datePrev.addEventListener("click", () => shiftDate(-1));
  el.dateNext.addEventListener("click", () => shiftDate(1));
  el.dateNativeInput.addEventListener("change", () => {
    if (!el.dateNativeInput.value) return;
    const [y, m, d] = el.dateNativeInput.value.split("-").map(Number);
    const picked = new Date(y, m - 1, d);
    const today = startOfDay(new Date());
    state.selectedDate = picked > today ? today : picked;
    renderDateDisplay();
  });

  // -------------------------------------------------------------
  // Currency rows (the "+" behaviour)
  // -------------------------------------------------------------
  function usedCurrencies() {
    return [...el.currencyRows.querySelectorAll(".currency-select")].map((s) => s.value);
  }
  function refreshCurrencySelectLabels() {
    el.currencyRows.querySelectorAll(".currency-select").forEach(populateSelectOptions);
  }
  function populateSelectOptions(select) {
    const current = select.value;
    const used = usedCurrencies();
    select.innerHTML = "";
    CURRENCIES.forEach((code) => {
      if (code === current || !used.includes(code)) {
        const opt = document.createElement("option");
        opt.value = code;
        opt.textContent = currencyLabel(code);
        if (code === current) opt.selected = true;
        select.appendChild(opt);
      }
    });
  }
  function nextAvailableCurrency() {
    const used = usedCurrencies();
    return CURRENCIES.find((c) => !used.includes(c));
  }
  function updateAddButtonState() {
    const rowCount = el.currencyRows.children.length;
    el.addCurrencyBtn.disabled = rowCount >= MAX_ROWS;
    el.currencyRows
      .querySelectorAll(".remove-row-btn")
      .forEach((btn) => (btn.style.visibility = rowCount > 1 ? "visible" : "hidden"));
  }
  function addCurrencyRow() {
    const code = nextAvailableCurrency();
    if (!code) return;

    const id = "row-" + ++state.rowCounter;
    const row = document.createElement("div");
    row.className = "currency-row";
    row.dataset.rowId = id;

    const select = document.createElement("select");
    select.className = "currency-select";
    select.addEventListener("change", refreshCurrencySelectLabels);

    const amount = document.createElement("input");
    amount.type = "number";
    amount.className = "amount-input";
    amount.step = "0.01";
    amount.min = "0.01";
    amount.placeholder = "0.00";
    amount.inputMode = "decimal";
    amount.required = true;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-row-btn";
    removeBtn.setAttribute("aria-label", "Remove");
    removeBtn.textContent = "\u2715";
    removeBtn.addEventListener("click", () => {
      row.remove();
      refreshCurrencySelectLabels();
      updateAddButtonState();
    });

    row.append(select, amount, removeBtn);
    el.currencyRows.appendChild(row);

    populateSelectOptions(select);
    select.value = code;
    refreshCurrencySelectLabels();
    updateAddButtonState();
    amount.focus();
  }
  el.addCurrencyBtn.addEventListener("click", addCurrencyRow);

  // -------------------------------------------------------------
  // Toast
  // -------------------------------------------------------------
  let toastTimer = null;
  function showToast(message, kind) {
    clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.className = "toast is-visible" + (kind ? " is-" + kind : "");
    toastTimer = setTimeout(() => el.toast.classList.remove("is-visible"), 3200);
  }

  // -------------------------------------------------------------
  // Rates note on the Submission form
  // -------------------------------------------------------------
  function renderRatesNote() {
    const rates = {};
    DB.listRates().forEach((r) => (rates[r.currency_code] = r.rate_to_usd));
    el.ratesNote.textContent = t("submission.ratesNote")
      .replace("{eur}", Number(rates.EUR || 0).toFixed(4))
      .replace("{rub}", Number(rates.RUB || 0).toFixed(4))
      .replace("{tl}", Number(rates.TL || 0).toFixed(4));
  }

  // -------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------
  function setFormMessage(text, kind) {
    el.formMessage.textContent = text;
    el.formMessage.className = "form-message" + (kind ? " is-" + kind : "");
  }
  function resetForm() {
    el.clientName.value = "";
    el.currencyRows.innerHTML = "";
    addCurrencyRow();
    state.selectedDate = startOfDay(new Date());
    renderDateDisplay();
  }

  // Enter on the client name field feels like "next field", not "submit":
  // move focus to the first amount input instead of letting the browser's
  // implicit form-submit-on-Enter behaviour fire.
  el.clientName.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const firstAmount = el.currencyRows.querySelector(".amount-input");
    if (firstAmount) firstAmount.focus();
  });

  // Enter on an amount field should just close the on-screen keyboard, not
  // submit the form (a currency row's amount is often the last focusable
  // field, so the browser's default behaviour would otherwise submit
  // immediately, even with other rows still empty). Delegated on the
  // container so it covers every currency row added later, too.
  el.currencyRows.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.classList.contains("amount-input")) return;
    e.preventDefault();
    e.target.blur();
  });

  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setFormMessage("");

    const clientName = el.clientName.value.trim();
    if (!clientName) {
      setFormMessage(t("submission.clientRequired"), "error");
      el.clientName.focus();
      return;
    }

    const entries = [...el.currencyRows.querySelectorAll(".currency-row")].map((row) => ({
      currency: row.querySelector(".currency-select").value,
      amount: parseFloat(row.querySelector(".amount-input").value),
    }));

    if (entries.some((en) => !en.amount || en.amount <= 0)) {
      setFormMessage(t("submission.amountInvalid"), "error");
      return;
    }

    el.submitBtn.disabled = true;
    el.submitBtn.classList.add("is-loading");

    try {
      const entry_date = toDateInputValue(state.selectedDate);
      const amounts = {};
      entries.forEach((en) => (amounts[en.currency] = en.amount));
      // created_at is stamped automatically by the entries table's default,
      // so every new row -- from here or from "Add row" in Data -- carries
      // an exact creation timestamp from the moment it lands in the DB.
      await DB.insertEntryMulti({ entry_date, client_name: clientName, amounts });
      setFormMessage(t("submission.success"), "success");
      showToast(t("submission.success"), "success");
      resetForm();
    } catch (err) {
      setFormMessage(err.message || "Error", "error");
      showToast(err.message || "Error", "error");
    } finally {
      el.submitBtn.disabled = false;
      el.submitBtn.classList.remove("is-loading");
    }
  });

  // -------------------------------------------------------------
  // Tooltips: hover on desktop, tap-to-toggle on touch/mobile.
  //
  // A plain mouseenter/mouseleave pair (the original implementation)
  // never fires on a touchscreen, so anything shown only on hover was
  // invisible on phones. Adding a click handler fixes that for free:
  // a tap dispatches a click on every platform, so the same handler
  // both preserves desktop hover *and* gives mobile a way in. Tapping
  // the same element again, or tapping anywhere else on the page,
  // closes it.
  // -------------------------------------------------------------
  function attachTapTooltip(target, getText, opts) {
    const show = () => showChartTooltip(target, getText(), opts);
    target.addEventListener("mouseenter", show);
    target.addEventListener("focus", show);
    target.addEventListener("mouseleave", hideChartTooltip);
    target.addEventListener("blur", hideChartTooltip);
    target.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.pinnedTooltipEl === target) {
        hideChartTooltip();
        state.pinnedTooltipEl = null;
      } else {
        show();
        state.pinnedTooltipEl = target;
      }
    });
  }
  document.addEventListener("click", () => {
    if (state.pinnedTooltipEl) {
      hideChartTooltip();
      state.pinnedTooltipEl = null;
    }
  });

  // -------------------------------------------------------------
  // Dashboard -- vertical stack of weeks, newest on top
  // -------------------------------------------------------------
  function formatWeekLabel(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return new Intl.DateTimeFormat(I18N_LOCALES[state.lang], { month: "short", day: "numeric" }).format(date);
  }
  function formatDayLabel(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return new Intl.DateTimeFormat(I18N_LOCALES[state.lang], { weekday: "short", month: "short", day: "numeric" }).format(date);
  }
  function formatMoney(n) {
    return Number(n).toLocaleString(I18N_LOCALES[state.lang], { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  /** "2026-09-18 14:03:21" (sqlite UTC) -> localized date + time for display. */
  function formatTimestamp(sqliteUtcString) {
    if (!sqliteUtcString) return "\u2014";
    const date = new Date(sqliteUtcString.replace(" ", "T") + "Z");
    if (isNaN(date.getTime())) return sqliteUtcString;
    return new Intl.DateTimeFormat(I18N_LOCALES[state.lang], {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(date);
  }

  function renderEmptyDashboard() {
    el.weeksList.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "dashboard-empty";
    wrap.innerHTML = `
      <svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>
      </svg>
      <h2>${t("dashboard.empty")}</h2>
      <p>${t("dashboard.emptyHint")}</p>
      <button type="button" class="btn-chip" id="empty-cta">${t("dashboard.emptyCta")}</button>
    `;
    el.weeksList.appendChild(wrap);
    document.getElementById("empty-cta").addEventListener("click", () => showView("submission"));
  }

  function showChartTooltip(target, text, opts) {
    const wide = !!(opts && opts.wide);
    const rect = target.getBoundingClientRect();
    el.chartTooltip.textContent = text;
    el.chartTooltip.classList.toggle("tooltip-wide", wide);

    const halfWidth = wide ? 110 : 4;
    const margin = 10;
    let left = rect.left + rect.width / 2;
    left = Math.min(Math.max(left, margin + halfWidth), window.innerWidth - margin - halfWidth);

    el.chartTooltip.style.left = left + "px";
    el.chartTooltip.style.top = rect.top + "px";
    el.chartTooltip.classList.add("is-visible");
  }
  function hideChartTooltip() {
    el.chartTooltip.classList.remove("is-visible");
  }

  /**
   * Groups a week's raw entries by client name (case-insensitively; the
   * most recently used capitalization is kept as the display name, since
   * rows arrive newest-first) and sums their amounts per currency plus
   * the USD-converted total. Sorted by that USD total, highest first.
   */
  function computeClientTotals(rows) {
    const map = new Map();
    rows.forEach((row) => {
      const key = (row.client_name || "").trim().toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          name: (row.client_name || "").trim() || "\u2014",
          amount_usd: 0,
          amount_eur: 0,
          amount_rub: 0,
          amount_tl: 0,
          amount_transferred_tl: 0,
          converted_total_usd: 0,
        });
      }
      const agg = map.get(key);
      agg.amount_usd += Number(row.amount_usd) || 0;
      agg.amount_eur += Number(row.amount_eur) || 0;
      agg.amount_rub += Number(row.amount_rub) || 0;
      agg.amount_tl += Number(row.amount_tl) || 0;
      agg.amount_transferred_tl += Number(row.amount_transferred_tl) || 0;
      agg.converted_total_usd += Number(row.converted_total_usd) || 0;
    });
    return [...map.values()].sort((a, b) => b.converted_total_usd - a.converted_total_usd);
  }
  function buildClientRow(client) {
    const row = document.createElement("div");
    row.className = "client-row";
    row.innerHTML = `
      <span class="client-row-name">${escapeHtml(client.name)}</span>
      <span class="client-row-tags">${buildAmountTags(client) || "\u2014"}</span>
      <span class="client-row-total mono">${formatMoney(client.converted_total_usd)} USD</span>
    `;
    return row;
  }

  function renderWeeks() {
    state.weeks = DB.getDashboardWeeks();
    el.weeksList.innerHTML = "";
    if (!state.weeks.length) {
      renderEmptyDashboard();
      return;
    }
    const globalMax = Math.max(1, ...state.weeks.flatMap((w) => w.days));
    const weeklyTotals = DB.getWeeklyCurrencyTotals();

    // Newest week first (feed style) -- reverse the ascending list from DB.
    const weeksNewestFirst = state.weeks.slice().reverse();

    weeksNewestFirst.forEach((week, displayIdx) => {
      const isCurrent = displayIdx === 0;

      const card = document.createElement("div");
      card.className = "week-card" + (isCurrent ? " is-current" : "");

      const header = document.createElement("div");
      header.className = "week-card-header";
      header.innerHTML = `
        <span class="week-range mono">${formatWeekLabel(week.week_start)} \u2013 ${formatWeekLabel(week.week_end)}</span>
        <span class="total-pill mono">${formatMoney(week.total)} USD</span>
      `;
      card.appendChild(header);

      // Always-visible per-currency breakdown -- no hover/tap needed here,
      // since this is exactly the information a phone user couldn't
      // otherwise reach without a mouse.
      const breakdown = document.createElement("div");
      breakdown.className = "week-card-breakdown mono";
      breakdown.textContent = buildAmountTags(weeklyTotals[week.week_start]) || "\u2014";
      card.appendChild(breakdown);

      const barsRow = document.createElement("div");
      barsRow.className = "bars-row";

      week.days.forEach((value, dayIdx) => {
        const col = document.createElement("div");
        col.className = "bar-col";

        const track = document.createElement("div");
        track.className = "bar-track";
        const bar = document.createElement("div");
        bar.className = "bar";
        bar.tabIndex = 0;
        bar.style.height = Math.max(2, (value / globalMax) * 100) + "%";

        const dayDate = addDaysLocal(new Date(week.week_start + "T00:00:00"), dayIdx);
        attachTapTooltip(bar, () => `${formatDayLabel(toDateInputValue(dayDate))} \u00b7 ${formatMoney(value)} USD`);
        track.appendChild(bar);

        const label = document.createElement("div");
        label.className = "bar-day";
        label.textContent = t("day." + dayIdx);

        col.append(track, label);
        barsRow.appendChild(col);
      });

      card.appendChild(barsRow);

      // Per-client breakdown: collapsed by default, built lazily the first
      // time it's opened, then just shown/hidden after that -- no re-render
      // of the whole dashboard, so opening/closing it stays instant and
      // doesn't disturb scroll position.
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "week-clients-toggle";
      toggleBtn.setAttribute("aria-expanded", "false");
      toggleBtn.innerHTML = `
        <svg class="chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        <span>${t("dashboard.clients")}</span>
      `;

      const panel = document.createElement("div");
      panel.className = "week-clients-panel";
      panel.hidden = true;

      let panelBuilt = false;
      toggleBtn.addEventListener("click", () => {
        const expanded = toggleBtn.getAttribute("aria-expanded") === "true";
        if (!expanded && !panelBuilt) {
          const clients = computeClientTotals(DB.getWeekEntries(week.week_start));
          if (!clients.length) {
            const empty = document.createElement("p");
            empty.className = "week-clients-empty";
            empty.textContent = t("dashboard.clientsEmpty");
            panel.appendChild(empty);
          } else {
            clients.forEach((c) => panel.appendChild(buildClientRow(c)));
          }
          panelBuilt = true;
        }
        toggleBtn.setAttribute("aria-expanded", String(!expanded));
        panel.hidden = expanded;
      });

      card.appendChild(toggleBtn);
      card.appendChild(panel);

      el.weeksList.appendChild(card);
    });
  }

  // -------------------------------------------------------------
  // Data view: Reading state (grouped by week -> day) with a
  // per-row edit toggle that swaps that one row into input fields.
  // -------------------------------------------------------------
  const CURRENCY_TAGS = [
    { field: "amount_usd", symbol: "$", suffix: false },
    { field: "amount_eur", symbol: "\u20ac", suffix: false },
    { field: "amount_rub", symbol: "\u20bd", suffix: false },
    { field: "amount_tl", symbol: "TL", suffix: true },
    { field: "amount_transferred_tl", symbol: "TL (transferred)", suffix: true },
  ];
  const EDIT_FIELDS = [
    { field: "entry_date", type: "date", labelKey: "data.col.date" },
    { field: "client_name", type: "text", labelKey: "data.col.client" },
    { field: "amount_usd", type: "number", labelKey: "data.col.usd" },
    { field: "amount_eur", type: "number", labelKey: "data.col.eur" },
    { field: "amount_rub", type: "number", labelKey: "data.col.rub" },
    { field: "amount_tl", type: "number", labelKey: "data.col.tl" },
    { field: "amount_transferred_tl", type: "number", labelKey: "data.col.transferredTl" },
  ];
  const FIELD_LABEL_KEYS = Object.fromEntries(EDIT_FIELDS.map((f) => [f.field, f.labelKey]));

  function formatCompactAmount(n) {
    const fixed = Number(n).toFixed(2);
    return fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed.replace(/0$/, "");
  }
  function buildAmountTags(row) {
    if (!row) return "";
    return CURRENCY_TAGS.filter(({ field }) => Number(row[field]) > 0)
      .map(({ field, symbol, suffix }) => (suffix ? `${formatCompactAmount(row[field])} ${symbol}` : `${formatCompactAmount(row[field])} ${symbol}`))
      .join(", ");
  }

  function weekBreakdownTooltipText(weekStart, weeklyTotals) {
    const totals = weeklyTotals[weekStart];
    const tags = totals ? buildAmountTags(totals) : "";
    return `${t("tooltip.week")}: ${tags || "\u2014"}`;
  }

  // rows come newest-first from DB.listEntries(); since sorted primarily by
  // entry_date, consecutive same-date (and therefore same-week) rows are
  // guaranteed adjacent, so a single pass groups them correctly.
  function groupEntriesForReading(rows) {
    const weeks = [];
    let week = null;
    let day = null;
    rows.forEach((row) => {
      if (!week || week.week_start !== row.week_start_date) {
        const start = new Date(row.week_start_date + "T00:00:00");
        const end = addDaysLocal(start, 6);
        week = { week_start: row.week_start_date, week_end: toDateInputValue(end), total: 0, days: [] };
        weeks.push(week);
        day = null;
      }
      if (!day || day.date !== row.entry_date) {
        day = { date: row.entry_date, total: 0, rows: [] };
        week.days.push(day);
      }
      day.rows.push(row);
      day.total += row.converted_total_usd;
      week.total += row.converted_total_usd;
    });
    return weeks;
  }

  function renderEntriesGroups() {
    const rows = DB.listEntries();
    el.entriesGroups.innerHTML = "";
    el.entriesGroupsEmpty.hidden = rows.length > 0;
    if (!rows.length) return;

    const weeks = groupEntriesForReading(rows);
    const weeklyTotals = DB.getWeeklyCurrencyTotals();

    weeks.forEach((week) => {
      const weekCard = document.createElement("div");
      weekCard.className = "entries-week-card";
      weekCard.innerHTML = `
        <div class="entries-week-card-header">
          <span class="week-range mono">${formatWeekLabel(week.week_start)} \u2013 ${formatWeekLabel(week.week_end)}</span>
          <span class="total-pill mono" tabindex="0">${formatMoney(week.total)} USD</span>
        </div>
      `;
      const weekPill = weekCard.querySelector(".total-pill");
      attachTapTooltip(weekPill, () => weekBreakdownTooltipText(week.week_start, weeklyTotals), { wide: true });

      week.days.forEach((day) => {
        const dayGroup = document.createElement("div");
        dayGroup.className = "day-group";
        dayGroup.innerHTML = `
          <div class="day-group-header">
            <span class="day-group-date">${formatDayLabel(day.date)}</span>
            <span class="day-group-total mono">${formatMoney(day.total)} USD</span>
          </div>
        `;

        const rowsWrap = document.createElement("div");
        rowsWrap.className = "day-group-rows";
        day.rows.forEach((row) => rowsWrap.appendChild(buildEntryRow(row)));
        dayGroup.appendChild(rowsWrap);

        weekCard.appendChild(dayGroup);
      });

      el.entriesGroups.appendChild(weekCard);
    });
  }

  function buildEntryRow(row) {
    const isEditing = state.editingRowIds.has(row.id);
    const div = document.createElement("div");
    div.className = "entry-row" + (isEditing ? " is-editing" : "");
    div.dataset.id = row.id;

    if (!isEditing) {
      div.innerHTML = `
        <button type="button" class="row-edit-btn" aria-label="Edit">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <span class="row-client">${escapeHtml(row.client_name || "\u2014")}</span>
        <span class="row-tags">${buildAmountTags(row) || "\u2014"}</span>
        <span class="row-total mono">${formatMoney(row.converted_total_usd)} USD</span>
      `;
      div.querySelector(".row-edit-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        state.editingRowIds.add(row.id);
        renderEntriesGroups();
      });
      // Tapping/clicking anywhere else on the row (but not while editing)
      // opens the read-only details popup: name, amounts, created-at
      // timestamp, and the log of any saved edits.
      div.tabIndex = 0;
      div.addEventListener("click", (e) => {
        if (e.target.closest(".row-edit-btn")) return;
        openEntryModal(row);
      });
      div.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.target.closest(".row-edit-btn")) {
          e.preventDefault();
          openEntryModal(row);
        }
      });
      return div;
    }

    // Editing state for this one row
    EDIT_FIELDS.forEach(({ field, type, labelKey }) => {
      const wrap = document.createElement("div");
      wrap.className = "edit-field" + (field === "client_name" ? " edit-field-client" : "");
      const label = document.createElement("label");
      label.textContent = t(labelKey);
      const input = document.createElement("input");
      input.className = "cell-input" + (type === "number" ? " cell-number" : "");
      input.type = type;
      if (type === "number") {
        input.step = "0.01";
        input.value = Number(row[field]).toFixed(2);
      } else {
        input.value = row[field];
      }
      input.dataset.field = field;
      input.dataset.type = type;
      wrap.append(label, input);
      div.appendChild(wrap);
    });

    const actions = document.createElement("div");
    actions.className = "row-edit-actions";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "row-save-btn";
    saveBtn.innerHTML = "\u2713";
    saveBtn.addEventListener("click", async () => {
      try {
        const changes = {};
        div.querySelectorAll("input[data-field]").forEach((input) => {
          const field = input.dataset.field;
          changes[field] = input.dataset.type === "number" ? parseFloat(input.value) || 0 : input.value.trim();
        });
        // Only fields that actually changed get written and logged --
        // saveEntryChanges compares against what's currently stored.
        await DB.saveEntryChanges(row.id, changes);
        state.editingRowIds.delete(row.id);
        renderEntriesGroups();
      } catch (err) {
        showToast(err.message || "Error", "error");
      }
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "row-delete-btn";
    delBtn.innerHTML = "\u2715";
    delBtn.addEventListener("click", async () => {
      if (!confirm(t("data.deleteConfirm"))) return;
      await DB.deleteEntry(row.id);
      state.editingRowIds.delete(row.id);
      renderEntriesGroups();
    });

    actions.append(saveBtn, delBtn);
    div.appendChild(actions);
    return div;
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // -------------------------------------------------------------
  // Entry details popup: name, amounts, created-at timestamp, and
  // the log of any edits made to the row since it was created.
  // -------------------------------------------------------------
  function formatHistoryValue(field, value) {
    if (field === "entry_date") return formatDayLabel(value);
    if (field === "client_name") return value || "\u2014";
    return formatCompactAmount(Number(value) || 0);
  }
  function openEntryModal(row) {
    el.modalClient.textContent = row.client_name || "\u2014";
    el.modalDate.textContent = formatDayLabel(row.entry_date);
    el.modalAmounts.textContent = buildAmountTags(row) || "\u2014";
    el.modalTotal.textContent = formatMoney(row.converted_total_usd) + " USD";
    el.modalCreated.textContent = formatTimestamp(row.created_at);

    const history = DB.getEntryHistory(row.id);
    el.modalHistoryList.innerHTML = "";
    if (!history.length) {
      const li = document.createElement("li");
      li.className = "modal-history-empty";
      li.textContent = t("modal.historyEmpty");
      el.modalHistoryList.appendChild(li);
    } else {
      history.forEach((h) => {
        const li = document.createElement("li");
        li.className = "modal-history-item";
        const fieldLabel = t(FIELD_LABEL_KEYS[h.field] || h.field);
        const line = t("modal.changed")
          .replace("{field}", fieldLabel)
          .replace("{old}", formatHistoryValue(h.field, h.old_value))
          .replace("{new}", formatHistoryValue(h.field, h.new_value));
        li.innerHTML = `
          <span class="modal-history-line">${escapeHtml(line)}</span>
          <span class="modal-history-time mono">${escapeHtml(formatTimestamp(h.changed_at))}</span>
        `;
        el.modalHistoryList.appendChild(li);
      });
    }

    el.entryModalOverlay.hidden = false;
    // Two rAFs (not one) reliably lands after the browser's first paint of
    // the now-unhidden overlay, so the opening transition actually plays
    // instead of the modal just appearing already in its "open" state.
    requestAnimationFrame(() => requestAnimationFrame(() => el.entryModalOverlay.classList.add("is-visible")));
  }
  function closeEntryModal() {
    el.entryModalOverlay.classList.remove("is-visible");
    setTimeout(() => {
      el.entryModalOverlay.hidden = true;
    }, 200);
  }
  el.entryModalClose.addEventListener("click", closeEntryModal);
  el.entryModalOverlay.addEventListener("click", (e) => {
    if (e.target === el.entryModalOverlay) closeEntryModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.entryModalOverlay.hidden) closeEntryModal();
  });

  function renderRatesGrid() {
    const rates = DB.listRates();
    el.ratesGridBody.innerHTML = "";
    rates.forEach((r) => {
      const tr = document.createElement("tr");
      const codeTd = document.createElement("td");
      codeTd.textContent = r.currency_code;
      const rateTd = document.createElement("td");
      const input = document.createElement("input");
      input.className = "cell-input cell-number";
      input.type = "number";
      input.step = "0.0001";
      input.value = r.rate_to_usd;
      input.addEventListener("change", async () => {
        const value = parseFloat(input.value);
        if (!value || value <= 0) {
          showToast(t("submission.amountInvalid"), "error");
          return;
        }
        await DB.updateRate(r.currency_code, value);
        renderRatesNote();
        renderEntriesGroups(); // converted_total_usd depends on rates
      });
      rateTd.appendChild(input);
      tr.append(codeTd, rateTd);
      el.ratesGridBody.appendChild(tr);
    });
  }

  el.addRowBtn.addEventListener("click", async () => {
    const newId = await DB.insertBlankEntry();
    state.editingRowIds.add(newId);
    renderEntriesGroups();
  });

  // -------------------------------------------------------------
  // Export / import
  //
  // Export tries the Web Share API first (lets Android/iOS hand the
  // file straight to Google Drive, Gmail, Files, etc.) and falls back
  // to a normal download -- see DB.shareOrDownload. Import validates
  // the file's magic bytes before handing it to sql.js, so picking the
  // wrong file produces a clear message instead of a cryptic parser error.
  // -------------------------------------------------------------
  async function handleExport(exportFn) {
    try {
      const meta = { title: t("data.shareTitle"), text: t("data.shareText") };
      const result = await exportFn(meta);
      if (result && result.method === "download") {
        showToast(t("data.savedToDownloads"), "success");
      }
      // "share": the OS share sheet is its own confirmation.
      // "cancelled": the user backed out on purpose -- nothing to say.
    } catch (err) {
      showToast(err.message || "Error", "error");
    }
  }
  el.exportEntriesBtn.addEventListener("click", () => handleExport(DB.exportEntriesCsv));
  el.exportRatesBtn.addEventListener("click", () => handleExport(DB.exportRatesCsv));
  el.exportBackupBtn.addEventListener("click", () => handleExport(DB.exportSqliteFile));

  const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
  const IMPORT_ERROR_MESSAGES = {
    INVALID_SQLITE_FILE: "data.importInvalid",
    SCHEMA_MISMATCH: "data.importSchemaMismatch",
    FILE_TOO_LARGE: "data.importTooLarge",
    IMPORT_FAILED: "data.importInvalid",
  };
  el.importBackupInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Check the size up front, before ever reading the file into memory --
    // an accidental wrong pick (a video, a photo) fails instantly instead
    // of the tab stalling while it reads a huge file for nothing.
    if (file.size > MAX_IMPORT_BYTES) {
      showToast(t("data.importTooLarge"), "error");
      e.target.value = "";
      return;
    }

    showToast(t("data.importReading"));
    try {
      const buffer = await file.arrayBuffer();
      await DB.importSqliteFile(buffer);
      showToast(t("submission.success"), "success");
      renderEntriesGroups();
      renderRatesGrid();
      renderRatesNote();
    } catch (err) {
      const key = err && IMPORT_ERROR_MESSAGES[err.code];
      showToast(key ? t(key) : err.message || t("data.importInvalid"), "error");
    } finally {
      e.target.value = "";
    }
  });

  // -------------------------------------------------------------
  // Init
  // -------------------------------------------------------------
  (async function boot() {
    try {
      await DB.init();
    } catch (err) {
      document.body.innerHTML =
        '<div style="max-width:26rem;margin:3rem auto;padding:1.5rem;font:15px/1.5 system-ui,sans-serif;text-align:center;color:#444;">' +
        "Couldn't start the app. Please reload the page. If this keeps happening, exporting/reinstalling may help." +
        "</div>";
      return;
    }
    addCurrencyRow();
    applyStaticTranslations();
    renderRatesNote();
    renderRatesGrid();
    showView("submission");
  })();
})();
