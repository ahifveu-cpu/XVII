import { escapeHTML, icon } from "./components/icons.js";
import { modules, pageLabels } from "./data/schemas.js";
import { permissionActions, permissionModules, specialPermissions, defaultPermissions, permissionKeys } from "./data/permissions.js";
import { renderAuthScreen } from "./modules/auth-screen.js";
import { renderDashboard } from "./modules/dashboard.js";
import { renderReceiptSettings, printReceipt } from "./modules/receipt.js";
import { describeUser, renderTeam, rolesFor } from "./modules/team.js";
import { renderLoading, renderWorkspace, renderWorkspaceError } from "./modules/workspace.js";
import { parseCSV, serializeCSV } from "./utils/csv.js";
import { CRMRepository, money } from "./services/crm-repository.js";
import {
  readSupabaseConfig,
  SupabaseClient,
} from "./services/supabase.js";

const authScreen = document.querySelector("#auth-screen");
const appShell = document.querySelector("#app-shell");
const pageContent = document.querySelector("#page-content");
const modalRoot = document.querySelector("#modal-root");
const popoverRoot = document.querySelector("#popover-root");
const toastRegion = document.querySelector("#toast-region");
const searchInput = document.querySelector("#global-search");
const branchSwitch = document.querySelector("#branch-switcher");
const themeToggle = document.querySelector("#theme-toggle");
const THEME_STORAGE_KEY = "qos-theme";
const ACCENT_STORAGE_KEY = "qos-accent";

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  themeToggle.setAttribute("aria-label", isDark ? "Включить светлую тему" : "Включить тёмную тему");
  themeToggle.title = isDark ? "Включить светлую тему" : "Включить тёмную тему";
  document.querySelector('meta[name="theme-color"]').content = isDark ? "#171a24" : "#f6f7fb";
}

function applyAccentColor(color) {
  const accent = /^#[0-9a-f]{6}$/i.test(color) ? color : "#566cf2";
  const channels = accent.slice(1).match(/.{2}/g).map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  document.documentElement.style.setProperty("--blue", accent);
  document.documentElement.style.setProperty("--blue-dark", `color-mix(in srgb, ${accent} 82%, #000)`);
  document.documentElement.style.setProperty("--blue-contrast", luminance > 0.42 ? "#20243a" : "#ffffff");
  document.documentElement.style.setProperty("--blue-soft", `color-mix(in srgb, ${accent} 12%, transparent)`);
}

applyTheme(localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light");
applyAccentColor(localStorage.getItem(ACCENT_STORAGE_KEY) || "#566cf2");

const pageModules = {
  orders: "orders",
  customers: "customers",
  tasks: "tasks",
  calendar: "calendar",
  inventory: "inventory",
  services: "services",
  finance: "finance",
  branches: "branches",
  documents: "documents",
};

const state = {
  config: readSupabaseConfig(),
  client: null,
  repository: null,
  user: null,
  member: null,
  organization: null,
  branches: [],
  branchId: null,
  branchName: "Все филиалы",
  currentPage: "dashboard",
  currentFilter: "Все",
  paymentFilter: "all",
  dashboardPayment: "all",
  chartDays: 7,
  sort: null,
  data: Object.create(null),
  users: [],
  receiptTemplate: null,
  settingsTab: "branches",
  permissionUserId: null,
  billing: null,
  billingError: "",
  requestNumber: 0,
};

const billingPlans = [
  { months: 1, amount: 399, title: "1 месяц" },
  { months: 3, amount: 1125, title: "3 месяца" },
  { months: 6, amount: 2250, title: "6 месяцев" },
  { months: 12, amount: 4500, title: "1 год" },
];

function subscriptionIsActive(organization = state.organization) {
  if (!organization) return false;
  const now = Date.now();
  const paidUntil = Date.parse(organization.subscription_ends_at || "");
  const trialUntil = Date.parse(organization.trial_ends_at || "");
  return (Number.isFinite(paidUntil) && paidUntil > now)
    || (!organization.subscription_ends_at && Number.isFinite(trialUntil) && trialUntil > now);
}

function formatBillingDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(date);
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.innerHTML = `<span class="toast-mark">${type === "error" ? "!" : "✓"}</span><span>${escapeHTML(message)}</span>`;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 4500);
}

function setBusy(form, busy) {
  form.querySelectorAll("button").forEach((button) => {
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
  });
}

function renderAuth(mode, { error = "", message = "", loading = false } = {}) {
  appShell.hidden = true;
  authScreen.hidden = false;
  authScreen.innerHTML = renderAuthScreen({
    mode,
    loading,
    error,
    message,
  });
  authScreen.querySelector("#auth-form")?.addEventListener("submit", handleAuth);
  authScreen.querySelector("[data-auth-mode]")?.addEventListener("click", (event) => {
    renderAuth(event.currentTarget.dataset.authMode);
  });
}

async function handleAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const isSignup = new FormData(form).has("full_name");
  setBusy(form, true);
  const values = new FormData(form);
  try {
    if (!state.config) throw new Error("XVII Cloud ещё не настроен. Попросите администратора приложения завершить настройку.");
    state.client ||= new SupabaseClient(state.config);
    if (isSignup) {
      const result = await state.client.signUp(
        values.get("email"),
        values.get("password"),
        values.get("full_name"),
        values.get("company_name"),
      );
      if (!result.access_token) {
        renderAuth("login", {
          message: "Аккаунт создан. Подтвердите адрес электронной почты в письме Supabase, затем войдите.",
        });
        return;
      }
    } else {
      await state.client.signIn(values.get("email"), values.get("password"));
    }
    await startWorkspace();
  } catch (error) {
    const hasSession = Boolean(state.client?.session);
    renderAuth(hasSession ? "login" : isSignup ? "signup" : "login", { error: error.message });
  }
}

function emptyModuleData() {
  return Object.fromEntries(Object.keys(pageModules).map((module) => [module, []]));
}

async function startWorkspace() {
  if (!state.config) {
    renderAuth("unconfigured");
    return;
  }
  state.client ||= new SupabaseClient(state.config);
  if (!state.client.session?.access_token) {
    renderAuth("login");
    return;
  }

  try {
    const user = state.client.session.user;
    if (!user?.id) throw new Error("Сеанс входа истёк. Войдите повторно.");
    const member = await state.client.selectOne(
      "organization_members",
      `select=user_id,organization_id,full_name,role,status,branch_id,permissions&user_id=eq.${encodeURIComponent(user.id)}`,
    );
    if (!member || member.status !== "active") {
      await state.client.signOut();
      throw new Error("Аккаунт заблокирован или не относится к организации XVII.");
    }

    state.user = user;
    state.member = member;
    state.repository = new CRMRepository(state.client, member);
    state.data = emptyModuleData();
    const [organization, branches] = await Promise.all([
      state.client.selectOne("organizations", `select=id,name,receipt_template,trial_started_at,trial_ends_at,subscription_ends_at,subscription_plan_months,subscription_auto_renew,balance&id=eq.${encodeURIComponent(member.organization_id)}`),
      state.repository.canView("branches") ? state.repository.list("branches") : Promise.resolve([]),
    ]);
    state.organization = organization;
    state.branches = branches;
    state.receiptTemplate = organization?.receipt_template || {};
    let ownBranch = branches.find((branch) => branch._record_id === member.branch_id);
    const canAccessAllBranches = state.repository.hasPermission("billing.manage") || !member.branch_id;
    if (member.branch_id && !canAccessAllBranches && state.repository.canView("branches") && !ownBranch) {
      throw new Error("Назначенный сотруднику филиал не найден. Владелец компании должен обновить его доступ в разделе «Сотрудники».");
    }
    state.branchId = canAccessAllBranches ? "all" : ownBranch?._record_id || member.branch_id;
    state.branchName = state.branchId === "all"
      ? "Все филиалы"
      : ownBranch?.branch || ownBranch?.name || "Мой филиал";
    const returnedFromBilling = new URLSearchParams(window.location.search).has("qos_billing");
    const accessiblePage = Object.keys(pageLabels).find((page) =>
      state.repository.canView(pageModules[page] || page),
    );
    state.currentPage = !subscriptionIsActive(organization) || returnedFromBilling
      ? "billing"
      : state.repository.canView("dashboard") ? "dashboard" : accessiblePage || "dashboard";
    if (returnedFromBilling) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
    }
    state.billing = null;
    state.requestNumber += 1;
    authScreen.hidden = true;
    appShell.hidden = false;
    document.title = `${organization?.name || "XVII"} — CRM`;
    updateBranchSwitcher();
    document.querySelector(".profile-copy strong").textContent = member.full_name || user.email || "Сотрудник";
    document.querySelector(".profile-copy small").textContent = ({
      owner: "Владелец компании",
      admin: "Администратор",
      manager: "Менеджер",
      technician: "Мастер",
      cashier: "Кассир",
    })[member.role] || member.role;
    await loadCurrentPage();
  } catch (error) {
    console.error("Не удалось открыть рабочее пространство XVII.", error);
    if (state.client?.session) {
      renderAuth("login", {
        error: `${error.message} Проверьте миграцию Supabase и повторите вход.`,
      });
    } else {
      renderAuth("login", { error: error.message });
    }
  }
}

function updateBranchSwitcher() {
  const branch = state.branches.find((item) => item._record_id === state.branchId);
  state.branchName = state.branchId === "all" ? "Все филиалы" : branch?.branch || branch?.name || "Все филиалы";
  branchSwitch.querySelector(".branch-copy strong").textContent = state.branchName;
  branchSwitch.querySelector(".branch-avatar").textContent = state.branchName === "Все филиалы"
    ? "∞"
    : state.branchName.trim()[0]?.toLocaleUpperCase("ru-RU") || "q";
  branchSwitch.querySelector(".branch-copy small").textContent = state.organization?.name || "Организация";
  document.querySelector(".branch-copy")?.setAttribute("title", state.branchName);
  branchSwitch.hidden = !state.repository?.canView("branches");
}

function updateTaskIndicator() {
  const indicator = document.querySelector('.nav-item[data-page="tasks"] .nav-dot');
  if (!indicator) return;
  const tasks = state.currentPage === "tasks"
    ? state.data.tasks || []
    : state.dashboard?.tasks || [];
  indicator.hidden = !state.repository?.canView("tasks")
    || !tasks.some((task) => task.status !== "Готово");
}

function renderPage() {
  updateTaskIndicator();
  document.querySelectorAll(".nav-item[data-page]").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.page === state.currentPage);
    const permissionModule = pageModules[item.dataset.page] || item.dataset.page;
    item.hidden = !state.repository.canView(permissionModule);
  });
  if (!state.repository.canView(pageModules[state.currentPage] || state.currentPage)) {
    pageContent.innerHTML = `<section class="panel role-information"><span class="report-icon report-amber">${icon("users")}</span><span><strong>Нет доступа к этому разделу.</strong><small>Попросите владельца компании изменить ваши права доступа.</small></span></section>`;
    bindViewEvents();
    return;
  }
  document.querySelector("#breadcrumb-current").textContent = pageLabels[state.currentPage] || "Обзор";
  if (state.currentPage === "dashboard") {
    pageContent.innerHTML = renderDashboard({
      ...(state.dashboard || {}),
      branches: state.branches,
    }, {
      branchName: state.branchName,
      employeeName: state.member?.full_name || "Сотрудник",
      chartDays: state.chartDays,
      canCreateBranch: state.repository.canCreate("branches"),
      canCreateOrder: state.repository.canCreate("orders"),
      canCreateSale: state.repository.canCreate("finance"),
      canCreateTask: state.repository.canCreate("tasks"),
      canEditTask: state.repository.canEdit("tasks"),
      canViewOrders: state.repository.canView("orders"),
      canViewTasks: state.repository.canView("tasks"),
      canViewFinance: state.repository.canView("finance"),
      canViewInventory: state.repository.canView("inventory"),
    });
  } else if (state.currentPage === "billing") {
    pageContent.innerHTML = renderBillingPage();
  } else if (state.currentPage === "team") {
    pageContent.innerHTML = renderTeam(state.users, {
      canManage: state.repository.canManageTeam(),
      canRepair: state.repository.isOwner(),
      branches: new Map(state.branches.map((branch) => [branch._record_id, branch.branch || branch.name])),
    });
  } else if (state.currentPage === "settings") {
    pageContent.innerHTML = renderSettings();
  } else {
    const module = pageModules[state.currentPage];
    if (!module || !modules[module]) throw new Error("Раздел пока недоступен.");
    const records = state.data[module] || [];
    const sortedRecords = state.sort?.module === module
      ? [...records].sort((left, right) => String(left[state.sort.key] || "").localeCompare(String(right[state.sort.key] || ""), "ru", { numeric: true }) * (state.sort.direction === "asc" ? 1 : -1))
      : records;
    const config = modules[module];
    const visibleConfig = {
      ...config,
      rows: sortedRecords,
      pageTitle: pageLabels[state.currentPage],
      subtitle: state.currentPage === "orders"
        ? "Номера заказов присваиваются автоматически. Все платежи записываются в общую базу."
        : config.subtitle,
    };
    pageContent.innerHTML = renderWorkspace(module, visibleConfig, {
      [module]: visibleConfig,
      branchName: state.branchName,
    }, {
      canCreate: state.repository.canCreate(module),
      canEdit: state.repository.canEdit(module),
      canDelete: state.repository.canDelete(module),
      canExport: state.repository.canExport(module),
      canImport: state.repository.canImport(module),
    });
  }
  document.querySelector("#sidebar").classList.remove("is-open");
  document.querySelector("#mobile-menu").setAttribute("aria-expanded", "false");
  document.querySelector("#mobile-menu").setAttribute("aria-label", "Открыть меню");
  bindViewEvents();
  if (state.currentPage === "settings" && state.repository.hasPermission("settings.receipt")) bindReceiptForm();
  if (state.currentPage === "settings") bindSettingsEvents();
  if (state.currentPage === "billing") bindBillingEvents();
}

