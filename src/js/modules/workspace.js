import { escapeHTML, icon } from "../components/icons.js";

const statusClasses = {
  "В работе": "status-blue",
  "Ожидает деталь": "status-amber",
  "Готов": "status-green",
  "Выдан": "status-gray",
  "Новый": "status-violet",
  "Не оплачено": "status-gray",
  "Оплачен частично": "status-amber",
  "Оплачен": "status-green",
  "Новая": "status-violet",
  "Готово": "status-green",
  "Активна": "status-green",
  "Активен": "status-green",
  "Пауза": "status-amber",
  "На смене": "status-green",
  "Выходной": "status-gray",
  "Подтверждена": "status-green",
  "Ожидает ответа": "status-amber",
  "Отправлено": "status-gray",
  "Не прочитано": "status-blue",
  "Требует настройки": "status-amber",
  "Настроено": "status-green",
  "Готово к работе": "status-blue",
  "Высокий": "status-red",
  "Обычный": "status-gray",
  "Низкий": "status-green",
  "Открыт": "status-green",
  "Закрыт": "status-gray",
  "Обработан": "status-green",
  "Передан на площадку": "status-blue",
  "Доход": "status-green",
  "Расход": "status-red",
};

function displayValue(value, key, row) {
  if (key === "customer" || key === "employee" || key === "name" || key === "document") {
    const initials = value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    return `<div class="identity-cell"><span class="avatar avatar-blue">${escapeHTML(initials)}</span><span><strong>${escapeHTML(value)}</strong>${row.phone ? `<small>${escapeHTML(row.phone)}</small>` : ""}</span></div>`;
  }
  if (key === "assignee") {
    const initials = value === "Не назначен" ? "—" : value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    return `<div class="assignee-cell"><span class="avatar ${value === "Не назначен" ? "avatar-gray" : "avatar-green"}">${escapeHTML(initials)}</span>${escapeHTML(value)}</div>`;
  }
  if (key === "number") return `<span class="order-number">${escapeHTML(value)}</span>`;
  if (key === "payment_method" || key === "payment") {
    const method = row.payment_method || (row.payment === "Наличные" ? "cash" : row.payment === "Безналичные" ? "cashless" : "");
    if (key === "payment_method" && Number(row.cash_paid_total || 0) > 0 && Number(row.cashless_paid_total || 0) > 0) {
      return `<span class="status-pill status-violet"><span class="status-dot"></span>Наличные + безналичные</span>`;
    }
    if (!method) return `<span class="status-pill status-gray"><span class="status-dot"></span>${row.payment_status === "Оплачен" ? "Оплата проведена" : "Не оплачено"}</span>`;
    const label = method === "cash" ? "Наличные" : method === "cashless" ? "Безналичные" : value;
    return `<span class="status-pill ${method === "cash" ? "status-green" : "status-blue"}"><span class="status-dot"></span>${escapeHTML(label)}</span>`;
  }
  if (key === "status" || key === "type" || key === "priority" || key === "payment_status") {
    const statusClass = value === "Закрыт" && row?._module === "orders"
      ? "status-green"
      : statusClasses[value] || "status-gray";
    return `<span class="status-pill ${statusClass}"><span class="status-dot"></span>${escapeHTML(value)}</span>`;
  }
  if (key === "amount" && value.startsWith("+")) return `<span class="amount-positive">${escapeHTML(value)}</span>`;
  if (key === "amount" && value.startsWith("−")) return `<span class="amount-negative">${escapeHTML(value)}</span>`;
  if (["amount", "paid_amount", "cash_paid_total", "cashless_paid_total", "price", "cost", "cost_amount", "cost_price", "profit_amount"].includes(key) && value !== "—") {
    const numeric = Number(String(value).replace(/[^\d.-]/g, ""));
    if (Number.isFinite(numeric)) {
      const formatted = `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Math.abs(numeric))} ₽`;
      if (key === "profit_amount" && numeric < 0) return `<span class="amount-negative">−${formatted}</span>`;
      return key === "profit_amount" ? `<span class="amount-positive">${formatted}</span>` : formatted;
    }
  }
  return escapeHTML(value);
}

function metricValue(value) {
  return escapeHTML(value instanceof Intl.NumberFormat ? value.toString() : value);
}

