import { escapeHTML, icon } from "../components/icons.js";
import { money } from "../services/crm-repository.js";

function orderStatus(status) {
  const styles = {
    "В работе": "status-blue",
    "Ожидает деталь": "status-amber",
    "Готов": "status-green",
    "Новый": "status-violet",
    "Выдан": "status-gray",
    "Закрыт": "status-green",
  };
  return `<span class="status-pill ${styles[status] || "status-gray"}"><span class="status-dot"></span>${escapeHTML(status || "Новый")}</span>`;
}

function dateWindow(days) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

function financeRecordDate(record) {
  const value = String(record.date || "");
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (isoDate) return new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
  const ruDate = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(value);
  if (ruDate) return new Date(Number(ruDate[3]), Number(ruDate[2]) - 1, Number(ruDate[1]));
  const createdAt = record._created_at ? new Date(record._created_at) : null;
  return createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null;
}

function renderChart(rows, days) {
  const { start, end } = dateWindow(days);
  const paymentBreakdown = rows
    .filter((row) => row.type === "Доход" && row._created_at)
    .reduce((daily, row) => {
      const transactionDate = financeRecordDate(row);
      if (!transactionDate || transactionDate < start || transactionDate > end) return daily;
      const key = transactionDate.toDateString();
      const payment = row.payment === "Наличные" || row.payment === "cash"
        ? "cash"
        : row.payment === "Безналичные" || row.payment === "cashless"
          ? "cashless"
          : "other";
      daily[key] ||= { cash: 0, cashless: 0, other: 0, count: 0 };
      daily[key][payment] += Number(row._total || 0);
      daily[key].count += 1;
      return daily;
    }, Object.create(null));
  const points = Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const totals = paymentBreakdown[date.toDateString()] || { cash: 0, cashless: 0, other: 0, count: 0 };
    return {
      date,
      ...totals,
      value: totals.cash + totals.cashless + totals.other,
    };
  });
  const max = Math.max(...points.map((point) => point.value), 1);
  const baseline = 178;
  const chartTop = 18;
  const chartWidth = 720;
  const chartHeight = baseline - chartTop;
  const step = chartWidth / points.length;
  const barWidth = Math.max(3, Math.min(34, step * 0.62));
  const ticks = [max, max * 2 / 3, max / 3, 0];
  const hasRevenue = points.some((point) => point.value > 0);
  const axisLabels = ticks.map((value) => {
    if (!hasRevenue) return "—";
    const formatted = new Intl.NumberFormat("ru-RU", {
      notation: value >= 1000 ? "compact" : "standard",
      maximumFractionDigits: 1,
    }).format(value);
    return `${escapeHTML(formatted)} ₽`;
  });
  const columns = points.map((point, index) => {
    const center = (index + .5) * step;
    const x = center - barWidth / 2;
    const heightFor = (value) => point.value ? value / max * (chartHeight - 8) : 0;
    const cashHeight = heightFor(point.cash);
    const cashlessHeight = heightFor(point.cashless);
    const otherHeight = heightFor(point.other);
    const dateLabel = point.date.toLocaleDateString("ru-RU", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const details = [
      dateLabel,
      `Наличные: ${money(point.cash)}`,
      `Безналичные: ${money(point.cashless)}`,
      ...(point.other ? [`Другие способы: ${money(point.other)}`] : []),
      `Итого: ${money(point.value)}`,
      `Платежей: ${point.count}`,
    ].join(" · ");
    const accessibleDetails = escapeHTML(details);
    const cashY = baseline - cashHeight;
    const cashlessY = cashY - cashlessHeight;
    const otherY = cashlessY - otherHeight;
    return `<g class="chart-day" tabindex="0" role="img" aria-label="${accessibleDetails}" data-chart-date="${escapeHTML(dateLabel)}" data-chart-cash="${point.cash}" data-chart-cashless="${point.cashless}" data-chart-other="${point.other}" data-chart-total="${point.value}" data-chart-count="${point.count}">
      <title>${accessibleDetails}</title>
      <rect class="chart-hit-area" x="${index * step}" y="${chartTop}" width="${step}" height="${baseline - chartTop}" />
      ${point.cash ? `<rect class="chart-bar chart-bar-cash" x="${x}" y="${cashY}" width="${barWidth}" height="${cashHeight}" rx="2" />` : ""}
      ${point.cashless ? `<rect class="chart-bar chart-bar-cashless" x="${x}" y="${cashlessY}" width="${barWidth}" height="${cashlessHeight}" rx="2" />` : ""}
      ${point.other ? `<rect class="chart-bar chart-bar-other" x="${x}" y="${otherY}" width="${barWidth}" height="${otherHeight}" rx="2" />` : ""}
      <rect class="chart-hover-column" x="${index * step}" y="${chartTop}" width="${step}" height="${baseline - chartTop}" />
    </g>`;
  }).join("");
  const labelIndexes = days <= 7
    ? points.map((_, index) => index)
    : [...new Set([0, Math.round((days - 1) / 3), Math.round((days - 1) * 2 / 3), days - 1])];
  const labels = labelIndexes
    .map((index) => `<span>${escapeHTML(points[index].date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }))}</span>`)
    .join("");
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const paymentCount = points.reduce((sum, point) => sum + point.count, 0);

  return {
    total,
    paymentCount,
    axisLabels,
    svg: `<svg class="revenue-chart" viewBox="0 0 ${chartWidth} 190" preserveAspectRatio="none" role="group" aria-label="Поступления по дням. Наведите курсор на столбец, чтобы увидеть сумму наличных и безналичных платежей.">
      <path class="chart-gridline" d="M0 18H720M0 71H720M0 124H720M0 178H720"/>
      ${columns}
      ${hasRevenue ? "" : '<text class="chart-empty-label" x="360" y="102" text-anchor="middle">Поступлений за этот период пока нет</text>'}
    </svg>`,
    labels,
    baseline: end,
  };
}