function renderBillingPage() {
  const billing = state.billing;
  const organization = billing?.organization || state.organization || {};
  const paidUntil = organization.subscription_ends_at;
  const trialUntil = organization.trial_ends_at;
  const active = subscriptionIsActive(organization);
  const hasPaidSubscription = Boolean(paidUntil && Date.parse(paidUntil) > Date.now());
  const canManage = state.repository.hasPermission("billing.manage");
  const balance = Number(organization.balance || 0);
  const paymentLabels = { pending: "Ожидает оплаты", succeeded: "Успешно", canceled: "Отменён", failed: "Ошибка" };
  const paymentRows = (billing?.payments || []).map((payment) => `
    <tr><td>${escapeHTML(formatBillingDate(payment.created_at))}</td>
      <td>${payment.purpose === "topup" ? "Пополнение баланса" : `Подписка${payment.plan_months ? ` · ${payment.plan_months} мес.` : " с баланса"}`}</td>
      <td>${escapeHTML(money(payment.amount))}</td>
      <td>${escapeHTML(paymentLabels[payment.status] || payment.status)}</td></tr>`).join("");
  const plans = billingPlans.map((plan) => `
    <article class="panel billing-plan">
      <span class="mini-metric-label">${escapeHTML(plan.title)}</span>
      <strong>${money(plan.amount)}</strong>
      <small>${money(plan.amount / plan.months)} в месяц</small>
      ${canManage ? `<button class="button button-primary" type="button" data-billing-plan="${plan.months}">Оплатить картой</button>
        <button class="button button-secondary" type="button" data-billing-wallet-plan="${plan.months}" ${balance < plan.amount ? "disabled" : ""}>С баланса</button>` : `<small>Для оплаты нужно разрешение владельца компании</small>`}
    </article>`).join("");
  const expiryLabel = hasPaidSubscription
    ? `Подписка оплачена до ${formatBillingDate(paidUntil)}`
    : active
      ? `Пробный период до ${formatBillingDate(trialUntil)}`
      : `Пробный период закончился ${formatBillingDate(trialUntil)}`;
  const autoRenewStatus = organization.subscription_auto_renew
    ? `<p class="billing-note billing-success">Автопродление включено. Следующее списание произойдёт ближе к окончанию оплаченного периода.</p>
       ${canManage ? '<button class="button button-secondary" type="button" data-billing-auto-renew="disable">Отключить автопродление</button>' : ""}`
    : `<p class="billing-note">Автопродление можно подключить при следующей оплате картой, отметив согласие. Сохранённая карта не показывается XVII.</p>
       ${canManage && organization.has_payment_method ? '<button class="button button-secondary" type="button" data-billing-auto-renew="enable">Включить автопродление</button>' : ""}`;

  return `
    <div class="page-heading workspace-heading">
      <div><div class="eyebrow"><span class="eyebrow-dot"></span> УПРАВЛЕНИЕ КОМПАНИЕЙ</div>
        <h1>Подписка и баланс</h1><p>14 дней бесплатно, затем выберите срок или пополните баланс.</p></div>
      <button class="button button-secondary" type="button" data-billing-refresh>Обновить статус</button>
    </div>
    ${state.billingError ? `<div class="auth-message auth-message-error" role="alert">${escapeHTML(state.billingError)}</div>` : ""}
    <section class="panel billing-status">
      <div><span class="mini-metric-label">Статус XVII</span><strong class="${active ? "billing-status-active" : "billing-status-expired"}">${active ? "Доступ активен" : "Нужна оплата"}</strong><p>${escapeHTML(expiryLabel)}</p></div>
      <div><span class="mini-metric-label">Баланс компании</span><strong>${money(balance)}</strong><p>Пополнение можно использовать для оплаты любого плана.</p></div>
      ${organization.subscription_auto_renew ? `<div class="billing-autorenew">${autoRenewStatus}</div>` : ""}
    </section>
    ${!organization.subscription_auto_renew ? `<section class="panel billing-renew-panel"><div><h2>Автопродление</h2>${autoRenewStatus}</div></section>` : ""}
    ${canManage ? `<label class="billing-consent"><input id="billing-auto-renew-consent" type="checkbox" ${organization.subscription_auto_renew ? "checked" : ""} /><span><strong>Подключить автопродление</strong><small>При оплате картой ЮKassa сохранит способ оплаты и спишет стоимость плана в конце периода. Оплата с баланса эту настройку не меняет. Отключить автопродление можно в любой момент.</small></span></label>` : ""}
    <div class="billing-plans">${plans}</div>
    ${canManage ? `<section class="panel billing-topup">
      <div><h2>Пополнить баланс</h2><p>Зачисление средств после подтверждения платежа ЮKassa.</p></div>
      <label class="form-field"><span>Сумма, ₽ (от 100 до 50 000)</span><input id="billing-topup-amount" type="number" min="100" max="50000" step="1" value="1000" /></label>
      <button class="button button-primary" type="button" data-billing-topup>Перейти к оплате</button>
    </section>` : ""}
    <section class="panel billing-history">
      <div class="panel-heading"><div><h2>История платежей</h2><p>Последние платежи по XVII Cloud.</p></div></div>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>Дата</th><th>Операция</th><th>Сумма</th><th>Статус</th></tr></thead>
      <tbody>${paymentRows || '<tr><td colspan="4">Платежей пока нет.</td></tr>'}</tbody></table></div>
    </section>
    <p class="billing-footnote">Оплата обрабатывается ЮKassa. Данные карты хранятся у платёжного провайдера; XVII не получает полный номер карты.</p>`;
}

async function refreshBillingStatus() {
  state.billingError = "";
  try {
    state.billing = await state.client.invoke("qos-billing", { action: "status" });
    state.organization = { ...state.organization, ...state.billing.organization };
    renderPage();
  } catch (error) {
    console.error("Не удалось загрузить информацию о подписке.", error);
    state.billingError = error.message;
    renderPage();
  }
}

function bindBillingEvents() {
  pageContent.querySelector("[data-billing-refresh]")?.addEventListener("click", () => void refreshBillingStatus());
  pageContent.querySelector("[data-billing-topup]")?.addEventListener("click", () => {
    const amount = Number(pageContent.querySelector("#billing-topup-amount")?.value);
    void createBillingCheckout({ purpose: "topup", amount });
  });
  pageContent.querySelectorAll("[data-billing-plan]").forEach((button) => button.addEventListener("click", () => {
    void createBillingCheckout({
      purpose: "subscription",
      plan_months: Number(button.dataset.billingPlan),
      auto_renew: Boolean(pageContent.querySelector("#billing-auto-renew-consent")?.checked),
    });
  }));
  pageContent.querySelectorAll("[data-billing-wallet-plan]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await state.client.rpc("pay_subscription_from_balance", {
        p_plan_months: Number(button.dataset.billingWalletPlan),
      });
      showToast("Подписка оплачена с баланса компании.");
      await refreshBillingStatus();
    } catch (error) {
      console.error("Не удалось оплатить подписку с баланса.", error);
      showToast(error.message, "error");
      button.disabled = false;
    }
  }));
  pageContent.querySelector('[data-billing-auto-renew="disable"]')?.addEventListener("click", async () => {
    await updateBillingPreference("disable-auto-renew", "Автопродление отключено.");
  });
  pageContent.querySelector('[data-billing-auto-renew="enable"]')?.addEventListener("click", async () => {
    await updateBillingPreference("enable-auto-renew", "Автопродление включено.");
  });
}

async function updateBillingPreference(action, successMessage) {
  try {
    await state.client.invoke("qos-billing", { action });
    showToast(successMessage);
    await refreshBillingStatus();
  } catch (error) {
    console.error("Не удалось изменить автопродление.", error);
    showToast(error.message, "error");
  }
}

