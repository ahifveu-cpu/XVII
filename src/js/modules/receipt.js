import { escapeHTML, icon } from "../components/icons.js";

const fields = [
  ["company_name", "Название сервисного центра", 160],
  ["company_phone", "Телефон", 80],
  ["address", "Адрес филиала", 240],
  ["receipt_title", "Заголовок квитанции", 160],
  ["intake_text", "Условия приёма", 800],
  ["appearance_text", "Внешний вид и комплектность", 800],
  ["diagnostics_text", "Диагностика и оценка работ", 800],
  ["warranty_text", "Гарантия на работы", 800],
  ["footer_text", "Подпись в конце квитанции", 800],
];

export function renderReceiptSettings(template) {
  return `
    <section class="panel receipt-settings-panel">
      <div class="panel-heading"><div><h2>Квитанция о приёме</h2><p>Настройте текст печатного талона. Изменения сохраняются для всех сотрудников компании.</p></div><span class="receipt-customisable">${icon("file")} Настраивается владельцем</span></div>
      <form id="receipt-form">
        <div class="receipt-fields">
          ${fields.map(([key, label, maxLength]) => `
            <label class="form-field">
              <span>${escapeHTML(label)}</span>
              ${maxLength > 240
                ? `<textarea name="${key}" maxlength="${maxLength}" rows="3">${escapeHTML(template[key] || "")}</textarea>`
                : `<input name="${key}" type="${key === "company_phone" ? "tel" : "text"}" maxlength="${maxLength}" value="${escapeHTML(template[key] || "")}" />`}
            </label>`).join("")}
          <label class="receipt-checkbox"><input type="checkbox" name="show_estimate" ${template.show_estimate ? "checked" : ""} /><span>Печатать предварительную оценку стоимости ремонта</span></label>
        </div>
        <div class="receipt-actions"><span>Для клиентов и бухгалтерии</span><button class="button button-primary" type="submit">${icon("check-square")} Сохранить шаблон</button></div>
      </form>
    </section>`;
}