export function renderDashboard(data, {
  branchName = "Все филиалы",
  employeeName = "Сотрудник",
  chartDays = 7,
  canCreateBranch = false,
  canCreateOrder = false,
  canCreateSale = false,
  canCreateTask = false,
  canEditTask = false,
  canViewOrders = true,
  canViewTasks = true,
  canViewFinance = true,
  canViewInventory = true,
} = {}) {
  const orders = data.orders || [];
  const finance = data.finance || [];
  const customers = data.customers || [];
  const tasks = (data.tasks || []).filter((task) => task.status !== "Готово").slice(0, 4);
  const lowStock = (data.inventory || []).filter((item) => Number(item.stock_quantity) <= Number(item.min_stock || 0));
  const window = dateWindow(30);
  const monthlyRevenue = finance
    .filter((record) => {
      const transactionDate = financeRecordDate(record);
      return record.type === "Доход" && transactionDate && transactionDate >= window.start;
    })
    .reduce((sum, record) => sum + Number(record._total || 0), 0);
  const cashRevenue = finance
    .filter((record) => record.type === "Доход" && (record.payment === "Наличные" || record.payment === "cash"))
    .reduce((sum, record) => sum + Number(record._total || 0), 0);
  const cashlessRevenue = finance
    .filter((record) => record.type === "Доход" && (record.payment === "Безналичные" || record.payment === "cashless"))
    .reduce((sum, record) => sum + Number(record._total || 0), 0);
  const averageCheck = orders.length
    ? orders.reduce((sum, order) => sum + Number(order._total || 0), 0) / orders.length
    : 0;
  const { svg, total: chartTotal, labels, axisLabels, paymentCount } = renderChart(finance, chartDays);
  const cashLabel = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const currentDate = new Date().toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  if (!(data.branches || []).length) {
    return `
      <div class="page-heading dashboard-heading">
        <div>
          <div class="eyebrow"><span class="eyebrow-dot"></span> ${escapeHTML(currentDate).toLocaleUpperCase("ru-RU")}</div>
          <h1>Добро пожаловать, ${escapeHTML(employeeName)} <span class="wave">✦</span></h1>
          <p>Рабочее пространство XVII готово к настройке.</p>
        </div>
      </div>
      <section class="panel branch-welcome-panel">
        <span class="metric-icon metric-icon-violet">${icon("box")}</span>
        <h2>Сначала создайте филиал</h2>
        <p>Филиал нужен, чтобы привязывать к нему заказы, клиентов, склад и сотрудников. После создания здесь появятся показатели и рабочие данные.</p>
        ${canCreateBranch
          ? `<button class="button button-primary" data-action="add-branch">${icon("plus")} Создать первый филиал</button>`
          : `<p class="branch-welcome-hint">Попросите владельца компании выдать право на создание филиала.</p>`}
      </section>`;
  }
  const dailyCash = finance
    .filter((record) => record.type === "Доход" && (record.payment === "Наличные" || record.payment === "cash")
      && financeRecordDate(record)?.toDateString() === new Date().toDateString())
    .reduce((sum, record) => sum + Number(record._total || 0), 0);
  const dailyCashless = finance
    .filter((record) => record.type === "Доход" && (record.payment === "Безналичные" || record.payment === "cashless")
      && financeRecordDate(record)?.toDateString() === new Date().toDateString())
    .reduce((sum, record) => sum + Number(record._total || 0), 0);

  return `
    <div class="page-heading dashboard-heading">
      <div>
        <div class="eyebrow"><span class="eyebrow-dot"></span> ${escapeHTML(currentDate).toLocaleUpperCase("ru-RU")} · ${escapeHTML(branchName)}</div>
        <h1>Добро пожаловать, ${escapeHTML(employeeName)} <span class="wave">✦</span></h1>
        <p>Актуальные заказы, оплаты и задачи из общей базы компании.</p>
      </div>
      <div class="heading-actions dashboard-actions">
        ${canCreateSale ? `<button class="button button-secondary" data-action="add-sale">${icon("plus")} Продажа</button>` : ""}
        ${canCreateOrder ? `<button class="button button-primary" data-action="add-order">${icon("plus")} Новый заказ</button>` : ""}
      </div>
    </div>

    <div class="metric-grid">
      <article class="metric-card"><div class="metric-top"><span>Поступления за месяц</span><span class="metric-icon metric-icon-blue">${icon("wallet")}</span></div><strong class="metric-value">${money(monthlyRevenue)}</strong><div class="metric-foot"><span>${finance.filter((entry) => entry.type === "Доход").length} записей</span><span>из базы XVII Cloud</span></div></article>
      <article class="metric-card"><div class="metric-top"><span>Заказы</span><span class="metric-icon metric-icon-violet">${icon("clipboard")}</span></div><strong class="metric-value">${orders.length}<span class="metric-unit">записей</span></strong><div class="metric-foot"><span>${orders.filter((order) => ["Новый", "В работе", "Ожидает деталь"].includes(order.status)).length} активных</span><span>в выбранном филиале</span></div></article>
      <article class="metric-card"><div class="metric-top"><span>Клиентская база</span><span class="metric-icon metric-icon-green">${icon("users")}</span></div><strong class="metric-value">${customers.length}<span class="metric-unit">клиентов</span></strong><div class="metric-foot"><span>Общая база</span><span>этой компании</span></div></article>
      <article class="metric-card"><div class="metric-top"><span>Средний чек заказа</span><span class="metric-icon metric-icon-amber">${icon("trend-up")}</span></div><strong class="metric-value">${money(averageCheck)}</strong><div class="metric-foot"><span>По ${orders.length} заказам</span><span>в выбранном филиале</span></div></article>
    </div>

    <div class="payment-summary-cards">
      <div class="payment-summary-card"><span class="payment-summary-icon cash-summary">${icon("wallet")}</span><span class="payment-summary-label">Наличные · поступления</span><strong>${escapeHTML(cashLabel.format(cashRevenue))} ₽</strong></div>
      <div class="payment-summary-card"><span class="payment-summary-icon cashless-summary">${icon("wallet")}</span><span class="payment-summary-label">Безналичные · поступления</span><strong>${escapeHTML(cashLabel.format(cashlessRevenue))} ₽</strong></div>
      <div class="payment-summary-card"><span class="payment-summary-icon cash-summary">${icon("check-square")}</span><span class="payment-summary-label">Наличные · сегодня</span><strong>${escapeHTML(cashLabel.format(dailyCash))} ₽</strong></div>
      <div class="payment-summary-card"><span class="payment-summary-icon cashless-summary">${icon("check-square")}</span><span class="payment-summary-label">Безналичные · сегодня</span><strong>${escapeHTML(cashLabel.format(dailyCashless))} ₽</strong></div>
    </div>

    <div class="dashboard-grid">
      ${canViewFinance ? `<section class="panel revenue-panel">
        <div class="panel-heading"><div><h2>Поступления</h2><p>Сумма оплат по дням и способам · наведите на столбец для деталей</p></div><button class="select-button" id="chart-range" type="button">Последние ${chartDays} дней ${icon("chevron-down")}</button></div>
        <div class="chart-summary"><strong>${money(chartTotal)}</strong><span class="chart-summary-note">${paymentCount} платежей за ${chartDays} дн.</span></div>
        <div class="chart-legend"><span><i class="chart-legend-cash"></i> Наличные</span><span><i class="chart-legend-cashless"></i> Безналичные</span><span><i class="chart-legend-other"></i> Другие</span></div>
        <div class="chart-wrap"><div class="chart-y-labels">${axisLabels.map((label) => `<span>${label}</span>`).join("")}</div>${svg}<div class="chart-x-labels">${labels}</div><div class="chart-tooltip" data-chart-tooltip role="status" hidden></div></div>
      </section>` : ""}

      ${canViewTasks && tasks.length ? `<section class="panel tasks-panel">
        <div class="panel-heading"><div><h2>Открытые задачи <span class="heading-count">${tasks.length}</span></h2><p>Незавершённые поручения команды</p></div><button class="text-link" data-page="tasks">Все задачи ${icon("arrow-up-right")}</button></div>
        <div class="task-list">${tasks.length ? tasks.map((task) => `<label class="task-row">${canEditTask ? `<input type="checkbox" data-task-id="${escapeHTML(task._record_id || "")}" /><span class="task-check"></span>` : ""}<span class="task-content"><strong>${escapeHTML(task.task || "Задача без названия")}</strong><small>${icon("clock")} ${escapeHTML(task.due || "Без срока")} · ${escapeHTML(task.assignee || "Не назначен")}</small></span><span class="task-priority ${task.priority === "Высокий" ? "priority-high" : task.priority === "Низкий" ? "priority-low" : "priority-normal"}"></span></label>`).join("") : `<div class="panel-empty">Нет открытых задач. Добавьте поручение для команды.</div>`}</div>
        ${canCreateTask ? `<button class="add-task-link" data-action="add-task">${icon("plus")} Добавить задачу</button>` : ""}
      </section>` : ""}

      ${canViewOrders ? `<section class="panel orders-panel">
        <div class="panel-heading"><div><h2>Последние заказы</h2><p>Автоматический сквозной нумератор · от № 1</p></div><button class="text-link" data-page="orders">Все заказы ${icon("arrow-up-right")}</button></div>
        <div class="table-toolbar dashboard-order-toolbar"><div class="filter-tabs"><button class="filter-tab is-selected" data-dashboard-payment="all">Все оплаты</button><button class="filter-tab" data-dashboard-payment="cash">Наличные</button><button class="filter-tab" data-dashboard-payment="cashless">Безналичные</button><button class="filter-tab" data-dashboard-payment="unpaid">Не оплачено</button></div></div>
        <div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>ЗАКАЗ · КЛИЕНТ</th><th>УСТРОЙСТВО</th><th>СТАТУС</th><th>ОПЛАТА</th><th>СУММА</th><th></th></tr></thead>
          <tbody id="dashboard-orders">${orders.slice(0, 10).map((order, index) => renderOrderRow(order, index)).join("")}</tbody>
        </table><div class="empty-state" id="dashboard-orders-empty" ${orders.length ? "hidden" : ""}>${icon("clipboard")}<strong>Заказов пока нет</strong><p>Создайте первый заказ — его номер система присвоит автоматически.</p>${canCreateOrder ? `<button class="button button-primary" data-action="add-order">${icon("plus")} Новый заказ</button>` : ""}</div></div>
      </section>` : ""}

      ${canViewFinance ? `<section class="panel tasks-panel">
        <div class="panel-heading"><div><h2>Движение денег</h2><p>${finance.length} записей за выбранный филиал</p></div><button class="text-link" data-page="finance">Все операции ${icon("arrow-up-right")}</button></div>
        <div class="money-summary-row"><span>Наличный расчёт</span><strong>${money(cashRevenue)}</strong></div>
        <div class="money-summary-row"><span>Безналичный расчёт</span><strong>${money(cashlessRevenue)}</strong></div>
        <div class="money-summary-row"><span>Платежей получено</span><strong>${finance.filter((item) => item.type === "Доход").length}</strong></div>
      </section>` : ""}

      ${canViewInventory ? `<section class="panel inventory-panel">
        <div class="panel-heading"><div><h2>Минимальные остатки</h2><p>${lowStock.length} товарных позиций требуют внимания</p></div><button class="text-link" data-page="inventory">Управление складом ${icon("arrow-up-right")}</button></div>
        <div class="stock-list">${lowStock.length ? lowStock.slice(0, 5).map((item) => `<div class="stock-row"><span class="stock-product-mark mark-amber">${icon("box")}</span><span class="stock-product"><strong>${escapeHTML(item.name || "Без названия")}</strong><small>${escapeHTML(item.sku || "Артикул не указан")} · минимум ${escapeHTML(item.min_stock || "0")}</small></span><span class="stock-level stock-critical"><strong>${escapeHTML(item.stock_quantity || "0")} ${escapeHTML(item.unit || "шт.")}</strong></span></div>`).join("") : `<div class="panel-empty">Все товары пополнены или норматив остатков ещё не задан.</div>`}</div>
      </section>` : ""}
    </div>`;
}