async function createBillingCheckout(values) {
  const buttons = pageContent.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await state.client.invoke("qos-billing", {
      action: "create-checkout",
      ...values,
    });
    if (!result.confirmation_url) throw new Error("ЮKassa не вернула ссылку для оплаты.");
    window.location.assign(result.confirmation_url);
  } catch (error) {
    console.error("Не удалось создать платёж XVII.", error);
    showToast(error.message, "error");
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function renderSettings() {
  const canCreateBranch = state.repository.canCreate("branches");
  const canEditBranch = state.repository.canEdit("branches");
  const canDeleteBranch = state.repository.canDelete("branches");
  const branchRows = state.branches.map((branch) => `
    <div class="settings-branch-row"><span class="branch-avatar">${escapeHTML((branch.branch || branch.name || "Ф")[0])}</span><span><strong>${escapeHTML(branch.branch || branch.name || "Филиал")}</strong><small>${escapeHTML(branch.address || "Адрес не указан")}</small></span><span class="status-pill ${branch.status === "Открыт" ? "status-green" : "status-gray"}"><span class="status-dot"></span>${escapeHTML(branch.status || "Не задано")}</span>${canEditBranch || canDeleteBranch ? `<span class="branch-row-actions">${canEditBranch ? `<button class="button button-secondary" type="button" data-branch-edit="${escapeHTML(branch._record_id)}">${icon("tool")} Изменить</button>` : ""}${canDeleteBranch ? `<button class="button button-secondary branch-delete-button" type="button" data-branch-delete="${escapeHTML(branch._record_id)}">Удалить</button>` : ""}</span>` : ""}</div>`).join("");
  const settingsTabs = [
    `<button class="filter-tab settings-tab ${state.settingsTab === "branches" ? "is-selected" : ""}" data-settings-tab="branches">Филиалы</button>`,
    ...(state.repository.hasPermission("settings.receipt") ? [`<button class="filter-tab settings-tab ${state.settingsTab === "receipt" ? "is-selected" : ""}" data-settings-tab="receipt">Талон приёма</button>`] : []),
    ...(state.repository.isOwner() ? [`<button class="filter-tab settings-tab ${state.settingsTab === "permissions" ? "is-selected" : ""}" data-settings-tab="permissions">Права доступа</button>`] : []),
  ].join("");
  const tabContent = state.settingsTab === "permissions" && state.repository.isOwner()
    ? renderPermissionSettings()
    : state.settingsTab === "receipt" && state.repository.hasPermission("settings.receipt")
      ? renderReceiptSettings(state.receiptTemplate || {})
      : `<section class="panel settings-branches-panel"><div class="panel-heading"><div><h2>Филиалы компании</h2><p>Каждый филиал и его записи хранятся в общей базе компании.</p></div></div><div class="settings-branches-list">${branchRows || `<p class="panel-empty">${state.repository.canView("branches") ? "Филиалов нет. Добавьте первый филиал." : "У вас нет права просматривать филиалы."}</p>`}</div></section>`;
  return `
    <div class="page-heading workspace-heading"><div><div class="eyebrow"><span class="eyebrow-dot"></span> ${escapeHTML(state.organization?.name || "XVII")}</div><h1>Настройки компании</h1><p>Филиалы, квитанции и индивидуальные права доступа.</p></div><div class="heading-actions">${state.settingsTab === "branches" && canCreateBranch ? `<button class="button button-primary" data-action="add-branch">${icon("plus")} Добавить филиал</button>` : ""}</div></div>
    <div class="settings-summary-grid"><article class="mini-metric"><span class="mini-metric-dot dot-blue"></span><span class="mini-metric-label">Компания</span><strong>${escapeHTML(state.organization?.name || "XVII")}</strong></article><article class="mini-metric"><span class="mini-metric-dot dot-green"></span><span class="mini-metric-label">Общая база</span><strong>Supabase PostgreSQL</strong></article><article class="mini-metric"><span class="mini-metric-dot dot-violet"></span><span class="mini-metric-label">Доступ</span><strong>${escapeHTML(state.member.role)}</strong></article><article class="mini-metric"><span class="mini-metric-dot dot-amber"></span><span class="mini-metric-label">Нумерация заказов</span><strong>С № 1 · автоматически</strong></article></div>
    <nav class="filter-tabs settings-tabs" aria-label="Настройки">${settingsTabs}</nav>${tabContent}`;
}

function renderPermissionSettings() {
  const users = state.users.filter((user) => user.role !== "owner");
  const selected = users.find((user) => user.user_id === state.permissionUserId) || users[0];
  if (selected) state.permissionUserId = selected.user_id;
  const permissions = { ...defaultPermissions(), ...(selected?.permissions || {}) };
  permissionModules.forEach(([module]) => {
    if (!["orders", "customers", "inventory", "services"].includes(module) || !permissions[`${module}.create`]) {
      permissions[`${module}.import`] = false;
    }
  });
  const moduleRows = permissionModules.map(([module, label]) => `
    <article class="permission-module-card">
      <h3>${escapeHTML(label)}</h3>
      <div class="permission-module-actions">${permissionActions.map(([action, actionLabel]) => {
      const key = `${module}.${action}`;
      const importDisabled = action === "import" && (
        !["orders", "customers", "inventory", "services"].includes(module)
        || !permissions[`${module}.create`]
      );
      const importTitle = !["orders", "customers", "inventory", "services"].includes(module)
        ? "Импорт для этого раздела не предусмотрен"
        : "Для импорта также требуется право создания";
      return `<label class="permission-toggle"><input type="checkbox" name="permission" value="${key}" ${permissions[key] ? "checked" : ""} ${importDisabled ? `disabled title="${importTitle}"` : ""}><span class="permission-toggle-switch"></span><span>${escapeHTML(actionLabel)}</span></label>`;
    }).join("")}</div>
    </article>`).join("");
  const specialRows = specialPermissions.map(([key, label]) => `
    <label class="permission-toggle permission-toggle-special"><input type="checkbox" name="permission" value="${key}" ${permissions[key] ? "checked" : ""}><span class="permission-toggle-switch"></span><span>${escapeHTML(label)}</span></label>`).join("");
  return `<section class="panel permissions-panel">
    <div class="panel-heading"><div><h2>Права сотрудников</h2><p>Владелец всегда сохраняет полный доступ. Новым сотрудникам по умолчанию доступен только просмотр.</p></div></div>
    ${users.length ? `<label class="form-field permission-user-select"><span>Сотрудник</span><select id="permission-user">${users.map((user) => `<option value="${escapeHTML(user.user_id)}" ${user.user_id === selected.user_id ? "selected" : ""}>${escapeHTML(user.full_name || user.email || user.user_id)} · ${escapeHTML(user.email || user.role)}</option>`).join("")}</select></label>
    <div class="permission-module-grid">${moduleRows}</div>
    <div class="permission-special-list"><h3>Дополнительные действия</h3>${specialRows}</div><button class="button button-primary" type="button" data-save-permissions>${icon("check-square")} Сохранить права</button>`
      : `<p class="panel-empty">Сотрудников пока нет. Сначала добавьте сотрудника во вкладке «Сотрудники».</p>`}
  </section>`;
}

function renderLoadingPage() {
  pageContent.innerHTML = renderLoading(pageLabels[state.currentPage], state.branchName);
}

async function refreshDashboard() {
  const request = ++state.requestNumber;
  pageContent.innerHTML = renderLoading("Обзор", state.branchName);
  try {
    const dashboard = await state.repository.dashboard(state.branchId);
    if (request !== state.requestNumber) return;
    state.dashboard = dashboard;
    state.branches = dashboard.branches.length ? dashboard.branches : state.branches;
    renderPage();
  } catch (error) {
    if (request !== state.requestNumber) return;
    pageContent.innerHTML = renderWorkspaceError(error.message);
    bindViewEvents();
  }
}

async function loadCurrentPage() {
  const request = ++state.requestNumber;
  const currentPage = state.currentPage;
  if (currentPage === "billing") {
    renderLoadingPage();
    await refreshBillingStatus();
    return;
  }
  if (currentPage === "dashboard") {
    await refreshDashboard();
    return;
  }
  if (currentPage === "settings") {
    renderLoadingPage();
    try {
      const [branches, users] = await Promise.all([
        state.repository.canView("branches") ? state.repository.list("branches") : Promise.resolve([]),
        state.repository.isOwner() ? state.repository.users() : Promise.resolve({ users: [] }),
      ]);
      if (request !== state.requestNumber) return;
      state.branches = branches;
      if (state.repository.isOwner()) state.users = users.users || [];
      renderPage();
    } catch (error) {
      if (request !== state.requestNumber) return;
      console.error("Не удалось загрузить настройки XVII.", error);
      pageContent.innerHTML = renderWorkspaceError(error.message);
      bindViewEvents();
    }
    return;
  }
  if (currentPage === "team") {
    renderLoadingPage();
    try {
      const response = state.repository.canManageTeam()
        ? await state.repository.users()
        : { users: await state.repository.members() };
      if (request !== state.requestNumber) return;
      state.users = response.users || [];
      renderPage();
    } catch (error) {
      console.error("Не удалось загрузить пользователей XVII.", error);
      pageContent.innerHTML = renderWorkspaceError(error.message);
      bindViewEvents();
    }
    return;
  }

  renderLoadingPage();
  try {
    const module = pageModules[currentPage];
    const records = await state.repository.list(module, state.branchId);
    if (request !== state.requestNumber) return;
    state.data[module] = records;
    state.sort = null;
    renderPage();
  } catch (error) {
    if (request !== state.requestNumber) return;
    console.error(`Не удалось загрузить раздел «${currentPage}».`, error);
    pageContent.innerHTML = renderWorkspaceError(error.message);
    bindViewEvents();
  }
}

function navigate(page) {
  if (!pageLabels[page]) return;
  const permissionModule = pageModules[page] || page;
  if (!state.repository.canView(permissionModule)) {
    showToast("У вас нет права открывать этот раздел. Попросите владельца изменить ваши доступы.", "error");
    return;
  }
  if (!subscriptionIsActive() && page !== "billing") {
    showToast("Пробный период закончился. Для продолжения работы выберите план подписки.", "error");
    page = "billing";
  }
  state.currentPage = page;
  state.currentFilter = "Все";
  state.paymentFilter = "all";
  state.sort = null;
  popoverRoot.innerHTML = "";
  if (page === "dashboard") state.dashboard = null;
  else if (pageModules[page]) state.data[pageModules[page]] = undefined;
  else if (page === "team") state.users = [];
  renderPage();
  void loadCurrentPage();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeModal() {
  modalRoot.innerHTML = "";
  if (state.previousFocus instanceof HTMLElement) {
    state.previousFocus.focus();
    state.previousFocus = null;
  }
}

function openModal({ title, subtitle = "", fields = [], onSubmit, submitLabel = "Сохранить", className = "" }) {
  state.previousFocus = document.activeElement;
  modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal-card ${escapeHTML(className)}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-heading"><div><h2 id="modal-title">${escapeHTML(title)}</h2>${subtitle ? `<p>${escapeHTML(subtitle)}</p>` : ""}</div><button class="icon-button modal-close" type="button" data-close-modal aria-label="Закрыть">${icon("close")}</button></div>
        <form id="modal-form" novalidate>
          <div class="modal-fields">${fields.map((field) => renderFormField(field)).join("")}</div>
          <div class="modal-footer"><button class="button button-secondary" type="button" data-close-modal>Отмена</button><button class="button button-primary" type="submit">${escapeHTML(submitLabel)}</button></div>
        </form>
      </section>
    </div>`;
  modalRoot.querySelector('input:not([type="hidden"]),select,textarea')?.focus();
  modalRoot.querySelector("#modal-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = {};
    for (const field of fields) {
      const control = Array.from(form.elements).find((element) =>
        element.name === field.key && !element.closest(".order-catalog"));
      if (!control) continue;
      if (!(control instanceof HTMLInputElement)
        && !(control instanceof HTMLSelectElement)
        && !(control instanceof HTMLTextAreaElement)) continue;
      if (field.required && !String(control.value || "").trim()) {
        control.setCustomValidity("Заполните обязательное поле.");
        control.reportValidity();
        return;
      }
      control.setCustomValidity("");
      values[field.key] = field.type === "checkbox" && control instanceof HTMLInputElement
        ? control.checked
        : String(control.value ?? "").trim();
    }
    setBusy(form, true);
    try {
      await onSubmit(values);
    } catch (error) {
      setBusy(form, false);
      const message = form.querySelector(".modal-form-error");
      if (message) message.textContent = error.message;
      else {
        const errorMessage = document.createElement("p");
        errorMessage.className = "modal-form-error";
        errorMessage.setAttribute("role", "alert");
        errorMessage.textContent = error.message;
        form.querySelector(".modal-fields").prepend(errorMessage);
      }
    }
  });
  modalRoot.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
  modalRoot.querySelector(".modal-backdrop").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeModal();
  });
  const backdrop = modalRoot.querySelector(".modal-backdrop");
  initializeDatePickers(backdrop);
  initializeAutocompleteFields(backdrop);
  initializeMenuSelects(backdrop);
  initializeTimePickers(backdrop);
  const customerField = fields.find((field) => field.key === "customer" && field.customerRecords?.length);
  if (customerField) {
    const customerInput = backdrop.querySelector('[name="customer"]');
    customerInput?.addEventListener("input", () => {
      const customer = customerField.customerRecords.find((record) =>
        (record.name || record.customer || "").trim() === customerInput.value.trim());
      if (!customer) return;
      for (const [key, value] of [["phone", customer.phone], ["email", customer.email]]) {
        const control = backdrop.querySelector(`[name="${key}"]`);
        if (control && value) control.value = value;
      }
    });
  }
  initializeProfitPreview(backdrop, fields);
}

function renderFormField(field) {
  const wide = field.wide ? "form-field-wide" : "";
  const label = `${escapeHTML(field.label)}${field.required ? '<i class="required-mark">*</i>' : ""}`;
  if (field.type === "textarea" && !field.suggestions?.length) {
    return `<label class="form-field ${wide}"><span>${label}</span><textarea name="${escapeHTML(field.key)}" rows="${field.rows || 3}" maxlength="${field.maxLength || 1500}" placeholder="${escapeHTML(field.placeholder || "")}">${escapeHTML(field.value || "")}</textarea></label>`;
  }
  if (field.type === "checkbox") {
    return `<label class="receipt-checkbox ${wide}"><input type="checkbox" name="${escapeHTML(field.key)}" ${field.value ? "checked" : ""} /><span>${label}</span></label>`;
  }
  if (field.type === "menu-select") {
    const selected = field.options.find((option) => String(option.value) === String(field.value ?? "")) || field.options[0];
    return `<label class="form-field ${wide}"><span>${label}</span><div class="menu-select" data-menu-select><input type="hidden" name="${escapeHTML(field.key)}" value="${escapeHTML(selected?.value || "")}" /><button type="button" class="menu-select-toggle" data-menu-select-toggle aria-expanded="false"><span data-menu-select-value>${escapeHTML(selected?.label || "Выберите")}</span>${icon("chevron-down")}</button><div class="menu-select-options" data-menu-select-options role="listbox" hidden>${field.options.map((option) => `<button type="button" role="option" aria-selected="${option === selected}" class="menu-select-option${option === selected ? " is-selected" : ""}" data-menu-select-option="${escapeHTML(option.value)}">${escapeHTML(option.label)}</button>`).join("")}</div></div></label>`;
  }
  if (field.type === "date") {
    const value = String(field.value || "");
    return `<label class="form-field ${wide}"><span>${label}</span><div class="date-picker" data-date-picker><input type="hidden" name="${escapeHTML(field.key)}" value="${escapeHTML(value)}" /><div class="date-picker-control"><input class="date-picker-display" type="text" value="${escapeHTML(formatDateForDisplay(value))}" placeholder="дд.мм.гггг" readonly aria-label="${escapeHTML(field.label)}" /><button class="date-picker-toggle" type="button" aria-label="Открыть календарь" aria-expanded="false">${icon("calendar")}</button></div></div></label>`;
  }
  if (field.type === "time-picker") {
    const value = String(field.value || "");
    return `<label class="form-field ${wide}"><span>${label}</span><div class="time-picker" data-time-picker><input type="hidden" name="${escapeHTML(field.key)}" value="${escapeHTML(value)}" /><button type="button" class="time-picker-toggle" data-time-toggle aria-expanded="false"><span data-time-display>${escapeHTML(value || "Выбрать время")}</span>${icon("clock")}</button><div class="time-picker-panel" data-time-panel hidden><div><span>Часы</span><div class="time-picker-options" data-time-hours></div></div><div><span>Минуты</span><div class="time-picker-options" data-time-minutes></div></div></div></div></label>`;
  }
  const inputType = ["email", "tel", "number", "date", "password"].includes(field.type) ? field.type : "text";
  const suggestions = field.suggestions ? [...new Set(field.suggestions.filter(Boolean))] : [];
  const suggestionsId = suggestions.length ? `suggestions-${escapeHTML(field.key)}` : "";
  const suggestionOptions = suggestions.map((suggestion) => {
    const detail = field.suggestionDetails?.[suggestion] || "";
    return `<button type="button" class="autocomplete-option" role="option" data-autocomplete-value="${escapeHTML(suggestion)}"><span class="autocomplete-option-mark"></span><span class="autocomplete-option-copy"><strong>${escapeHTML(suggestion)}</strong>${detail ? `<small>${escapeHTML(detail)}</small>` : ""}</span></button>`;
  }).join("") || "";
  return `<label class="form-field ${wide}"><span>${label}</span>${field.options
    ? `<select name="${escapeHTML(field.key)}" ${field.required ? "required" : ""}>${field.options.map((option) => `<option value="${escapeHTML(option.value)}" ${String(option.value) === String(field.value ?? option.selectedValue ?? "") ? "selected" : ""}>${escapeHTML(option.label)}</option>`).join("")}</select>`
    : suggestionsId
      ? `<div class="autocomplete-field" data-autocomplete data-field-label="${escapeHTML(field.label)}"><input class="autocomplete-input" name="${escapeHTML(field.key)}" type="${inputType}" value="${escapeHTML(field.value || "")}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${suggestionsId}" ${field.placeholder ? `placeholder="${escapeHTML(field.placeholder)}"` : ""} ${field.required ? "required" : ""} ${field.maxLength ? `maxlength="${field.maxLength}"` : ""} /><button class="autocomplete-toggle" type="button" data-autocomplete-toggle aria-label="Показать варианты" tabindex="-1">${icon("chevron-down")}</button><div class="autocomplete-options" id="${suggestionsId}" role="listbox" hidden><div class="autocomplete-heading"><span>${escapeHTML(field.menuTitle || "СОХРАНЁННЫЕ ВАРИАНТЫ")}</span><small data-autocomplete-count>${suggestions.length}</small></div>${suggestionOptions}</div></div>`
    : `<input name="${escapeHTML(field.key)}" type="${inputType}" ${field.value !== undefined ? `value="${escapeHTML(field.value)}"` : ""} ${field.placeholder ? `placeholder="${escapeHTML(field.placeholder)}"` : ""} ${field.required ? "required" : ""} ${inputType === "number" ? `min="${field.min || "0"}" step="${field.step || "0.01"}"` : ""} ${field.maxLength ? `maxlength="${field.maxLength}"` : ""} ${field.readOnly ? "readonly" : ""} />`}</label>`;
}

function initializeAutocompleteFields(backdrop) {
  const close = (field) => {
    const input = field.querySelector(".autocomplete-input");
    const options = field.querySelector(".autocomplete-options");
    options.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const place = (field) => {
    const input = field.querySelector(".autocomplete-input");
    const options = field.querySelector(".autocomplete-options");
    const bounds = input.getBoundingClientRect();
    options.hidden = false;
    options.style.position = "fixed";
    options.style.width = `${bounds.width}px`;
    options.style.left = `${Math.min(Math.max(8, bounds.left), window.innerWidth - bounds.width - 8)}px`;
    const height = Math.min(options.scrollHeight, 250);
    options.style.top = `${bounds.bottom + height + 6 <= window.innerHeight - 8
      ? bounds.bottom + 6
      : Math.max(8, bounds.top - height - 6)}px`;
    input.setAttribute("aria-expanded", "true");
  };
  const filter = (field, query = "") => {
    const options = field.querySelector(".autocomplete-options");
    const normalized = query.trim().toLocaleLowerCase("ru-RU");
    const available = [...options.querySelectorAll(".autocomplete-option")];
    let visible = 0;
    available.forEach((option) => {
      const match = option.textContent.trim().toLocaleLowerCase("ru-RU").includes(normalized);
      option.hidden = !match;
      if (match) visible += 1;
    });
    const count = options.querySelector("[data-autocomplete-count]");
    if (count) count.textContent = String(visible);
    let empty = options.querySelector(".autocomplete-empty");
    if (!visible) {
      if (!empty) {
        empty = document.createElement("div");
        empty.className = "autocomplete-empty";
        options.append(empty);
      }
      empty.textContent = query.trim()
        ? "Совпадений нет. Можно оставить введённое значение."
        : "Список пока пуст. Введите новое значение.";
    } else {
      empty?.remove();
    }
    place(field);
  };
  backdrop.querySelectorAll("[data-autocomplete]").forEach((field) => {
    const input = field.querySelector(".autocomplete-input");
    const options = field.querySelector(".autocomplete-options");
    const show = () => filter(field, input.value);
    input.addEventListener("focus", show);
    input.addEventListener("click", show);
    input.addEventListener("input", show);
    input.addEventListener("keydown", (event) => {
      const available = [...options.querySelectorAll(".autocomplete-option:not([hidden])")];
      const current = available.findIndex((option) => option.classList.contains("is-active"));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (options.hidden) show();
        available.forEach((option) => option.classList.remove("is-active"));
        const next = event.key === "ArrowDown"
          ? Math.min(current + 1, available.length - 1)
          : current <= 0 ? available.length - 1 : current - 1;
        if (available[next]) {
          available[next].classList.add("is-active");
          available[next].scrollIntoView({ block: "nearest" });
        }
      } else if (event.key === "Enter" && !options.hidden && current >= 0) {
        event.preventDefault();
        available[current].click();
      } else if (event.key === "Escape") {
        close(field);
      }
    });
    field.querySelector("[data-autocomplete-toggle]").addEventListener("click", () => {
      if (options.hidden) {
        input.focus();
        filter(field, "");
      } else {
        close(field);
      }
    });
    options.addEventListener("mousedown", (event) => event.preventDefault());
    options.addEventListener("click", (event) => {
      const option = event.target.closest("[data-autocomplete-value]");
      if (!option) return;
      input.value = option.dataset.autocompleteValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      close(field);
    });
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target.closest("[data-autocomplete]")) return;
    backdrop.querySelectorAll("[data-autocomplete]").forEach(close);
  });
  window.addEventListener("resize", () => backdrop.querySelectorAll("[data-autocomplete]").forEach((field) => {
    if (!field.querySelector(".autocomplete-options").hidden) place(field);
  }), { once: true });
}

function initializeProfitPreview(backdrop, fields) {
  if (!fields.some((field) => field.key === "price") || !fields.some((field) => field.key === "cost_price")) return;
  const preview = document.createElement("div");
  preview.className = "profit-preview form-field-wide";
  preview.setAttribute("aria-live", "polite");
  preview.innerHTML = `<span>Прибыль сервиса</span><strong>0 ₽</strong>`;
  backdrop.querySelector(".modal-fields")?.append(preview);
  const update = () => {
    const form = backdrop.querySelector("#modal-form");
    const price = Number(form.elements.namedItem("price").value || 0);
    const cost = Number(form.elements.namedItem("cost_price").value || 0);
    const profit = price - cost;
    preview.classList.toggle("is-loss", profit < 0);
    preview.querySelector("strong").textContent = money(profit);
  };
  backdrop.querySelectorAll('[name="price"],[name="cost_price"]').forEach((field) => {
    field.addEventListener("input", update);
    field.addEventListener("change", update);
  });
  update();
}

function todayISODate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateForDisplay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "";
}

function initializeDatePickers(backdrop) {
  let activePicker = null;
  let visibleMonth = null;
  let calendar = null;

  const closeCalendar = () => {
    calendar?.remove();
    calendar = null;
    activePicker?.querySelector(".date-picker-toggle")?.setAttribute("aria-expanded", "false");
    activePicker = null;
  };

  const drawCalendar = () => {
    if (!activePicker || !calendar || !visibleMonth) return;
    const selectedValue = activePicker.querySelector('input[type="hidden"]').value;
    const year = visibleMonth.getFullYear();
    const month = visibleMonth.getMonth();
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPreviousMonth = new Date(year, month, 0).getDate();
    const today = todayISODate();
    const cells = Array.from({ length: 42 }, (_, index) => {
      const dayNumber = index - firstWeekday + 1;
      const cellDate = dayNumber < 1
        ? new Date(year, month - 1, daysInPreviousMonth + dayNumber)
        : dayNumber > daysInMonth
          ? new Date(year, month + 1, dayNumber - daysInMonth)
          : new Date(year, month, dayNumber);
      const value = `${cellDate.getFullYear()}-${String(cellDate.getMonth() + 1).padStart(2, "0")}-${String(cellDate.getDate()).padStart(2, "0")}`;
      const outsideMonth = cellDate.getMonth() !== month;
      return `<button class="date-picker-day${outsideMonth ? " is-outside" : ""}${value === selectedValue ? " is-selected" : ""}${value === today ? " is-today" : ""}" type="button" data-date-value="${value}" aria-pressed="${value === selectedValue}">${cellDate.getDate()}</button>`;
    }).join("");
    calendar.innerHTML = `<div class="date-picker-header"><button class="date-picker-nav" type="button" data-month-shift="-1" aria-label="Предыдущий месяц">‹</button><strong>${new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(visibleMonth)}</strong><button class="date-picker-nav" type="button" data-month-shift="1" aria-label="Следующий месяц">›</button></div><div class="date-picker-weekdays"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Вс</span></div><div class="date-picker-grid">${cells}</div><div class="date-picker-footer"><button type="button" data-date-clear>Очистить</button><button type="button" data-date-today>Сегодня</button></div>`;
  };

  backdrop.querySelectorAll("[data-date-picker]").forEach((picker) => {
    const toggle = picker.querySelector(".date-picker-toggle");
    const openCalendar = () => {
      closeCalendar();
      activePicker = picker;
      const currentValue = picker.querySelector('input[type="hidden"]').value || todayISODate();
      const [year, month] = currentValue.split("-").map(Number);
      visibleMonth = new Date(year, month - 1, 1);
      calendar = document.createElement("div");
      calendar.className = "date-picker-popover";
      calendar.setAttribute("role", "dialog");
      calendar.setAttribute("aria-label", "Выбор даты");
      backdrop.append(calendar);
      drawCalendar();
      toggle.setAttribute("aria-expanded", "true");
      const bounds = toggle.getBoundingClientRect();
      const calendarHeight = 330;
      const top = bounds.bottom + calendarHeight <= window.innerHeight - 12
        ? bounds.bottom + 6
        : Math.max(12, bounds.top - calendarHeight - 6);
      calendar.style.top = `${top}px`;
      calendar.style.left = `${Math.min(Math.max(12, bounds.right - 280), window.innerWidth - 292)}px`;
    };

    toggle.addEventListener("click", () => {
      if (activePicker === picker) closeCalendar();
      else openCalendar();
    });
    picker.querySelector(".date-picker-display").addEventListener("click", openCalendar);
  });

  backdrop.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || !calendar?.contains(button)) {
      if (calendar && !event.target.closest("[data-date-picker]")) closeCalendar();
      return;
    }
    if (button.hasAttribute("data-month-shift")) {
      visibleMonth.setMonth(visibleMonth.getMonth() + Number(button.dataset.monthShift));
      drawCalendar();
    } else if (button.hasAttribute("data-date-value")) {
      const value = button.dataset.dateValue;
      activePicker.querySelector('input[type="hidden"]').value = value;
      activePicker.querySelector(".date-picker-display").value = formatDateForDisplay(value);
      closeCalendar();
    } else if (button.hasAttribute("data-date-today")) {
      const value = todayISODate();
      activePicker.querySelector('input[type="hidden"]').value = value;
      activePicker.querySelector(".date-picker-display").value = formatDateForDisplay(value);
      closeCalendar();
    } else if (button.hasAttribute("data-date-clear")) {
      activePicker.querySelector('input[type="hidden"]').value = "";
      activePicker.querySelector(".date-picker-display").value = "";
      closeCalendar();
    }
  });
  window.addEventListener("resize", closeCalendar, { once: true });
}

function initializeMenuSelects(backdrop) {
  backdrop.querySelectorAll("[data-menu-select]").forEach((menu) => {
    const valueField = menu.querySelector('input[type="hidden"]');
    const toggle = menu.querySelector("[data-menu-select-toggle]");
    const valueLabel = menu.querySelector("[data-menu-select-value]");
    const options = menu.querySelector("[data-menu-select-options]");
    toggle.addEventListener("click", () => {
      const open = options.hidden;
      backdrop.querySelectorAll("[data-menu-select-options]").forEach((other) => { other.hidden = true; });
      backdrop.querySelectorAll("[data-menu-select-toggle]").forEach((other) => other.setAttribute("aria-expanded", "false"));
      options.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) {
        const bounds = toggle.getBoundingClientRect();
        const width = Math.max(bounds.width, 180);
        const left = Math.min(Math.max(8, bounds.left), window.innerWidth - width - 8);
        options.style.position = "fixed";
        options.style.width = `${width}px`;
        options.style.left = `${left}px`;
        const height = options.getBoundingClientRect().height;
        const top = bounds.bottom + height + 6 <= window.innerHeight - 8
          ? bounds.bottom + 6
          : Math.max(8, bounds.top - height - 6);
        options.style.top = `${top}px`;
      }
    });
    options.querySelectorAll("[data-menu-select-option]").forEach((option) => option.addEventListener("click", () => {
      valueField.value = option.dataset.menuSelectOption;
      valueLabel.textContent = option.textContent.trim();
      options.querySelectorAll("[data-menu-select-option]").forEach((candidate) => {
        candidate.classList.toggle("is-selected", candidate === option);
        candidate.setAttribute("aria-selected", String(candidate === option));
      });
      options.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      valueField.dispatchEvent(new Event("change", { bubbles: true }));
    }));
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target.closest("[data-menu-select]")) return;
    backdrop.querySelectorAll("[data-menu-select-options]").forEach((options) => { options.hidden = true; });
    backdrop.querySelectorAll("[data-menu-select-toggle]").forEach((toggle) => toggle.setAttribute("aria-expanded", "false"));
  });
}

function initializeTimePickers(backdrop) {
  backdrop.querySelectorAll("[data-time-picker]").forEach((picker) => {
    const valueField = picker.querySelector('input[type="hidden"]');
    const toggle = picker.querySelector("[data-time-toggle]");
    const display = picker.querySelector("[data-time-display]");
    const panel = picker.querySelector("[data-time-panel]");
    const hourList = picker.querySelector("[data-time-hours]");
    const minuteList = picker.querySelector("[data-time-minutes]");
    let [hour, minute] = (valueField.value || "").split(":");
    hour = hour || "09";
    minute = minute || "00";
    const update = () => {
      valueField.value = `${hour}:${minute}`;
      display.textContent = valueField.value;
      hourList.querySelectorAll("button").forEach((button) => button.classList.toggle("is-selected", button.dataset.timeHour === hour));
      minuteList.querySelectorAll("button").forEach((button) => button.classList.toggle("is-selected", button.dataset.timeMinute === minute));
      valueField.dispatchEvent(new Event("change", { bubbles: true }));
    };
    hourList.innerHTML = Array.from({ length: 24 }, (_, index) => {
      const value = String(index).padStart(2, "0");
      return `<button type="button" data-time-hour="${value}" aria-label="${value} часов">${value}</button>`;
    }).join("");
    minuteList.innerHTML = Array.from({ length: 60 }, (_, index) => {
      const value = String(index).padStart(2, "0");
      return `<button type="button" data-time-minute="${value}" aria-label="${value} минут">${value}</button>`;
    }).join("");
    hourList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-time-hour]");
      if (button) { hour = button.dataset.timeHour; update(); }
    });
    minuteList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-time-minute]");
      if (button) { minute = button.dataset.timeMinute; update(); }
    });
    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden) {
        const bounds = toggle.getBoundingClientRect();
        const panelBounds = panel.getBoundingClientRect();
        const left = Math.min(Math.max(8, bounds.right - panelBounds.width), window.innerWidth - panelBounds.width - 8);
        const top = bounds.bottom + panelBounds.height + 6 <= window.innerHeight - 8
          ? bounds.bottom + 6
          : Math.max(8, bounds.top - panelBounds.height - 6);
        panel.style.position = "fixed";
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        hourList.querySelector(`[data-time-hour="${hour}"]`)?.scrollIntoView({ block: "center" });
        minuteList.querySelector(`[data-time-minute="${minute}"]`)?.scrollIntoView({ block: "center" });
      }
    });
    update();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target.closest("[data-time-picker]")) return;
    backdrop.querySelectorAll("[data-time-panel]").forEach((panel) => { panel.hidden = true; });
    backdrop.querySelectorAll("[data-time-toggle]").forEach((toggle) => toggle.setAttribute("aria-expanded", "false"));
  });
}

function currentConfiguration(module) {
  return modules[module];
}

function buildOrderLineItems(entries, amount, cost, totalsManuallyEdited) {
  if (!entries.length) return [];
  const lineItems = entries.map((entry) => ({
    kind: entry.kind === "services" ? "Услуга" : "Товар",
    name: String(entry.item.name || ""),
    quantity: Math.max(1, Number(entry.quantity) || 1),
    unit_price: Math.max(0, Number(entry.price) || 0),
    unit_cost: Math.max(0, Number(entry.cost) || 0),
    category: String(entry.item.category || ""),
  }));
  if (totalsManuallyEdited) {
    const last = lineItems[lineItems.length - 1];
    const quantity = last.quantity || 1;
    const priceDelta = Number(amount || 0) - lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
    const costDelta = Number(cost || 0) - lineItems.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0);
    last.unit_price = Math.max(0, last.unit_price + priceDelta / quantity);
    last.unit_cost = Math.max(0, last.unit_cost + costDelta / quantity);
  }
  return lineItems.map((item) => ({
    ...item,
    line_total: Number((item.quantity * item.unit_price).toFixed(2)),
  }));
}

function editCatalogOrderItem(item, kind, catalogs, onSaved) {
  if (!state.repository.canEdit(kind)) {
    showToast("Нет права изменять эту позицию каталога.", "error");
    return;
  }
  openModal({
    title: `Изменить: ${item.name || (kind === "services" ? "услуга" : "товар")}`,
    subtitle: "Новые цены сохранятся в каталоге. Уже созданные заказы сохраняют исходные цены.",
    fields: [
      { key: "cost_price", label: "Себестоимость", type: "number", min: "0", required: true, value: item.cost_price || "0" },
      { key: "price", label: "Цена для клиента", type: "number", min: "0", required: true, value: item.price || "0" },
    ],
    async onSubmit(values) {
      const updated = await state.repository.update(item, kind, values, state.branchId);
      const items = kind === "services" ? catalogs.services : catalogs.inventory;
      const index = items.findIndex((entry) => entry._record_id === item._record_id);
      if (index >= 0) items[index] = updated;
      Object.assign(item, updated);
      closeModal();
      onSaved();
      showToast("Цены каталога обновлены. Старые заказы не изменены.");
    },
  });
  initializeProfitPreview(modalRoot.querySelector(".modal-backdrop"), [
    { key: "price" },
    { key: "cost_price" },
  ]);
}

function newRecordFields(module, catalogs = {}) {
  const config = currentConfiguration(module);
  const labels = {
    number: "Номер заказа присвоится автоматически",
    branch: "Название филиала",
    address: "Адрес",
    manager: "Управляющий",
    employees: "Количество сотрудников",
    customer: "Клиент",
    service: "Услуга из прайса",
    product: "Товар / запчасть",
    phone: "Телефон",
    email: "Электронная почта",
    device: "Устройство и неисправность",
    appearance: "Комплектность и внешний вид",
    status: "Статус",
    assignee: "Ответственный сотрудник",
    due: "Срок выполнения",
    amount: module === "orders" ? "Цена для клиента" : "Стоимость",
    cost_amount: "Себестоимость ремонта/запчастей",
    payment_method: "Способ оплаты: наличные / безналичные",
    payment_status: "Состояние оплаты",
    task: "Задача",
    priority: "Приоритет",
    time: "Время записи",
    service: "Услуга",
    sku: "Артикул",
    category: "Категория",
    stock: "Остаток",
    stock_quantity: "Количество на складе",
    unit: "Единица измерения",
    min_stock: "Минимальный остаток",
    cost_price: "Себестоимость за единицу",
    price: module === "inventory" ? "Цена продажи за единицу" : "Цена",
    location: "Склад / филиал",
    duration: "Время выполнения",
    cost: "Себестоимость",
    operation: "Название операции",
    type: module === "finance" ? "Вид операции" : "Тип документа",
    date: "Дата",
    payment: "Способ оплаты",
    report: "Название отчёта",
    description: "Описание",
    period: "Период",
    updated: "Дата обновления",
    employee: "Имя сотрудника",
    role: "Роль",
    revenue: "Выручка",
    salary: "Зарплата",
    document: "Название документа",
    automation: "Название сценария",
    trigger: "Условие запуска",
    action: "Действие",
    runs: "Частота запуска",
    name: "Название",
  };
  if (module === "orders") {
    return [
      {
        key: "customer",
        label: labels.customer,
        required: true,
        suggestions: (catalogs.customerRecords || []).map((customer) => customer.name || customer.customer).filter(Boolean),
        suggestionDetails: Object.fromEntries((catalogs.customerRecords || [])
          .filter((customer) => customer.name || customer.customer)
          .map((customer) => [customer.name || customer.customer, customer.phone || customer.email || "Клиент из базы"])),
        customerRecords: catalogs.customerRecords || [],
      },
      { key: "date", label: "Дата заказа", type: "date", value: todayISODate() },
      { key: "phone", label: labels.phone, type: "tel" },
      { key: "email", label: labels.email, type: "email" },
      { key: "device", label: labels.device, wide: true, suggestions: catalogs.deviceSuggestions || [] },
      { key: "appearance", label: "Комплектность и внешний вид", wide: true, suggestions: catalogs.appearanceSuggestions || [] },
      { key: "category", label: labels.category, suggestions: catalogs.categorySuggestions || [] },
      { key: "assignee", label: labels.assignee, type: "menu-select", value: "", options: [{ label: "Не назначен", value: "" }, ...(catalogs.employeeNames || []).map((name) => ({ label: name, value: name }))] },
      { key: "due", label: labels.due, type: "date" },
      { key: "amount", label: labels.amount, type: "number", required: true, min: "0.01" },
      { key: "cost_amount", label: labels.cost_amount, type: "number", min: "0" },
      { key: "notes", label: "Заметки по заказу", type: "textarea", wide: true },
      { key: "comments", label: "Комментарии", type: "textarea", wide: true },
      { key: "status", label: labels.status, type: "menu-select", required: true, options: orderStatuses(), value: "Новый" },
    ];
  }
  return config.columns
    .filter(({ key }) => ![
      ...(module === "orders" ? ["number"] : []),
      "payment_method", "payment_status", "paid_amount", "orders", "spent", "lastVisit", "added_on",
      "cash_paid_total", "cashless_paid_total",
      "updated", "runs", "revenue", "salary", "role", "profit_amount",
    ].includes(key))
    .map(({ key, label }) => {
      if (key === "category" && module === "inventory") {
        const categories = [...new Set((catalogs.inventory || []).map((item) => item.category).filter(Boolean))];
        return { key, label: labels.category, suggestions: categories };
      }
      if (key === "location" && module === "inventory") {
        const branchRecords = catalogs.branches?.length
          ? catalogs.branches
          : state.member?.branch_id
            ? [{ branch: state.branchName }]
            : [];
        const branchOptions = branchRecords.map((branch) => ({
          label: branch.branch || branch.name || "Филиал",
          value: branch.branch || branch.name || "Филиал",
        }));
        const locations = [...new Set([
          ...branchOptions.map((option) => option.value),
          ...(catalogs.inventory || []).map((item) => item.location).filter(Boolean),
        ])];
        if (!locations.length) locations.push("Основной склад");
        const selectedLocation = branchOptions.find((option) => option.value === state.branchName)?.value
          || branchOptions[0]?.value
          || locations[0];
        return {
          key,
          label: labels.location,
          type: "select",
          value: selectedLocation,
          options: locations.map((location) => ({ label: location, value: location })),
        };
      }
      if (key === "price" && module === "services") {
        return { key, label: "Цена для клиента", type: "number", min: "0.01", required: true };
      }
      if (key === "cost_price" && module === "services") {
        return { key, label: "Себестоимость услуги", type: "number", min: "0", required: true };
      }
      if (key === "status") {
        return { key, label: labels[key] || "Статус", type: "menu-select", required: true, options: optionsFor(module), value: module === "calendar" ? "Подтверждена" : undefined };
      }
      if (key === "type" && module === "finance") {
        return { key, label: labels.type, type: "select", required: true, options: ["Доход", "Расход"].map((option) => ({ label: option, value: option })) };
      }
      if (key === "priority") {
        return { key, label: labels.priority, type: "select", options: ["Обычный", "Высокий", "Низкий"].map((option) => ({ label: option, value: option })) };
      }
      if (key === "payment") {
        return { key, label: labels.payment, type: "select", options: paymentOptions() };
      }
      if (key === "date" || key === "due") {
        return { key, label: labels[key] || label.label, type: "date", ...(key === "date" ? { value: todayISODate() } : {}) };
      }
      if (key === "time") {
        return { key, label: labels[key] || label.label, type: "time-picker" };
      }
      const isAmount = ["amount", "price", "cost", "cost_price", "cost_amount", "stock", "stock_quantity", "min_stock"].includes(key);
      const isArea = ["device", "description"].includes(key);
      if (key === "customer") {
        return {
          key,
          label: labels.customer,
          required: true,
          suggestions: (catalogs.customerRecords || []).map((customer) => customer.name || customer.customer).filter(Boolean),
          suggestionDetails: Object.fromEntries((catalogs.customerRecords || [])
            .filter((customer) => customer.name || customer.customer)
            .map((customer) => [customer.name || customer.customer, customer.phone || customer.email || "Клиент из базы"])),
          customerRecords: catalogs.customerRecords || [],
        };
      }
      if (key === "assignee") {
        return {
          key,
          label: labels.assignee,
          type: "menu-select",
          value: "",
          options: [{ label: "Не назначен", value: "" }, ...(catalogs.employeeNames || []).map((name) => ({ label: name, value: name }))],
        };
      }
      if (key === "service" && module === "calendar") {
        return { key, label: labels.service, suggestions: (catalogs.services || []).map((service) => service.name).filter(Boolean) };
      }
      if (key === "phone" && module === "calendar") {
        return { key, label: labels.phone, type: "tel" };
      }
      if (key === "category") {
        return { key, label: labels.category, suggestions: catalogs.categorySuggestions || [] };
      }
      if (key === "device" || key === "appearance") {
        return {
          key,
          label: labels[key] || (key === "device" ? "Устройство и неисправность" : "Комплектность и внешний вид"),
          suggestions: key === "device" ? catalogs.deviceSuggestions || [] : catalogs.appearanceSuggestions || [],
        };
      }
      return {
        key,
        label: labels[key] || label[0] + label.slice(1).toLowerCase(),
        required: key === config.columns[0]?.key,
        wide: isArea,
        type: isArea && !catalogs.descriptionSuggestions?.length ? "textarea" : key === "phone" ? "tel" : key === "email" ? "email" : isAmount ? "number" : "text",
        suggestions: key === "description" ? catalogs.descriptionSuggestions : undefined,
        ...(isAmount ? { min: "0", step: "0.01" } : {}),
      };
    });
}

function orderStatuses() {
  return ["Новый", "В работе", "Ожидает деталь", "Готов", "Выдан", "Закрыт"].map((value) => ({ label: value, value }));
}

function optionsFor(module) {
  const items = {
    orders: ["Новый", "В работе", "Ожидает деталь", "Готов", "Выдан", "Закрыт"],
    tasks: ["Новая", "В работе", "Готово"],
    calendar: ["Подтверждена", "Ожидает ответа", "Отменена"],
    services: ["Активна", "Пауза"],
    branches: ["Открыт", "Закрыт"],
    automation: ["Активен", "Пауза"],
    documents: ["Черновик", "Подписан", "Выдан"],
    reports: ["Готов", "Формируется"],
  }[module] || ["Новый", "В работе", "Готово"];
  return items.map((value) => ({ label: value, value }));
}

function paymentOptions() {
  return [
    { label: "Наличные", value: "Наличные" },
    { label: "Безналичные", value: "Безналичные" },
  ];
}

async function newRecord(moduleOverride = null, preloadedCatalogs = null) {
  const quickSale = moduleOverride === "sale";
  const page = quickSale ? "finance" : state.currentPage;
  const module = quickSale ? "finance" : moduleOverride || pageModules[page];
  const config = modules[module];
  if (!module || !config) return;
  if (!state.repository.canCreate(module)) {
    showToast("У вас нет права создавать записи в этом разделе.", "error");
    return;
  }
  const catalogs = preloadedCatalogs || { services: [], inventory: [] };
  if (module === "orders" && !preloadedCatalogs) {
    try {
      [catalogs.services, catalogs.inventory] = await Promise.all([
        state.repository.canView("services") ? state.repository.list("services", state.branchId) : Promise.resolve([]),
        state.repository.canView("inventory") ? state.repository.list("inventory", state.branchId) : Promise.resolve([]),
      ]);
    } catch (error) {
      console.error("Не удалось загрузить каталоги для нового заказа.", error);
      showToast(`Не удалось загрузить услуги и товары: ${error.message}`, "error");
      return;
    }
  }
  if (["orders", "calendar"].includes(module) && !catalogs.customerRecords) {
    try {
      const [customerRecords, members, orderHistory] = await Promise.all([
        state.repository.canView("customers") ? state.repository.list("customers", state.branchId) : Promise.resolve([]),
        state.repository.canView("team") ? state.repository.members() : Promise.resolve([]),
        state.repository.canView("orders") ? state.repository.list("orders", state.branchId) : Promise.resolve([]),
      ]);
      catalogs.customerRecords = customerRecords;
      catalogs.employeeNames = [...new Set(members
        .filter((member) => !["blocked", "Заблокирован"].includes(member.status))
        .map((member) => member.full_name || member.name)
        .filter(Boolean))];
      catalogs.deviceSuggestions = [...new Set(orderHistory.map((order) => order.device).filter(Boolean))];
      catalogs.appearanceSuggestions = [...new Set(orderHistory.map((order) => order.appearance).filter(Boolean))];
      catalogs.categorySuggestions = [...new Set([
        ...orderHistory.map((order) => order.category),
        ...(catalogs.services || []).map((service) => service.category),
        ...(catalogs.inventory || []).map((item) => item.category),
      ].filter(Boolean))];
      catalogs.descriptionSuggestions = [...new Set(orderHistory.map((order) => order.description).filter(Boolean))];
      if (module === "calendar" && state.repository.canView("services")) {
        catalogs.services = await state.repository.list("services", state.branchId);
      }
    } catch (error) {
      console.error("Не удалось загрузить подсказки для записи.", error);
      showToast(`Не удалось загрузить клиентов и сотрудников: ${error.message}`, "error");
      return;
    }
  }
  if (module === "tasks" && !catalogs.employeeNames) {
    try {
      const members = state.repository.canView("team")
        ? await state.repository.members()
        : [state.member];
      catalogs.employeeNames = [...new Set(members
        .filter((member) => !["blocked", "Заблокирован"].includes(member.status))
        .filter((member) => state.branchId === "all"
          || !member.branch_id
          || member.branch_id === state.branchId)
        .map((member) => member.full_name || member.name)
        .filter(Boolean))];
    } catch (error) {
      console.error("Не удалось загрузить список сотрудников для задачи.", error);
      showToast(`Не удалось загрузить сотрудников: ${error.message}`, "error");
      return;
    }
  }
  if (module === "inventory" && !preloadedCatalogs && state.repository.canView("inventory")) {
    try {
      catalogs.inventory = await state.repository.list("inventory", state.branchId);
    } catch (error) {
      console.error("Не удалось загрузить категории товаров.", error);
      showToast(`Не удалось загрузить категории товаров: ${error.message}`, "error");
      return;
    }
  }
  if (module === "orders" && !catalogs.services.length && state.repository.canCreate("services") && !catalogs.skipServiceSetup) {
    openServiceSetup(catalogs);
    return;
  }
  catalogs.branches = state.branches;
  const fields = newRecordFields(module, catalogs);
  if (quickSale) {
    const typeField = fields.find((field) => field.key === "type");
    const dateField = fields.find((field) => field.key === "date");
    const paymentField = fields.find((field) => field.key === "payment");
    const amountField = fields.find((field) => field.key === "amount");
    if (typeField) {
      typeField.value = "Доход";
      typeField.options = [{ label: "Продажа / доход", value: "Доход" }];
    }
    if (dateField) dateField.value = todayISODate();
    if (paymentField) paymentField.required = true;
    if (amountField) {
      amountField.label = "Сумма продажи";
      amountField.required = true;
      amountField.min = "0.01";
    }
  }
  openModal({
    title: quickSale ? "Новая продажа" : config.addLabel,
    subtitle: module === "orders" ? "Номер присвоится автоматически при сохранении в PostgreSQL." : "Запись сохранится в общей базе компании.",
    fields,
    async onSubmit(values) {
      if (module === "orders") {
        const selectedItems = catalogs.selectedItems || [];
        values.service = selectedItems.filter((entry) => entry.kind === "services").map((entry) => entry.item.name).join(", ");
        values.product = selectedItems.filter((entry) => entry.kind === "inventory").map((entry) => entry.item.name).join(", ");
        values.amount = selectedItems.length && !catalogs.manualOrderTotals
          ? selectedItems.reduce((sum, entry) => sum + entry.quantity * entry.price, 0).toFixed(2)
          : values.amount;
        values.cost_amount = selectedItems.length && !catalogs.manualOrderTotals
          ? selectedItems.reduce((sum, entry) => sum + entry.quantity * entry.cost, 0).toFixed(2)
          : values.cost_amount;
        const selectedCategories = selectedItems.map((entry) => entry.item.category).filter(Boolean);
        if (selectedCategories.length) values.category = [...new Set(selectedCategories)].join(", ");
        values.line_items = buildOrderLineItems(selectedItems, values.amount, values.cost_amount, catalogs.manualOrderTotals);
      }
      const hadBranches = state.branches.length > 0;
      const recordBranchId = state.branchId === "all"
        ? state.branches[0]?._record_id || null
        : state.branchId;
      const record = await state.repository.create(module, values, recordBranchId);
      if (module === "branches") {
        const branches = await state.repository.list("branches");
        state.branches = branches;
        if (!state.branchId || (state.branchId === "all" && hadBranches)) {
          state.branchId = record._record_id;
        }
        updateBranchSwitcher();
      }
      closeModal();
      showToast(module === "orders" ? `Создан заказ №${record.number}` : `${config.addLabel}: запись сохранена в XVII Cloud`);
      await loadCurrentPage();
    },
  });
  if (module === "orders") initializeOrderCatalogMenu(catalogs);
}

function openServiceSetup(catalogs) {
  openModal({
    title: "Добавьте первую услугу",
    subtitle: "Сохраните услугу в прайсе один раз — затем она будет доступна в каждом заказе.",
    className: "service-setup-modal",
    fields: [
      { key: "name", label: "Название услуги", required: true, placeholder: "Например, диагностика" },
      { key: "category", label: "Категория", placeholder: "Например, ремонт" },
      { key: "price", label: "Цена для клиента", type: "number", min: "0.01", required: true },
      { key: "cost_price", label: "Себестоимость услуги", type: "number", min: "0", required: true },
    ],
    submitLabel: "Сохранить и продолжить",
    async onSubmit(values) {
      const branchId = state.branchId === "all" ? state.branches[0]?._record_id || null : state.branchId;
      const service = await state.repository.create("services", { ...values, status: "Активна" }, branchId);
      closeModal();
      showToast(`Услуга сохранена. Прибыль: ${money(Number(service.profit_amount))}.`);
      await newRecord("orders", {
        ...catalogs,
        services: [service],
        initialService: service.name,
        skipServiceSetup: true,
      });
    },
  });
}

function initializeOrderCatalogMenu(catalogs) {
  const form = modalRoot.querySelector("#modal-form");
  if (!form) return;
  const selected = new Map();
  let activeTab = "services";
  const availableLocations = [...new Set([
    ...(catalogs.branches || [])
      .filter((branch) => state.branchId === "all" || branch._record_id === state.branchId)
      .map((branch) => branch.branch || branch.name || "Филиал"),
    ...(catalogs.inventory || []).map((item) => item.location).filter(Boolean),
  ])];
  const catalogWidget = document.createElement("section");
  catalogWidget.className = "order-catalog form-field-wide";
  catalogWidget.innerHTML = `<div class="order-catalog-heading"><div><strong>Услуги и товары</strong><small>Каталог филиала «${escapeHTML(state.branchName)}»</small></div><span class="order-catalog-count">0 выбрано</span></div><div class="order-catalog-tabs"><button type="button" class="is-active" data-catalog-tab="services">Услуги <span>${catalogs.services.length}</span></button><button type="button" data-catalog-tab="inventory">Товары <span>${catalogs.inventory.length}</span></button></div><label class="order-catalog-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="Найти услугу или товар" aria-label="Поиск по каталогу" /></label><button class="order-catalog-add" type="button" data-catalog-add ${state.repository.canCreate("inventory") ? "" : "hidden"}>${icon("plus")} Добавить товар в каталог</button><div class="order-catalog-new-item" data-new-inventory-item hidden><strong>Новый товар</strong><div class="catalog-new-fields"><label><span>Название</span><input name="name" required maxlength="120" placeholder="Название товара" /></label><label><span>Категория</span><input name="category" maxlength="80" placeholder="Категория" /></label><label><span>Склад / филиал</span><select name="location" required>${availableLocations.map((location) => `<option value="${escapeHTML(location)}"${location === state.branchName ? " selected" : ""}>${escapeHTML(location)}</option>`).join("") || `<option value="${escapeHTML(state.branchName)}">${escapeHTML(state.branchName)}</option>`}</select></label><label><span>Себестоимость</span><input name="cost_price" type="number" min="0" step="0.01" value="0" required /></label><label><span>Цена для клиента</span><input name="price" type="number" min="0" step="0.01" value="0" required /></label><label><span>Количество</span><input name="stock_quantity" type="number" min="0" step="1" value="1" required /></label></div><div class="catalog-new-actions"><button type="button" class="button button-secondary" data-cancel-new-item>Отмена</button><button type="button" class="button button-primary" data-save-new-item>Сохранить товар</button></div></div><div class="order-catalog-list"></div><div class="order-catalog-selected" hidden></div><div class="order-profit-preview"><span>Ожидаемая прибыль</span><strong>0 ₽</strong></div>`;
  form.querySelector(".modal-fields")?.prepend(catalogWidget);
  const list = catalogWidget.querySelector(".order-catalog-list");
  const selectedContainer = catalogWidget.querySelector(".order-catalog-selected");
  const searchField = catalogWidget.querySelector(".order-catalog-search input");
  const amountField = form.elements.namedItem("amount");
  const costField = form.elements.namedItem("cost_amount");

  const renderCatalog = () => {
    const sourceItems = activeTab === "services" ? catalogs.services : catalogs.inventory;
    const items = sourceItems.filter((item) => activeTab !== "services" || !item.status || item.status === "Активна");
    const filtered = items.filter((item) => `${item.name || ""} ${item.category || ""} ${item.sku || ""}`
      .toLocaleLowerCase("ru-RU").includes(searchField.value.trim().toLocaleLowerCase("ru-RU")));
    list.innerHTML = filtered.length ? filtered.map((item) => {
      const key = `${activeTab}:${item._record_id || item.name}`;
      const isSelected = selected.has(key);
      const category = [item.category, activeTab === "inventory" ? item.location : item.duration].filter(Boolean).join(" · ") || "Без категории";
      const price = Number(item.price || 0);
      const cost = Number(item.cost_price || 0);
      const canEdit = state.repository.canEdit(activeTab);
      return `<div class="order-catalog-item${isSelected ? " is-selected" : ""}"><button type="button" class="catalog-item-select" data-catalog-key="${escapeHTML(key)}" aria-label="${isSelected ? "Убрать" : "Добавить"} ${escapeHTML(item.name || "товар")}"><span class="catalog-item-check">${isSelected ? "✓" : "+"}</span><span class="catalog-item-copy"><strong>${escapeHTML(item.name || "Без названия")}</strong><small>${escapeHTML(category)}</small></span><span class="catalog-item-prices"><strong>${money(price)}</strong><small>себест. ${money(cost)}</small></span></button>${canEdit ? `<button type="button" class="catalog-item-edit" data-catalog-edit="${escapeHTML(key)}">${icon("tool")} Изменить</button>` : ""}</div>`;
    }).join("") : `<div class="order-catalog-empty">${items.length ? "Ничего не найдено по запросу." : activeTab === "services" ? "В прайсе пока нет услуг." : "В выбранном филиале нет товаров."}</div>`;
    catalogWidget.querySelectorAll("[data-catalog-tab]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.catalogTab === activeTab);
    });
  };

  const updateTotals = (recalculateFields = true) => {
    const entries = [...selected.values()];
    const saleTotal = entries.reduce((sum, entry) => sum + entry.quantity * entry.price, 0);
    const costTotal = entries.reduce((sum, entry) => sum + entry.quantity * entry.cost, 0);
    catalogWidget.querySelector(".order-catalog-count").textContent = `${entries.length} выбрано`;
    selectedContainer.hidden = entries.length === 0;
    selectedContainer.innerHTML = entries.length
      ? `<div class="order-catalog-selected-heading"><strong>В заказе</strong><span>Кол-во · цена клиенту · себестоимость</span></div>${entries.map((entry) => `<div class="order-catalog-line" data-selected-key="${escapeHTML(entry.key)}"><span class="order-catalog-line-name"><strong>${escapeHTML(entry.item.name || "Без названия")}</strong><small>${entry.kind === "services" ? "Услуга" : "Товар"}</small></span><label class="catalog-quantity"><span>Кол-во</span><input type="number" min="1" step="1" value="${entry.quantity}" data-selected-quantity /></label><label class="catalog-price"><span>Цена клиенту</span><input type="number" min="0" step="0.01" value="${entry.price.toFixed(2)}" data-selected-price /></label><label class="catalog-cost"><span>Себестоимость</span><input type="number" min="0" step="0.01" value="${entry.cost.toFixed(2)}" data-selected-cost /></label><button type="button" class="catalog-remove" aria-label="Убрать позицию">×</button></div>`).join("")}`
      : "";
    if (entries.length && recalculateFields) {
      catalogs.manualOrderTotals = false;
      amountField.value = saleTotal.toFixed(2);
      costField.value = costTotal.toFixed(2);
    }
    const preview = catalogWidget.querySelector(".order-profit-preview");
    const displayedProfit = Number(amountField.value || 0) - Number(costField.value || 0);
    preview.querySelector("strong").textContent = money(displayedProfit);
    preview.classList.toggle("is-loss", displayedProfit < 0);
    catalogWidget.dataset.selectedNames = entries.map((entry) => entry.item.name || "").join(", ");
    catalogs.selectedItems = entries;
  };

  catalogWidget.addEventListener("click", (event) => {
    const tabButton = event.target.closest("[data-catalog-tab]");
    if (tabButton) {
      activeTab = tabButton.dataset.catalogTab;
      renderCatalog();
      return;
    }
    const itemButton = event.target.closest("[data-catalog-key]");
    if (itemButton) {
      const key = itemButton.dataset.catalogKey;
      if (selected.has(key)) selected.delete(key);
      else {
        const kind = key.slice(0, key.indexOf(":"));
        const items = kind === "services" ? catalogs.services : catalogs.inventory;
        const item = items.find((entry) => `${kind}:${entry._record_id || entry.name}` === key);
        if (item) selected.set(key, { key, kind, item, quantity: 1, price: Number(item.price || 0), cost: Number(item.cost_price || 0) });
      }
      catalogs.manualOrderTotals = false;
      renderCatalog();
      updateTotals();
      return;
    }
    if (event.target.closest("[data-catalog-add]")) {
      const newItemPanel = catalogWidget.querySelector("[data-new-inventory-item]");
      newItemPanel.hidden = !newItemPanel.hidden;
      catalogWidget.querySelector("[data-catalog-add]").hidden = !newItemPanel.hidden;
      if (!newItemPanel.hidden) newItemPanel.querySelector('[name="name"]').focus();
      return;
    }
    if (event.target.closest("[data-cancel-new-item]")) {
      catalogWidget.querySelector("[data-new-inventory-item]").hidden = true;
      catalogWidget.querySelector("[data-catalog-add]").hidden = false;
      return;
    }
    const editButton = event.target.closest("[data-catalog-edit]");
    if (editButton) {
      const key = editButton.dataset.catalogEdit;
      const kind = key.slice(0, key.indexOf(":"));
      const item = (kind === "services" ? catalogs.services : catalogs.inventory)
        .find((entry) => `${kind}:${entry._record_id || entry.name}` === key);
      if (item) editCatalogOrderItem(item, kind, catalogs, () => {
        const selectedEntry = selected.get(key);
        if (selectedEntry) {
          selectedEntry.item = item;
          selectedEntry.price = Number(item.price || 0);
          selectedEntry.cost = Number(item.cost_price || 0);
          catalogs.manualOrderTotals = false;
          updateTotals();
        }
        renderCatalog();
      });
      return;
    }
    if (event.target.closest(".catalog-remove")) {
      const line = event.target.closest("[data-selected-key]");
      selected.delete(line.dataset.selectedKey);
      catalogs.manualOrderTotals = false;
      renderCatalog();
      updateTotals();
    }
  });
  catalogWidget.addEventListener("input", (event) => {
    const line = event.target.closest("[data-selected-key]");
    if (!line) return;
    const entry = selected.get(line.dataset.selectedKey);
    if (!entry) return;
    if (event.target.matches("[data-selected-quantity]")) entry.quantity = Math.max(1, Number(event.target.value) || 1);
    if (event.target.matches("[data-selected-price]")) entry.price = Math.max(0, Number(event.target.value) || 0);
    if (event.target.matches("[data-selected-cost]")) entry.cost = Math.max(0, Number(event.target.value) || 0);
    updateTotals(true);
  });
  searchField.addEventListener("input", renderCatalog);
  catalogWidget.querySelector("[data-save-new-item]").addEventListener("click", async (event) => {
    if (!state.repository.canCreate("inventory")) {
      showToast("У вас нет права добавлять товары в каталог.", "error");
      return;
    }
    const newItemPanel = catalogWidget.querySelector("[data-new-inventory-item]");
    const inputs = [...newItemPanel.querySelectorAll("input, select")];
    const invalidInput = inputs.find((input) => !input.checkValidity());
    if (invalidInput) {
      invalidInput.reportValidity();
      return;
    }
    const values = Object.fromEntries(inputs.map((input) => [input.name, input.value]));
    const submit = event.currentTarget;
    submit.disabled = true;
    try {
      const selectedBranch = state.branches.find((branch) => (branch.branch || branch.name) === values.location);
      const branchId = selectedBranch?._record_id || (state.branchId === "all" ? state.branches[0]?._record_id || null : state.branchId);
      const item = await state.repository.create("inventory", values, branchId);
      catalogs.inventory.unshift(item);
      const key = `inventory:${item._record_id || item.name}`;
      selected.set(key, { key, kind: "inventory", item, quantity: 1, price: Number(item.price || 0), cost: Number(item.cost_price || 0) });
      catalogs.manualOrderTotals = false;
      newItemPanel.querySelectorAll("input").forEach((input) => {
        if (input.name === "name" || input.name === "category") input.value = "";
        else if (input.name === "stock_quantity") input.value = "1";
        else if (input.name === "cost_price" || input.name === "price") input.value = "0";
      });
      newItemPanel.hidden = true;
      catalogWidget.querySelector("[data-catalog-add]").hidden = false;
      activeTab = "inventory";
      renderCatalog();
      updateTotals();
      showToast("Товар добавлен в каталог и заказ.");
    } catch (error) {
      showToast(`Не удалось добавить товар: ${error.message}`, "error");
    } finally {
      submit.disabled = false;
    }
  });
  [amountField, costField].forEach((field) => field?.addEventListener("input", () => {
    catalogs.manualOrderTotals = true;
    updateTotals(false);
  }));
  if (catalogs.initialService) {
    const initial = catalogs.services.find((item) => item.name === catalogs.initialService);
    if (initial) {
      const key = `services:${initial._record_id || initial.name}`;
      selected.set(key, { key, kind: "services", item: initial, quantity: 1, price: Number(initial.price || 0), cost: Number(initial.cost_price || 0) });
    }

  }
  renderCatalog();
  updateTotals();
}

function editRecord(record, moduleOverride) {
  const module = moduleOverride || (state.currentPage === "dashboard" ? "orders" : pageModules[state.currentPage]);
  if (!module || !record) return;
  if (!state.repository.canEdit(module)) {
    showToast("У вас нет права изменять записи в этом разделе.", "error");
    return;
  }
  const ignored = new Set(["number", "payment_method", "payment_status", "paid_amount", "cash_paid_total", "cashless_paid_total", "orders", "spent", "lastVisit"]);
  const fields = newRecordFields(module, { branches: state.branches, inventory: state.data.inventory || [] })
    .filter((field) => !ignored.has(field.key))
    .map((field) => {
      const value = record[field.key] === "—" || record[field.key] === null || record[field.key] === undefined
        ? ""
        : record[field.key];
      if (field.key === "assignee" && field.type === "menu-select" && value
        && !field.options.some((option) => option.value === value)) {
        field.options.push({ label: value, value });
      }
      return { ...field, value };
    });
  openModal({
    title: `Изменить запись${module === "orders" ? ` № ${record.number}` : ""}`,
    subtitle: "Изменения сохраняются в общей базе сразу после подтверждения.",
    fields,
    submitLabel: "Сохранить изменения",
    async onSubmit(values) {
      await state.repository.update(record, module, values, state.branchId);
      if (module === "branches") {
        state.branches = await state.repository.list("branches");
        updateBranchSwitcher();
      }
      closeModal();
      showToast("Изменения сохранены");
      await loadCurrentPage();
    },
  });
}

function confirmRecordDelete(record, module) {
  if (!state.repository.canDelete(module)) {
    showToast("У вас нет права удалять записи в этом разделе.", "error");
    return;
  }
  const title = record.number ? `заказ № ${record.number}` : record.branch || record.name || record.customer || record.product || record.task || record.service || "выбранную запись";
  const destination = module === "branches"
    ? state.branches.find((branch) => branch._record_id !== record._record_id)
    : null;
  openModal({
    title: "Безвозвратно удалить запись?",
    subtitle: module === "branches"
      ? destination
        ? `Филиал «${title}» будет удалён. Его записи и сотрудники автоматически перейдут в филиал «${destination.branch || destination.name || "без названия"}».`
        : `Филиал «${title}» нельзя удалить, пока он последний. Сначала создайте другой филиал.`
      : `Запись «${title}» будет удалена из общей базы, отменить это действие нельзя.`,
    fields: [{ key: "confirm", label: "Для подтверждения введите УДАЛИТЬ", required: true }],
    submitLabel: "Удалить навсегда",
    async onSubmit(values) {
      if (values.confirm !== "УДАЛИТЬ") throw new Error("Для подтверждения удаления введите УДАЛИТЬ.");
      const deletion = await state.repository.deleteRecord(record);
      if (module === "branches") {
        state.branches = await state.repository.list("branches");
        if (!state.branches.some((branch) => branch._record_id === state.branchId)) {
          state.branchId = state.branches[0]?._record_id || null;
        }
        updateBranchSwitcher();
      }
      closeModal();
      showToast(module === "branches"
        ? `Филиал удалён. Записи и сотрудники перенесены в «${deletion?.target_branch || destination?.branch || destination?.name || "другой филиал"}».`
        : "Запись полностью удалена");
      await loadCurrentPage();
    },
  });
  const submit = modalRoot.querySelector('button[type="submit"]');
  submit.classList.add("button-danger");
}

function recordPayment(record) {
  if (!state.repository.canPayOrders()) {
    showToast("У вас нет права принимать оплату по заказам.", "error");
    return;
  }
  const unpaid = Math.max(0, Number(record.amount || record._total || 0) - Number(record.paid_amount || record._paid_total || 0));
  if (unpaid <= 0) {
    showToast("Заказ полностью оплачен.");
    return;
  }
  openModal({
    title: `Предоплата / оплата заказа № ${record.number}`,
    subtitle: `К оплате осталось ${money(unpaid)}. Можно внести предоплату или распределить сумму между наличными и безналичной оплатой.`,
    fields: [
      { key: "cash_amount", label: "Наличными", type: "number", min: "0", value: "0.00" },
      { key: "cashless_amount", label: "Безналично", type: "number", min: "0", value: "0.00" },
    ],
    submitLabel: "Зарегистрировать платёж",
    async onSubmit(values) {
      const cash = Number(values.cash_amount || 0);
      const cashless = Number(values.cashless_amount || 0);
      if (cash < 0 || cashless < 0 || cash + cashless <= 0) {
        throw new Error("Укажите положительную сумму наличными и/или безналично.");
      }
      if (cash + cashless > unpaid + 0.005) {
        throw new Error(`Сумма оплаты превышает остаток ${money(unpaid)}.`);
      }
      const payment = await state.repository.recordPayment(record, values.cash_amount, values.cashless_amount);
      closeModal();
      const total = cash + cashless;
      const complete = Number(payment.order.paid_amount) >= Number(payment.order.amount);
      showToast(complete
        ? `Полная оплата ${money(total)} зарегистрирована; заказ закрыт.`
        : `Предоплата ${money(total)} зарегистрирована.`);
      if (state.currentPage === "dashboard") state.dashboard = null;
      await loadCurrentPage();
      return payment;
    },
  });
}

function showRecordActions(anchor, row, index, source = "workspace") {
  const module = source === "dashboard" ? "orders" : pageModules[state.currentPage];
  const protectedPayment = module === "finance" && Boolean(row.order_id);
  const canPay = module === "orders" && state.repository.canPayOrders()
    && Number(row.amount || 0) > Number(row.paid_amount || 0);
  const canPrint = module === "orders" && state.repository.canPrintReceipt();
  const canEdit = state.repository.canEdit(module);
  const canDelete = state.repository.canDelete(module);
  const options = [
    `<button data-row-action="open">${icon("file")} Открыть карточку</button>`,
    ...(canEdit && !protectedPayment ? [`<button data-row-action="edit">${icon("tool")} Изменить запись</button>`] : []),
    ...(canPay ? [`<button data-row-action="pay">${icon("wallet")} Принять оплату</button>`] : []),
    ...(canPrint ? [`<button data-row-action="receipt">${icon("file")} Напечатать талон приёма</button>`] : []),
    ...(canDelete && !protectedPayment ? ['<button class="popover-danger" data-row-action="delete"><span class="danger-mark">×</span> Удалить навсегда</button>'] : []),
  ];
  showPopover(options.join(""), anchor);
  popoverRoot.querySelector('[data-row-action="open"]').addEventListener("click", () => {
    popoverRoot.innerHTML = "";
    if (module === "orders") {
      navigate("orders");
      window.setTimeout(() => openRecordCard(row), 0);
    } else openRecordCard(row);
  });
  popoverRoot.querySelector('[data-row-action="edit"]')?.addEventListener("click", () => {
    popoverRoot.innerHTML = "";
    if (module === "orders" && source === "dashboard" && state.currentPage !== "orders") {
      navigate("orders");
      window.setTimeout(() => editRecord(row), 0);
    } else editRecord(row);
  });
  popoverRoot.querySelector('[data-row-action="pay"]')?.addEventListener("click", () => {
    popoverRoot.innerHTML = "";
    recordPayment(row);
  });
  popoverRoot.querySelector('[data-row-action="receipt"]')?.addEventListener("click", async () => {
    popoverRoot.innerHTML = "";
    try {
      await createAndPrintReceipt(row);
    } catch (error) {
      console.error("Не удалось оформить талон приёма.", error);
      showToast(error.message, "error");
    }
  });
  popoverRoot.querySelector('[data-row-action="delete"]')?.addEventListener("click", () => {
    popoverRoot.innerHTML = "";
    confirmRecordDelete(row, module);
  });
}

function openRecordCard(record) {
  const amount = Number(record.amount || record._total || 0);
  const paid = Number(record.paid_amount || record._paid_total || 0);
  const fields = Object.entries(record)
    .filter(([key]) => !key.startsWith("_") && !["amount", "notes", "comments", "cash_paid_total", "cashless_paid_total", "paid_amount", "payment_method", "payment_status", "profit_amount"].includes(key))
    .map(([key, value]) => `<div class="record-detail-row"><span>${escapeHTML(modules[record._module || pageModules[state.currentPage]]?.columns.find((column) => column.key === key)?.label || key)}</span><strong>${escapeHTML(value || "—")}</strong></div>`).join("");
  openModal({
    title: record.number ? `Заказ № ${record.number}` : describeRecord(record),
    subtitle: `Информация загружена из облачной базы XVII${record._created_at ? ` · ${new Date(record._created_at).toLocaleString("ru-RU")}` : ""}`,
    fields: [],
    className: record.number ? "order-card" : "",
    submitLabel: "Закрыть",
    async onSubmit() { closeModal(); },
  });
  const form = modalRoot.querySelector("#modal-form");
  const cashPaid = Number(record.cash_paid_total || 0);
  const cashlessPaid = Number(record.cashless_paid_total || 0);
  const canUpdate = record.number && state.repository.canEdit("orders");
  const canPay = record.number && state.repository.canPayOrders() && amount > paid;
  const canReceipt = record.number && state.repository.canPrintReceipt();
  form.innerHTML = `<div class="record-detail-list">${fields}${record.number ? `<div class="record-detail-row"><span>Стоимость заказа</span><strong>${money(amount)}</strong></div><div class="record-detail-row"><span>Оплачено · остаток</span><strong>${money(paid)} · ${money(amount - paid)}</strong></div><div class="record-detail-row"><span>Наличными · безналично</span><strong>${money(cashPaid)} · ${money(cashlessPaid)}</strong></div><div class="record-detail-row"><span>Состояние оплаты</span><strong>${escapeHTML(record.payment_status || "Не оплачено")}</strong></div><div class="record-detail-row"><span>Статус заказа</span><strong>${escapeHTML(record.status || "Новый")}</strong></div>` : ""}</div>${record.number && canUpdate ? `<section class="order-card-notes"><label class="form-field form-field-wide"><span>Заметки по заказу</span><textarea name="order-notes" rows="3" maxlength="4000">${escapeHTML(record.notes || "")}</textarea></label><div class="order-comments"><strong>Комментарии</strong><div class="order-comments-history">${escapeHTML(record.comments || "Комментариев пока нет.")}</div><label class="form-field form-field-wide"><span>Новый комментарий</span><textarea name="order-comment" rows="3" maxlength="2000" placeholder="Добавьте комментарий к заказу"></textarea></label></div><p class="order-card-error" role="alert" hidden></p><button class="button button-secondary" type="button" data-save-order-notes>Сохранить заметки и комментарий</button></section>` : ""}<div class="modal-footer"><button class="button button-secondary" type="button" data-close-modal>Закрыть</button>${canReceipt ? `<button class="button button-secondary" type="button" data-receipt-button>${icon("file")} Талон</button>` : ""}${canPay ? `<button class="button button-primary" type="button" data-payment-button>${icon("wallet")} Предоплата / оплата</button>` : ""}${record.number && canUpdate ? `<button class="button button-primary" type="button" data-edit-button>${icon("tool")} Изменить заказ</button>` : ""}</div>`;
  form.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
  form.querySelector("[data-payment-button]")?.addEventListener("click", () => { closeModal(); recordPayment(record); });
  form.querySelector("[data-edit-button]")?.addEventListener("click", () => { closeModal(); editRecord(record); });
  form.querySelector("[data-save-order-notes]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const notes = form.elements.namedItem("order-notes").value.trim();
    const comment = form.elements.namedItem("order-comment").value.trim();
    const comments = comment
      ? `${record.comments ? `${record.comments}\n\n` : ""}${new Date().toLocaleString("ru-RU")} · ${state.member.full_name || state.user.email}: ${comment}`
      : record.comments || "";
    button.disabled = true;
    try {
      const updated = await state.repository.update(record, "orders", { notes, comments }, state.branchId);
      closeModal();
      showToast(comment ? "Заметка и комментарий сохранены." : "Заметка сохранена.");
      openRecordCard(updated);
    } catch (error) {
      const message = form.querySelector(".order-card-error");
      message.textContent = error.message;
      message.hidden = false;
      button.disabled = false;
    }
  });
  form.querySelector("[data-receipt-button]")?.addEventListener("click", async () => {
    closeModal();
    try { await createAndPrintReceipt(record); } catch (error) { showToast(error.message, "error"); }
  });
}