function money(value) {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value || 0)} ₽`;
}

export function metricsFor(key, rows) {
  const count = rows.length;
  const currency = (value) => money(value);
  const values = {
    orders: [
      ["Заказы", String(count), "blue"],
      ["В работе", String(rows.filter((row) => row.status === "В работе").length), "amber"],
      ["Учтённая прибыль", currency(rows.reduce((sum, row) => sum + Number(row.profit_amount || 0), 0)), "green"],
      ["Цена клиентам", currency(rows.reduce((sum, row) => sum + Number(row._total || 0), 0)), "violet"],
    ],
    customers: [["Клиенты", String(count), "blue"], ["С телефонами", String(rows.filter((row) => row.phone).length), "green"], ["С почтой", String(rows.filter((row) => row.email).length), "violet"], ["Источник", "Общая база", "amber"]],
    inventory: [
      ["Позиций на складе", String(count), "blue"],
      ["Низкий остаток", String(rows.filter((row) => Number(row.stock_quantity) <= Number(row.min_stock || 0)).length), "amber"],
      ["Себестоимость остатков", currency(rows.reduce((sum, row) => sum + Number(row.stock_quantity || 0) * Number(row.cost_price || 0), 0)), "violet"],
      ["Запчасти и товары", String(rows.filter((row) => Number(row.stock_quantity) > Number(row.min_stock || 0)).length), "green"],
    ],
    services: [["Услуги в прайсе", String(count), "blue"], ["Средняя цена", currency(count ? rows.reduce((sum, row) => sum + Number(row.price || row._total || 0), 0) / count : 0), "violet"], ["Ожидаемая прибыль", currency(rows.reduce((sum, row) => sum + Number(row.profit_amount || 0), 0)), "green"], ["Активные", String(rows.filter((row) => row.status === "Активна").length), "amber"]],
    finance: [
      ["Выручка (безналичные)", currency(rows.filter((row) => row.type === "Доход" && (row.payment === "Безналичные" || row.payment === "cashless")).reduce((sum, row) => sum + Number(row._total || 0), 0)), "blue"],
      ["Выручка (наличные)", currency(rows.filter((row) => row.type === "Доход" && (row.payment === "Наличные" || row.payment === "cash")).reduce((sum, row) => sum + Number(row._total || 0), 0)), "green"],
      ["Расходы", currency(rows.filter((row) => row.type === "Расход").reduce((sum, row) => sum + Number(row._total || 0), 0)), "amber"],
      ["Операций", String(count), "violet"],
    ],
    reports: [["Заказы", String(count), "blue"], ["В работе", String(rows.filter((row) => row.status === "В работе").length), "green"], ["Готовы", String(rows.filter((row) => row.status === "Готов").length), "violet"], ["Оплачено", currency(rows.reduce((sum, row) => sum + Number(row._paid_total || 0), 0)), "amber"]],
    tasks: [["Задач", String(count), "blue"], ["Новые", String(rows.filter((row) => row.status === "Новая").length), "amber"], ["В работе", String(rows.filter((row) => row.status === "В работе").length), "violet"], ["Выполнено", String(rows.filter((row) => row.status === "Готово").length), "green"]],
    team: [["Сотрудников", String(count), "blue"], ["Активных", String(rows.filter((row) => row.status === "active").length), "green"], ["Заблокированы", String(rows.filter((row) => row.status === "blocked").length), "amber"], ["Роли", "Настраиваются", "violet"]],
    branches: [["Филиалы", String(count), "blue"], ["Открыты", String(rows.filter((row) => row.status === "Открыт").length), "green"], ["Закрыты", String(rows.filter((row) => row.status === "Закрыт").length), "amber"], ["Филиал по умолчанию", "Настраивается", "violet"]],
    calendar: [["Записей", String(count), "blue"], ["Подтверждены", String(rows.filter((row) => row.status === "Подтверждена").length), "green"], ["Ожидают ответа", String(rows.filter((row) => row.status === "Ожидает ответа").length), "amber"], ["Специалистов", String(new Set(rows.map((row) => row.assignee).filter(Boolean)).size), "violet"]],
    documents: [["Документов", String(count), "blue"], ["Квитанции", String(rows.filter((row) => row.type === "Квитанция").length), "violet"], ["Гарантии", String(rows.filter((row) => row.type === "Гарантия").length), "green"], ["За период", "Все записи", "amber"]],
    automation: [["Сценариев", String(count), "green"], ["Включены", String(rows.filter((row) => row.status === "Активен").length), "blue"], ["На паузе", String(rows.filter((row) => row.status === "Пауза").length), "violet"], ["Новые", String(rows.filter((row) => row.status === "Новый").length), "amber"]],
  };
  return values[key] || [];
}

function renderMetric([label, value, color]) {
  return `<article class="mini-metric"><span class="mini-metric-dot dot-${color}"></span><span class="mini-metric-label">${escapeHTML(label)}</span><strong>${metricValue(value)}</strong></article>`;
}

function titleForRow(row, key) {
  return row.number || row.customer || row.employee || row.task || row.product || row.service || row.operation || row.report || row.document || row.automation || row.setting || row.time || row.branch || row.name || Object.values(row)[0] || key;
}

export function renderWorkspace(key, config, data, access = {}) {
  const rows = (data[key] || config).rows;
  const metrics = metricsFor(key, rows);
  const isOrders = key === "orders";
  const filters = isOrders
    ? `<div class="filter-tabs">
        ${[["Все", rows.length], ...[...new Set(rows.map((row) => row.status).filter(Boolean))].map((status) => [status, rows.filter((row) => row.status === status).length])].map(([status, count]) => `<button class="filter-tab ${status === "Все" ? "is-selected" : ""}" data-filter="${escapeHTML(status)}">${escapeHTML(status === "Все" ? "Все" : status)} <span>${count}</span></button>`).join("")}
        <span class="filter-divider"></span><button class="filter-tab payment-filter-tab is-selected" data-payment-filter="all">Все оплаты</button><button class="filter-tab payment-filter-tab" data-payment-filter="cash">Наличные</button><button class="filter-tab payment-filter-tab" data-payment-filter="cashless">Безналичные</button><button class="filter-tab payment-filter-tab" data-payment-filter="unpaid">Не оплачено</button>
      </div>`
    : key === "finance"
      ? `<div class="filter-tabs"><button class="filter-tab payment-filter-tab is-selected" data-payment-filter="all">Все оплаты</button><button class="filter-tab payment-filter-tab" data-payment-filter="cash">Наличные</button><button class="filter-tab payment-filter-tab" data-payment-filter="cashless">Безналичные</button></div>`
      : "";
  const reportCards = key === "reports"
    ? `<div class="report-shortcuts">${[["trend-up","Продажи и выручка","План-факт, прибыль и динамика","blue"],["users","Клиенты","Новые, повторные и отток","violet"],["users","Команда","Загрузка и эффективность","green"],["box","Склад","Остатки и оборачиваемость","amber"]].map(([symbol,title,description,color])=>`<button class="report-shortcut" data-report="${title}"><span class="report-icon report-${color}">${icon(symbol)}</span><span><strong>${title}</strong><small>${description}</small></span>${icon("chevron-right")}</button>`).join("")}</div>`
    : "";
  const inventoryNotice = key === "inventory"
    ? (() => {
      const lowStock = rows.filter((row) => row.min_stock && Number(row.stock_quantity) <= Number(row.min_stock));
      return lowStock.length ? `<div class="notice-banner">${icon("box")}<span><strong>${lowStock.length} товаров заканчиваются.</strong> Проверьте минимальные остатки и запланируйте закупку.</span><span>${escapeHTML(lowStock.map((row) => row.name).join(", "))}</span></div>` : "";
    })()
    : "";
  const emptyMessage = "Ничего не найдено. Попробуйте изменить запрос.";
  return `
    <div class="page-heading workspace-heading">
      <div>      <div class="eyebrow"><span class="eyebrow-dot"></span> СЕРВИСНЫЙ ЦЕНТР · ${escapeHTML(data.branchName || "ОБЩАЯ БАЗА")}</div><h1>${escapeHTML(config.pageTitle || keyTitle(key))}</h1><p>${escapeHTML(config.subtitle)}</p></div>
      <div class="heading-actions">${access.canExport && key !== "settings" && key !== "reports" ? `<button class="button button-secondary export-button" data-action="export">${icon("download")} Экспорт</button>` : ""}${access.canCreate ? `<button class="button button-primary" data-action="add-record">${icon("plus")} ${config.addLabel}</button>` : ""}</div>
    </div>
    <div class="mini-metric-grid">${metrics.map(renderMetric).join("")}</div>
    ${reportCards}
    ${inventoryNotice}
    <section class="panel table-panel">
      <div class="table-toolbar">
        ${filters}
        <div class="table-tools">
              ${access.canImport && ["orders", "customers", "inventory", "services"].includes(key) ? `<button class="button button-secondary import-button" data-action="import" type="button">${icon("file")} Импорт CSV</button><input id="table-import" class="import-file" type="file" accept=".csv,text/csv" hidden />` : ""}
          <label class="table-search">${icon("search")}<input id="table-search" type="search" placeholder="${config.searchPlaceholder || "Поиск..."}" /><kbd>/</kbd></label>
          <button class="button button-secondary filter-button" id="filter-button" type="button">${icon("filter")} Фильтр</button>
        </div>
      </div>
      <div class="table-scroll"><table class="data-table workspace-table"><thead><tr>${config.columns.map((column) => `<th><button class="table-sort-button" type="button" data-sort-key="${escapeHTML(column.key)}">${escapeHTML(column.label)}${icon("chevron-down")}</button></th>`).join("")}<th class="row-menu-head"></th></tr></thead><tbody id="table-body">${renderRows(rows, config, key, access)}</tbody></table><div class="empty-state" id="empty-state" ${rows.length ? "hidden" : ""}>${icon(rows.length ? "search" : "clipboard")}<strong>${rows.length ? "Ничего не найдено" : "Записей пока нет"}</strong><p>${rows.length ? emptyMessage : "Записей пока нет или доступна только их просмотр."}</p></div></div>
      <div class="table-footer"><span>Показано <strong id="visible-count">${rows.length}</strong> из ${rows.length} записей</span><div class="pagination"><button type="button" disabled aria-label="Предыдущая страница">${icon("chevron-right")}</button><button class="page-number is-current" type="button" aria-current="page">1</button><button type="button" disabled aria-label="Следующая страница">${icon("chevron-right")}</button></div></div>
    </section>`;
}

function renderRows(rows, config, key, access) {
  if (!rows.length) return "";
  return rows.map((row, index) => {
    const name = titleForRow(row, key);
    const paymentMethod = row.cash_paid_total > 0 && row.cashless_paid_total > 0
      ? "split"
      : row.cash_paid_total > 0 ? "cash" : row.cashless_paid_total > 0 ? "cashless"
        : row.payment_method || (row.payment === "Наличные" ? "cash" : row.payment === "Безналичные" ? "cashless" : "");
    const paymentFilter = paymentMethod || (Number(row.amount || 0) > Number(row.paid_amount || 0) ? "unpaid" : "");
    return `<tr class="workspace-row" data-row-id="${escapeHTML(row._record_id || "")}" data-row-index="${index}" data-payment-method="${escapeHTML(paymentFilter)}" data-cash-paid="${Number(row.cash_paid_total || 0)}" data-cashless-paid="${Number(row.cashless_paid_total || 0)}" data-search="${escapeHTML(Object.entries(row).filter(([field]) => !field.startsWith("_")).map(([, value]) => value || "").join(" ").toLowerCase())    }">${config.columns.map((column) => `<td>${column.key === "status" ? renderStatusSelect(valueForRow(row, column.key), key, index, row._record_id, row, access.canEdit) : displayValue(row[column.key] ?? "—", column.key, row)}</td>`).join("")}<td><button class="icon-button row-menu" type="button" data-row-menu="${index}" aria-label="Действия с записью">${icon("more")}</button></td></tr>`;
  }).join("");
}

function valueForRow(row, key) {
  return row[key] || "Новый";
}

function renderStatusSelect(value, module, index, recordId, row, canEdit) {
  const options = {
    orders: ["Новый", "В работе", "Ожидает деталь", "Готов", "Выдан", "Закрыт"],
    tasks: ["Новая", "В работе", "Готово"],
    calendar: ["Подтверждена", "Ожидает ответа", "Отменена"],
    services: ["Активна", "Пауза"],
    branches: ["Открыт", "Закрыт"],
    automation: ["Активен", "Пауза"],
  }[module] || [];
  const statusClass = module === "orders" && value === "Закрыт"
    ? "status-green"
    : statusClasses[value] || "status-gray";
  if (!options.length) return `<span class="status-pill ${statusClass}"><span class="status-dot"></span>${escapeHTML(value)}</span>`;
  if (!canEdit) return `<span class="status-pill ${statusClass}"><span class="status-dot"></span>${escapeHTML(value)}</span>`;
  const isUnpaid = module === "orders" && Number(row?.paid_amount || 0) < Number(row?.amount || 0);
  return `<label class="inline-status-wrap"><span class="status-pill ${statusClass}"><span class="status-dot"></span>${escapeHTML(value)}</span><select class="inline-status-select" data-status-index="${index}" data-status-id="${escapeHTML(recordId || "")}" aria-label="Изменить статус: ${escapeHTML(value)}">${options.map((option) => `<option value="${escapeHTML(option)}" ${option === value ? "selected" : ""} ${isUnpaid && ["Выдан", "Закрыт"].includes(option) && option !== value ? "disabled" : ""}>${escapeHTML(option)}</option>`).join("")}</select></label>`;
}

export function renderLoading(page, branchName) {
  return `<section class="loading-workspace" aria-live="polite"><span class="loading-spinner"></span><strong>Подключаем данные XVII Cloud</strong><p>${escapeHTML(page)} · ${escapeHTML(branchName)}</p></section>`;
}

export function renderWorkspaceError(error) {
  return `<section class="connection-error" role="alert"><span class="report-icon report-amber">${icon("settings")}</span><h2>Не удалось загрузить данные</h2><p>${escapeHTML(error)}</p><button class="button button-primary" data-action="retry">${icon("trend-up")} Повторить подключение</button></section>`;
}

function keyTitle(key) {
  const titles = {
    orders: "Заказы", customers: "Клиенты", tasks: "Задачи", calendar: "Запись и календарь",
    inventory: "Склад и товары", services: "Услуги и прайс", finance: "Финансы",
    reports: "Отчёты и аналитика", team: "Команда и зарплаты", branches: "Филиалы и кассы",
    documents: "Документы", automation: "Автоматизация",
  };
  return titles[key] || "Рабочее пространство";
}