function renderOrderRow(order, index) {
  const method = order.payment_method;
  const cash = Number(order.cash_paid_total || 0);
  const cashless = Number(order.cashless_paid_total || 0);
  const isPaid = Number(order.paid_amount || 0) >= Number(order.amount || 0) && Number(order.amount || 0) > 0;
  const filterMethod = cash > 0 && cashless > 0 ? "split" : cash > 0 ? "cash" : cashless > 0 ? "cashless" : "unpaid";
  const paymentSummary = cash > 0 || cashless > 0
    ? [cash > 0 ? `Нал. ${money(cash)}` : "", cashless > 0 ? `Безнал. ${money(cashless)}` : ""].filter(Boolean).join(" · ")
    : "Не оплачено";
  const summary = `${isPaid ? "Оплачен" : Number(order.paid_amount || 0) > 0 ? "Предоплата" : "Не оплачено"}${cash || cashless ? ` · ${paymentSummary}` : ""}`;
  return `<tr class="clickable-row" data-order="${escapeHTML(order._record_id || "")}" data-row-index="${index}" data-search="${escapeHTML(Object.entries(order).filter(([field]) => !field.startsWith("_")).map(([, value]) => value || "").join(" ").toLowerCase())}" data-payment-method="${escapeHTML(filterMethod)}" data-cash-paid="${cash}" data-cashless-paid="${cashless}">
    <td><div class="identity-cell"><span class="avatar avatar-blue">${escapeHTML((order.customer || "?").split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase())}</span><span><strong>№ ${escapeHTML(order.number || "")} · ${escapeHTML(order.customer || "Без клиента")}</strong><small>${escapeHTML(order.phone || "Телефон не указан")}</small></span></div></td>
    <td>${escapeHTML(order.device || "—")}</td><td>${orderStatus(order.status)}</td><td><span class="status-pill ${cash > 0 && cashless > 0 ? "status-violet" : method === "cash" ? "status-green" : method === "cashless" ? "status-blue" : "status-gray"}"><span class="status-dot"></span>${escapeHTML(summary)}</span></td><td class="amount-cell">${money(Number(order.amount || 0))}</td>
    <td><button class="icon-button row-menu" type="button" data-dashboard-order-menu="${index}" aria-label="Действия с заказом">${icon("more")}</button></td></tr>`;
}