function describeRecord(record) {
  return record.customer || record.employee || record.task || record.product || record.service || record.operation || record.report || record.document || record.name || record.automation || record.branch || record.setting || "Запись XVII";
}

async function createAndPrintReceipt(order) {
  if (!state.repository.canPrintReceipt()) throw new Error("У вас нет права печатать талон приёма.");
  if (!state.receiptTemplate) {
    const company = await state.repository.receiptTemplate();
    state.receiptTemplate = company?.receipt_template || {};
  }
  await printReceipt(order, state.receiptTemplate);
  if (state.repository.canCreate("documents")) {
    await state.repository.create("documents", {
      document: "Квитанция о приёме",
      number: `КВ-${order.number}`,
      customer: order.customer || "",
      type: "Квитанция",
      date: todayISODate(),
      order_id: order._record_id,
    }, state.branchId);
  }
  showToast(`Квитанция по заказу № ${order.number} готова к печати`);
}

function renderReceiptForm() {
  const form = pageContent.querySelector("#receipt-form");
  if (!form) return;
  form.querySelectorAll("input,textarea").forEach((field) => {
    field.addEventListener("input", () => {
      if (field.value.length > Number(field.maxLength)) field.value = field.value.slice(0, field.maxLength);
    });
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form).entries());
      values.show_estimate = form.elements.namedItem("show_estimate").checked;
      state.receiptTemplate = await state.repository.saveReceiptTemplate(values);
      showToast("Шаблон квитанции сохранён для всей компании.");
    } catch (error) {
      console.error("Не удалось сохранить шаблон квитанции.", error);
      showToast(error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });
}