export async function printReceipt(order, template) {
  const receiptWindow = window.open("", "_blank", "width=760,height=840");
  if (!receiptWindow) {
    throw new Error("Браузер заблокировал окно печати. Разрешите всплывающие окна для XVII и повторите попытку.");
  }

  const value = (key, fallback = "—") => escapeHTML(order[key] || fallback);
  const formatDate = new Date().toLocaleString("ru-RU");
  const printedAt = escapeHTML(formatDate);
  const receiptTitle = escapeHTML(template.receipt_title || "Квитанция о приёме техники");
  const company = escapeHTML(template.company_name || "XVII");
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  const formatMoney = (amount) => `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Number.isFinite(Number(amount)) ? Number(amount) : 0)} ₽`;
  const legacyItems = [order.service, order.product].filter(Boolean).map(String).join(", ");
  const itemizedReceipt = lineItems.length
    ? `<section class="notice"><strong>Услуги и товары по заказу</strong><table class="receipt-items"><thead><tr><th>Наименование</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>${lineItems.map((item) => {
      const quantity = Math.max(1, Number(item.quantity) || 1);
      const price = Math.max(0, Number(item.unit_price) || 0);
      const lineTotal = Number(item.line_total);
      return `<tr><td><strong>${escapeHTML(item.name || "Позиция")}</strong><small>${escapeHTML(item.kind || "")}</small></td><td>${quantity}</td><td>${formatMoney(price)}</td><td>${formatMoney(Number.isFinite(lineTotal) ? lineTotal : price * quantity)}</td></tr>`;
    }).join("")}</tbody><tfoot><tr><th colspan="3">К оплате за работы и товары</th><th>${formatMoney(order.amount)}</th></tr></tfoot></table></section>`
    : legacyItems
      ? `<section class="notice"><strong>Работы и товары</strong><p>${escapeHTML(legacyItems)}</p><p>Итого к оплате: <strong>${formatMoney(order.amount)}</strong></p></section>`
      : "";

  receiptWindow.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${receiptTitle} · ${value("number")}</title>
    <style>
      *{box-sizing:border-box}body{max-width:720px;margin:40px auto;padding:0 30px;color:#24283a;font:14px/1.55 "Segoe UI",Arial,sans-serif}
      h1{margin:0 0 3px;font-size:21px}h2{margin:24px 0 13px;font-size:17px}h3{font-size:12px}p{margin:5px 0}small,.subtle{color:#676c7b}
      .brand{padding-bottom:17px;border-bottom:1px solid #e7e8ec}.receipt-no{float:right;text-align:right}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px}.item{padding:8px 0;border-bottom:1px dashed #e4e5eb}
      .label{display:block;color:#747888;font-size:11px}.notice{margin-top:16px;padding:12px;border:1px solid #e5e6eb;border-radius:8px;font-size:12px}
      .receipt-items{width:100%;margin-top:12px;border-collapse:collapse;text-align:left;font-size:11px}.receipt-items th,.receipt-items td{padding:8px 6px;border-bottom:1px solid #e8e9ee}.receipt-items thead th{color:#686e7e;font-size:10px}.receipt-items td:first-child small{display:block;margin-top:2px}.receipt-items th:not(:first-child),.receipt-items td:not(:first-child){text-align:right;white-space:nowrap}.receipt-items tfoot th{padding-top:12px;border-bottom:0;color:#262b3b;font-size:12px}.receipt-items tfoot th:first-child{text-align:right}
      .signatures{display:grid;grid-template-columns:1fr 1fr;gap:38px;margin-top:47px}.signatures div{border-top:1px solid #555;padding-top:7px;color:#686c7a;font-size:10px}
      @media(max-width:540px){body{padding:0 16px;font-size:12px}.receipt-items{font-size:10px}.receipt-items th,.receipt-items td{padding:7px 3px}.receipt-items thead th{font-size:9px}}
      @media print{body{margin:10mm auto;padding:0}.no-print{display:none}.notice,.receipt-items tr{break-inside:avoid}}
    </style></head><body>
      <header class="brand"><div class="receipt-no"><span class="label">№ заказа</span><strong>${value("number")}</strong></div><h1>${company}</h1><div class="subtle">${escapeHTML(template.address || "")}${template.company_phone ? ` · ${escapeHTML(template.company_phone)}` : ""}</div></header>
      <h2>${receiptTitle}</h2><p class="subtle">Выдано ${printedAt}${order.due ? ` · Планируемый срок: ${value("due")}` : ""}</p>
      <div class="grid"><div class="item"><span class="label">Клиент</span><strong>${value("customer")}</strong></div><div class="item"><span class="label">Телефон</span><strong>${value("phone")}</strong></div><div class="item"><span class="label">Устройство и неисправность</span><strong>${value("device")}</strong></div><div class="item"><span class="label">Комплектность</span><strong>${value("appearance", "Уточнить при осмотре")}</strong></div></div>
      ${itemizedReceipt}
      <section class="notice">${escapeHTML(template.intake_text || "")}<p>${escapeHTML(template.appearance_text || "")}</p></section>
      <section class="notice"><strong>Диагностика и стоимость</strong><p>${escapeHTML(template.diagnostics_text || "")}</p>${template.show_estimate ? `<p>Предварительная оценка: <strong>${value("amount")}</strong>. Итоговая стоимость согласовывается с клиентом до начала работ.</p>` : ""}</section>
      <section class="notice"><strong>Гарантия</strong><p>${escapeHTML(template.warranty_text || "")}</p></section>
      ${template.footer_text ? `<p style="margin-top:17px;text-align:center">${escapeHTML(template.footer_text)}</p>` : ""}
      <div class="signatures"><div>Подпись клиента · ${value("customer")}</div><div>ФИО и подпись сотрудника</div></div>
      <button class="no-print" onclick="window.print()" style="margin-top:22px;padding:10px 18px;border:0;border-radius:7px;background:#566cf2;color:white;cursor:pointer">Печать / сохранить PDF</button>
      <script>window.addEventListener('load',()=>window.setTimeout(()=>window.print(),350))<\/script>
    </body></html>`);
  receiptWindow.document.close();
}