function bindReceiptForm() {
  renderReceiptForm();
}

function bindSettingsEvents() {
  pageContent.querySelectorAll("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => {
    state.settingsTab = button.dataset.settingsTab;
    renderPage();
  }));
  pageContent.querySelector("#permission-user")?.addEventListener("change", (event) => {
    state.permissionUserId = event.currentTarget.value;
    renderPage();
  });
  pageContent.querySelectorAll('input[name="permission"][value$=".create"]').forEach((input) => input.addEventListener("change", () => {
    const module = input.value.replace(/\.create$/, "");
    const importPermission = pageContent.querySelector(`input[name="permission"][value="${module}.import"]`);
    if (importPermission) {
      importPermission.disabled = !input.checked || !["orders", "customers", "inventory", "services"].includes(module);
      if (importPermission.disabled) importPermission.checked = false;
    }
  }));
  pageContent.querySelector("[data-save-permissions]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const userId = pageContent.querySelector("#permission-user")?.value;
    if (!userId) return;
    const permissions = Object.fromEntries(
      [...pageContent.querySelectorAll('input[name="permission"]')]
        .filter((input) => permissionKeys.includes(input.value))
        .map((input) => [input.value, input.checked]),
    );
    button.disabled = true;
    try {
      const savedPermissions = await state.repository.updatePermissions(userId, permissions);
      if (!savedPermissions || typeof savedPermissions !== "object" || Array.isArray(savedPermissions)) {
        throw new Error("Сервер не подтвердил сохранение прав сотрудника.");
      }
      const refreshedUsers = await state.repository.users();
      const user = (refreshedUsers.users || []).find((candidate) => candidate.user_id === userId);
      if (!user) throw new Error("Права обновлены, но сотрудника не удалось повторно загрузить для проверки.");
      const rpcMismatches = permissionKeys.filter((key) =>
        (savedPermissions[key] === true) !== permissions[key]);
      const databaseMismatches = permissionKeys.filter((key) =>
        (user.permissions?.[key] === true) !== permissions[key]);
      if (rpcMismatches.length || databaseMismatches.length) {
        const details = [
          rpcMismatches.length ? `ответ RPC: ${rpcMismatches.join(", ")}` : "",
          databaseMismatches.length ? `прочитано из базы: ${databaseMismatches.join(", ")}` : "",
        ].filter(Boolean).join("; ");
        throw new Error(`Права из базы отличаются от выбранных. Обновите страницу и повторите сохранение. ${details}`);
      }
      state.users = refreshedUsers.users;
      showToast("Права доступа сотрудника сохранены.");
      renderPage();
    } catch (error) {
      console.error("Не удалось сохранить права сотрудника.", error);
      showToast(error.message, "error");
      button.disabled = false;
    }
  });
}

function renderTeamInvite() {
  if (!state.repository.canManageTeam()) {
    showToast("У вас нет права управлять сотрудниками.", "error");
    return;
  }
  const roleOptions = rolesFor(state.member.role);
  const branchOptions = [
    { label: "Все филиалы", value: "" },
    ...state.branches.map((branch) => ({ label: branch.branch || branch.name, value: branch._record_id })),
  ];
  openModal({
    title: "Добавить пользователя",
    subtitle: "Учётная запись создастся в Supabase Auth. Не отправляйте временный пароль по электронной почте.",
    fields: [
      { key: "full_name", label: "Имя сотрудника", required: true, maxLength: 100 },
      { key: "email", label: "Рабочая почта", type: "email", required: true },
      { key: "password", label: "Временный пароль · от 12 символов", type: "password", required: true },
      { key: "role", label: "Роль и права", type: "select", required: true, options: roleOptions },
      { key: "branch_id", label: "Доступный филиал", type: "select", options: branchOptions },
    ],
    submitLabel: "Создать пользователя",
    async onSubmit(values) {
      if (values.password.length < 12) throw new Error("Пароль сотрудника должен содержать не менее 12 символов.");
      await state.repository.inviteUser(values);
      closeModal();
      showToast(`Аккаунт ${values.email} создан. Передайте сотруднику логин и временный пароль безопасно.`);
      await loadCurrentPage();
    },
  });
}

function renderTeamRepair() {
  if (!state.repository.isOwner()) {
    showToast("Восстановить доступ может только владелец компании.", "error");
    return;
  }
  const branchOptions = [
    { label: "Все филиалы", value: "" },
    ...state.branches.map((branch) => ({ label: branch.branch || branch.name, value: branch._record_id })),
  ];
  openModal({
    title: "Восстановить доступ сотрудника",
    subtitle: "Используйте для аккаунта, созданного через XVII, который ошибочно попал в отдельную организацию. Его отдельная организация должна быть пустой.",
    fields: [
      { key: "email", label: "Электронная почта сотрудника", type: "email", required: true },
      { key: "role", label: "Роль в этой компании", type: "select", required: true, options: rolesFor(state.member.role) },
      { key: "branch_id", label: "Филиал", type: "select", options: branchOptions },
    ],
    submitLabel: "Восстановить доступ",
    async onSubmit(values) {
      await state.repository.repairUser(values);
      closeModal();
      showToast("Аккаунт привязан к этой компании с выбранными правами. Попросите сотрудника войти заново.");
      await loadCurrentPage();
    },
  });
}

function showPopover(content, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = 245;
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const top = Math.min(rect.bottom + 8, Math.max(12, window.innerHeight - 230));
  popoverRoot.innerHTML = `<div class="popover-card" style="top:${top}px;left:${left}px">${content}</div>`;
}

function closePopover() {
  popoverRoot.innerHTML = "";
}

function applySearch() {
  const query = (pageContent.querySelector("#table-search")?.value || "").trim().toLowerCase();
  let visible = 0;
  pageContent.querySelectorAll(".workspace-row").forEach((row) => {
    const matchesSearch = !query || row.dataset.search.includes(query);
    const matchesStatus = state.currentFilter === "Все" || row.querySelector(".inline-status-select")?.value === state.currentFilter
      || row.querySelector(".status-pill")?.textContent.trim() === state.currentFilter;
    const matchesPayment = state.paymentFilter === "all"
      || (state.paymentFilter === "cash" && (Number(row.dataset.cashPaid || 0) > 0 || row.dataset.paymentMethod === "cash"))
      || (state.paymentFilter === "cashless" && (Number(row.dataset.cashlessPaid || 0) > 0 || row.dataset.paymentMethod === "cashless"))
      || (state.paymentFilter === "unpaid" && row.dataset.paymentMethod === "unpaid");
    row.hidden = !(matchesSearch && matchesStatus && matchesPayment);
    if (!row.hidden) visible += 1;
  });
  pageContent.querySelectorAll("#dashboard-orders tr").forEach((row) => {
    const matchesSearch = !query || row.dataset.search.includes(query);
    const matchesPayment = state.dashboardPayment === "all"
      || (state.dashboardPayment === "cash" && (Number(row.dataset.cashPaid || 0) > 0 || row.dataset.paymentMethod === "cash"))
      || (state.dashboardPayment === "cashless" && (Number(row.dataset.cashlessPaid || 0) > 0 || row.dataset.paymentMethod === "cashless"));
    row.hidden = !(matchesSearch && matchesPayment);
    if (!row.hidden) visible += 1;
  });
  const count = pageContent.querySelector("#visible-count");
  if (count) count.textContent = String(visible);
  const empty = pageContent.querySelector("#empty-state");
  if (empty) empty.hidden = visible !== 0;
  const dashboardEmpty = pageContent.querySelector("#dashboard-orders-empty");
  if (dashboardEmpty && pageContent.querySelector("#dashboard-orders")) {
    dashboardEmpty.hidden = [...pageContent.querySelectorAll("#dashboard-orders tr")].some((row) => !row.hidden);
  }
}

async function handleStatusChange(select, module) {
  const record = state.data[module]?.find((entry) => entry._record_id === select.dataset.statusId);
  if (!record) throw new Error("Обновите страницу: запись статуса не найдена.");
  const status = select.value;
  select.disabled = true;
  try {
    await state.repository.changeStatus(record, module, status);
    record.status = status;
    showToast(`Статус изменён: ${status}`);
    if (state.currentPage === "dashboard") await refreshDashboard();
  } catch (error) {
    console.error("Не удалось изменить статус записи.", error);
    showToast(error.message, "error");
    select.value = record.status;
  } finally {
    select.disabled = false;
  }
}

async function importCSV(file, module) {
  if (file.size > 5 * 1024 * 1024) {
    showToast("Размер CSV-файла не должен превышать 5 МБ.", "error");
    return;
  }
  try {
    const records = parseCSV(await file.text());
    const headers = records.shift()?.map((header) => header.trim().toLocaleLowerCase("ru-RU")) || [];
    const config = modules[module];
    const columns = config.columns.filter((column) =>
      headers.includes(column.key.toLocaleLowerCase("ru-RU"))
      || headers.includes(column.label.toLocaleLowerCase("ru-RU")),
    );
    const required = module === "orders"
      ? config.columns.find((column) => column.key === "customer")
      : config.columns[0];
    const hasRequired = headers.includes(required.key.toLocaleLowerCase("ru-RU"))
      || headers.includes(required.label.toLocaleLowerCase("ru-RU"));
    if (!records.length || !hasRequired) {
      throw new Error(`Добавьте заголовок обязательной колонки «${required.label}» и хотя бы одну строку данных.`);
    }
    if (module === "orders" && !columns.some((column) => column.key === "customer")) {
      throw new Error("Для каждого импортируемого заказа требуется имя клиента.");
    }
    const mapped = records.map((cells) => Object.fromEntries(columns.map((column) => {
      const header = [column.key.toLocaleLowerCase("ru-RU"), column.label.toLocaleLowerCase("ru-RU")];
      const index = headers.findIndex((candidate) => header.includes(candidate));
      return [column.key, (cells[index] || "").trim()];
    }))).filter((row) => Object.values(row).some(Boolean));
    if (mapped.length > 500) throw new Error("За один импорт можно добавить не более 500 записей.");

    const completed = await state.repository.importRecords(module, mapped, state.branchId);
    showToast(`В XVII Cloud добавлено записей: ${completed}`);
    await loadCurrentPage();
  } catch (error) {
    console.error("Не удалось импортировать записи CSV.", error);
    showToast(error.message, "error");
  }
}

function exportCSV() {
  const module = pageModules[state.currentPage];
  const config = modules[module];
  const rows = state.data[module] || [];
  const csv = serializeCSV(config.columns, rows);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `xvii-${module}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Экспортировано записей: ${rows.length}`);
}

function bindViewEvents() {
  const module = pageModules[state.currentPage];
  const localSearch = pageContent.querySelector("#table-search");
  localSearch?.addEventListener("input", applySearch);
  pageContent.querySelector("#table-import")?.addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file && module && state.repository.canImport(module)) await importCSV(file, module);
  });
  pageContent.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    state.currentFilter = button.dataset.filter;
    pageContent.querySelectorAll("[data-filter]").forEach((candidate) => candidate.classList.toggle("is-selected", candidate === button));
    applySearch();
  }));
  pageContent.querySelectorAll("[data-payment-filter]").forEach((button) => button.addEventListener("click", () => {
    state.paymentFilter = button.dataset.paymentFilter;
    pageContent.querySelectorAll("[data-payment-filter]").forEach((candidate) => candidate.classList.toggle("is-selected", candidate === button));
    applySearch();
  }));
  pageContent.querySelectorAll("[data-dashboard-payment]").forEach((button) => button.addEventListener("click", () => {
    state.dashboardPayment = button.dataset.dashboardPayment;
    pageContent.querySelectorAll("[data-dashboard-payment]").forEach((candidate) => candidate.classList.toggle("is-selected", candidate === button));
    applySearch();
  }));

  pageContent.querySelectorAll(".workspace-row").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button, select, a, input, label")) return;
      const record = state.data[module]?.find((item) => item._record_id === row.dataset.rowId);
      if (record) openRecordCard(record);
    });
  });
  pageContent.querySelectorAll("[data-row-menu]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const record = state.data[module]?.find((item) => item._record_id === button.closest("tr").dataset.rowId);
    if (record) showRecordActions(button, record, Number(button.dataset.rowMenu));
  }));
  pageContent.querySelectorAll(".inline-status-select").forEach((select) => select.addEventListener("change", () => void handleStatusChange(select, module)));
  pageContent.querySelectorAll(".table-sort-button").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.sortKey;
    state.sort = {
      module,
      key,
      direction: state.sort?.module === module && state.sort.key === key && state.sort.direction === "asc" ? "desc" : "asc",
    };
    renderPage();
  }));
  pageContent.querySelectorAll('[data-action="add-record"]').forEach((button) => button.addEventListener("click", () => newRecord()));
  pageContent.querySelectorAll('[data-action="add-order"]').forEach((button) => button.addEventListener("click", () => {
    navigate("orders");
    newRecord("orders");
  }));
  pageContent.querySelector('[data-action="add-sale"]')?.addEventListener("click", () => newRecord("sale"));
  pageContent.querySelector('[data-action="add-task"]')?.addEventListener("click", () => {
    navigate("tasks");
    window.setTimeout(newRecord, 0);
  });
  pageContent.querySelector('[data-action="add-branch"]')?.addEventListener("click", () => {
    newRecord("branches");
  });
  pageContent.querySelectorAll("[data-branch-edit]").forEach((button) => button.addEventListener("click", () => {
    const branch = state.branches.find((item) => item._record_id === button.dataset.branchEdit);
    if (branch) editRecord(branch, "branches");
  }));
  pageContent.querySelectorAll("[data-branch-delete]").forEach((button) => button.addEventListener("click", () => {
    const branch = state.branches.find((item) => item._record_id === button.dataset.branchDelete);
    if (branch) confirmRecordDelete(branch, "branches");
  }));
  pageContent.querySelector('[data-action="export"]')?.addEventListener("click", () => {
    if (module && state.repository.canExport(module)) exportCSV();
  });
  pageContent.querySelector('[data-action="import"]')?.addEventListener("click", () => pageContent.querySelector("#table-import")?.click());
  pageContent.querySelector('[data-action="retry"]')?.addEventListener("click", () => void loadCurrentPage());
  pageContent.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.page)));
  pageContent.querySelectorAll("[data-report]").forEach((button) => button.addEventListener("click", () => navigate("orders")));
  pageContent.querySelectorAll(".task-row input").forEach((checkbox) => checkbox.addEventListener("change", async () => {
    const task = state.dashboard?.tasks?.find((entry) => entry._record_id === checkbox.dataset.taskId);
    if (!task) return;
    try {
      await state.repository.changeStatus(task, "tasks", checkbox.checked ? "Готово" : "Новая");
      showToast(checkbox.checked ? "Задача завершена." : "Задача возвращена в работу.");
      state.dashboard = null;
      await refreshDashboard();
    } catch (error) {
      checkbox.checked = !checkbox.checked;
      showToast(error.message, "error");
    }
  }));
  pageContent.querySelectorAll("[data-dashboard-order-menu]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const order = state.dashboard?.orders?.[Number(button.dataset.dashboardOrderMenu)];
    if (order) showRecordActions(button, order, Number(button.dataset.dashboardOrderMenu), "dashboard");
  }));
  pageContent.querySelectorAll("#dashboard-orders tr").forEach((row) => row.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    const order = state.dashboard?.orders?.[Number(row.dataset.rowIndex)];
    if (order) openRecordCard(order);
  }));
  const chartTooltip = pageContent.querySelector("[data-chart-tooltip]");
  pageContent.querySelectorAll(".chart-day").forEach((day) => {
    const showTooltip = () => {
      if (!chartTooltip) return;
      chartTooltip.innerHTML = `<strong>${escapeHTML(day.dataset.chartDate)}</strong><span>Наличные <b>${money(Number(day.dataset.chartCash))}</b></span><span>Безналичные <b>${money(Number(day.dataset.chartCashless))}</b></span>${Number(day.dataset.chartOther) ? `<span>Другие <b>${money(Number(day.dataset.chartOther))}</b></span>` : ""}<span class="chart-tooltip-total">Итого <b>${money(Number(day.dataset.chartTotal))}</b></span><small>Платежей: ${escapeHTML(day.dataset.chartCount)}</small>`;
      chartTooltip.hidden = false;
      const wrap = chartTooltip.parentElement.getBoundingClientRect();
      const bounds = day.getBoundingClientRect();
      const left = Math.min(Math.max(0, bounds.left + bounds.width / 2 - wrap.left - 100), Math.max(0, wrap.width - 205));
      chartTooltip.style.left = `${left}px`;
    };
    day.addEventListener("mouseenter", showTooltip);
    day.addEventListener("focus", showTooltip);
    day.addEventListener("mouseleave", () => { if (document.activeElement !== day && chartTooltip) chartTooltip.hidden = true; });
    day.addEventListener("blur", () => { if (chartTooltip) chartTooltip.hidden = true; });
  });
  pageContent.querySelector("#chart-range")?.addEventListener("click", (event) => {
    const chartButton = event.currentTarget;
    showPopover(`<button data-range="7">Последние 7 дней</button><button data-range="30">Последние 30 дней</button><button data-range="90">Последние 90 дней</button>`, chartButton);
    popoverRoot.querySelectorAll("[data-range]").forEach((option) => option.addEventListener("click", () => {
      state.chartDays = Number(option.dataset.range);
      closePopover();
      void refreshDashboard();
    }));
  });
  bindTeamEvents();
}

function showUserActions(user, button) {
  const blocked = user.status === "blocked";
  showPopover(`<span class="popover-label">${escapeHTML(describeUser(user))}</span><button data-user-action="block">${icon(blocked ? "check-square" : "close")} ${blocked ? "Разблокировать доступ" : "Заблокировать доступ"}</button><button class="popover-danger" data-user-action="delete"><span class="danger-mark">×</span> Удалить пользователя навсегда</button>`, button);
  popoverRoot.querySelector('[data-user-action="block"]').addEventListener("click", async () => {
    closePopover();
    try {
      await state.repository.updateUser(user.user_id, blocked ? "unblock" : "block");
      showToast(blocked ? "Доступ пользователя восстановлен." : "Доступ пользователя заблокирован.");
      await loadCurrentPage();
    } catch (error) {
      console.error("Не удалось изменить права пользователя.", error);
      showToast(error.message, "error");
    }
  });
}

function bindTeamEvents() {
  pageContent.querySelectorAll("[data-user-menu]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const user = state.users.find((candidate) => candidate.user_id === button.dataset.userMenu);
    if (!user || user.role === "owner" || user.is_self) {
      showPopover(`<span class="popover-label">УЧЁТНАЯ ЗАПИСЬ</span><button disabled>${escapeHTML(describeUser(user || {}))} · владелец компании</button>`, button);
      return;
    }
    showUserActions(user, button);
    popoverRoot.querySelector('[data-user-action="delete"]').addEventListener("click", () => {
      closePopover();
      openModal({
        title: "Удалить учётную запись?",
        subtitle: `Удалить аккаунт ${describeUser(user)} и закрыть доступ к базе компании?`,
        fields: [{ key: "confirm", label: "Введите УДАЛИТЬ", required: true }],
        submitLabel: "Удалить пользователя",
        async onSubmit(values) {
          if (values.confirm !== "УДАЛИТЬ") throw new Error("Введите УДАЛИТЬ для подтверждения действия.");
          await state.repository.updateUser(user.user_id, "delete");
          closeModal();
          showToast("Пользователь и его учётная запись удалены.");
          await loadCurrentPage();
        },
      });
      modalRoot.querySelector(".button-primary")?.classList.add("button-danger");
    });
  }));
  pageContent.querySelector('[data-action="invite-user"]')?.addEventListener("click", renderTeamInvite);
  pageContent.querySelector('[data-action="repair-user"]')?.addEventListener("click", renderTeamRepair);
}

function showBranchMenu(anchor) {
  const canViewAll = state.repository.hasPermission("billing.manage") || !state.member.branch_id;
  const availableBranches = canViewAll
    ? state.branches
    : state.branches.filter((branch) => branch._record_id === state.member.branch_id);
  const options = [
    ...availableBranches.map((branch) => `<button data-branch-id="${escapeHTML(branch._record_id)}"><span class="branch-option-dot"></span>${escapeHTML(branch.branch || branch.name || "Филиал")}${state.branchId === branch._record_id ? " ✓" : ""}</button>`),
    ...(canViewAll ? [`<button data-branch-id="all"><span class="branch-option-dot branch-option-gray"></span>Все филиалы${state.branchId === "all" ? " ✓" : ""}</button>`] : []),
  ];
  showPopover(`<span class="popover-label">ФИЛИАЛЫ КОМПАНИИ</span>${options.join("") || "<p>Добавьте филиал в настройках компании.</p>"}`, anchor);
  popoverRoot.querySelectorAll("[data-branch-id]").forEach((button) => button.addEventListener("click", () => {
    state.branchId = button.dataset.branchId;
    state.dashboard = null;
    updateTaskIndicator();
    closePopover();
    updateBranchSwitcher();
    showToast(`Открыт филиал «${state.branchName}»`);
    void loadCurrentPage();
  }));
}

function showGlobalSearch(query = "") {
  const normalized = query.trim().toLocaleLowerCase("ru-RU");
  if (!normalized) {
    popoverRoot.innerHTML = `<div class="global-search-popover"><span class="popover-label">ПОИСК ПО ОБЩЕЙ БАЗЕ</span><button data-search-page="orders">${icon("clipboard")} Заказы <kbd>↵</kbd></button><button data-search-page="customers">${icon("users")} Клиенты <kbd>↵</kbd></button><button data-search-page="inventory">${icon("box")} Склад и товары <kbd>↵</kbd></button></div>`;
    return;
  }
  if (normalized.length < 2) return;
  clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(async () => {
    const requestNumber = ++state.searchNumber;
    popoverRoot.innerHTML = `<div class="global-search-popover"><span class="popover-label">ПОИСК ПО БАЗЕ XVII…</span><span class="search-no-results">Загружаем результаты из базы</span></div>`;
    try {
      const results = await state.repository.search(normalized, state.branchId);
      if (requestNumber !== state.searchNumber || searchInput.value.trim().toLocaleLowerCase("ru-RU") !== normalized) return;
      const content = results.map((row) => `
        <button class="search-result" data-search-module="${escapeHTML(row._module)}" data-search-id="${escapeHTML(row._record_id)}">
          <span class="search-result-icon">${icon("search")}</span><span><strong>${escapeHTML(row.number ? `Заказ № ${row.number}` : describeRecord(row))}</strong><small>${escapeHTML(pageLabels[row._module] || row._module)} · ${escapeHTML([row.customer, row.product, row.device, row.phone, row.sku].filter(Boolean).join(" · "))}</small></span>${icon("arrow-up-right")}
        </button>`).join("");
      popoverRoot.innerHTML = `<div class="global-search-popover"><span class="popover-label">НАЙДЕНО В XVII CLOUD · ${results.length}</span>${content || '<p class="search-no-results">Совпадений не найдено.</p>'}</div>`;
    } catch (error) {
      popoverRoot.innerHTML = `<div class="global-search-popover"><span class="popover-label">ПОИСК НЕ УДАЛСЯ</span><p class="search-no-results">${escapeHTML(error.message)}</p></div>`;
    }
  }, 250);
}

function bindTopLevelEvents() {
  themeToggle.addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    applyTheme(theme);
  });
  const accentColorInput = document.querySelector("#accent-color");
  accentColorInput.value = localStorage.getItem(ACCENT_STORAGE_KEY) || "#566cf2";
  accentColorInput.addEventListener("input", () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, accentColorInput.value);
    applyAccentColor(accentColorInput.value);
  });
  document.querySelectorAll(".nav-item[data-page], .brand[data-page]").forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    navigate(button.dataset.page);
  }));
  searchInput.addEventListener("focus", () => showGlobalSearch(searchInput.value));
  searchInput.addEventListener("input", () => showGlobalSearch(searchInput.value));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      popoverRoot.querySelector(".search-result")?.click();
    }
    if (event.key === "Escape") closePopover();
  });
  popoverRoot.addEventListener("click", (event) => {
    const result = event.target.closest("[data-search-module]");
    if (result) {
      const module = result.dataset.searchModule;
      const id = result.dataset.searchId;
      const route = Object.entries(pageModules).find(([, value]) => value === module)?.[0];
      if (!route) return;
      closePopover();
      navigate(route);
      window.setTimeout(async () => {
        let record = state.data[module]?.find((item) => item._record_id === id);
        if (!record) {
          await loadCurrentPage();
          record = state.data[module]?.find((item) => item._record_id === id);
        }
        if (record) openRecordCard(record);
      }, 0);
      return;
    }
    const page = event.target.closest("[data-search-page]")?.dataset.searchPage;
    if (page) {
      searchInput.value = "";
      closePopover();
      navigate(page);
    }
  });
  branchSwitch.addEventListener("click", (event) => {
    event.stopPropagation();
    if (popoverRoot.querySelector("[data-branch-id]")) closePopover();
    else showBranchMenu(event.currentTarget);
  });
  document.querySelector("#date-button").addEventListener("click", () => showToast(`Сегодня · ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(new Date())}`));
  document.querySelector("#profile-button").addEventListener("click", (event) => {
    showPopover(`<span class="popover-label">${escapeHTML(state.user?.email || "")}</span><button data-account-action="refresh">${icon("trend-up")} Обновить текущий раздел</button><button data-account-action="signout">${icon("close")} Выйти из XVII</button>`, event.currentTarget);
    popoverRoot.querySelector('[data-account-action="refresh"]').addEventListener("click", () => { closePopover(); void loadCurrentPage(); });
    popoverRoot.querySelector('[data-account-action="signout"]').addEventListener("click", async () => {
      closePopover();
      try {
        await state.client.signOut();
        state.user = null;
        state.member = null;
        state.repository = null;
        renderAuth("login", { message: "Вы вышли из XVII CRM." });
      } catch (error) {
        console.error("Не удалось закрыть сеанс XVII.", error);
        showToast(error.message, "error");
      }
    });
  });
  const mobileMenu = document.querySelector("#mobile-menu");
  const sidebar = document.querySelector("#sidebar");
  mobileMenu.addEventListener("click", () => {
    const isOpen = sidebar.classList.toggle("is-open");
    mobileMenu.setAttribute("aria-expanded", String(isOpen));
    mobileMenu.setAttribute("aria-label", isOpen ? "Закрыть меню" : "Открыть меню");
  });
  document.addEventListener("click", (event) => {
    if (window.matchMedia("(max-width: 820px)").matches
      && sidebar.classList.contains("is-open")
      && !sidebar.contains(event.target)
      && !mobileMenu.contains(event.target)) {
      sidebar.classList.remove("is-open");
      mobileMenu.setAttribute("aria-expanded", "false");
      mobileMenu.setAttribute("aria-label", "Открыть меню");
    }
    if (!event.target.closest("#popover-root, .global-search, #branch-switcher, #profile-button, #filter-button, #chart-range, [data-row-menu], [data-dashboard-order-menu], [data-user-menu]")) closePopover();
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      searchInput.focus();
    }
    if (event.key === "Escape") {
      closeModal();
      closePopover();
      sidebar.classList.remove("is-open");
      mobileMenu.setAttribute("aria-expanded", "false");
      mobileMenu.setAttribute("aria-label", "Открыть меню");
    }
    if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
      event.preventDefault();
      pageContent.querySelector("#table-search")?.focus();
    }
  });
}

bindTopLevelEvents();
document.querySelector("#current-date").textContent = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
}).format(new Date());
if (state.config) {
  state.client = new SupabaseClient(state.config);
  if (state.client.session?.access_token) {
    void startWorkspace();
  } else {
    renderAuth("login");
  }
} else {
  renderAuth("unconfigured");
}
