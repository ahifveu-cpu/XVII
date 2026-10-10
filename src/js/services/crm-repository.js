const ACTIVE_MODULES = [
  "orders", "customers", "tasks", "calendar", "inventory", "services",
  "finance", "reports", "team", "branches", "documents", "automation",
];

function encodeFilterValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normaliseNumber(value, fallback = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const normalized = String(value || "").replace(/\s/g, "").replace(/,/g, ".").replace(/[^\d.-]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

function normaliseCreateValues(module, values) {
  const normalised = { ...values };
  if (module === "orders") {
    const total = normaliseNumber(values.amount);
    const hasCost = values.cost_amount !== undefined && values.cost_amount !== null && String(values.cost_amount).trim() !== "";
    const cost = hasCost ? normaliseNumber(values.cost_amount, Number.NaN) : 0;
    if (total <= 0) throw new Error("Цена для клиента должна быть больше нуля.");
    if (!Number.isFinite(cost) || cost < 0) throw new Error("Себестоимость не может быть отрицательной.");
    normalised.amount = total.toFixed(2);
    normalised.cost_amount = hasCost ? cost.toFixed(2) : null;
    normalised.profit_amount = hasCost ? total - cost : null;
    normalised.paid_amount = "0.00";
    normalised.payment_method = "";
    normalised.payment_status = "Не оплачено";
  }
  if (module === "inventory") {
    const cost = normaliseNumber(values.cost_price);
    const sale = normaliseNumber(values.price);
    if (cost < 0 || sale < 0) throw new Error("Цены товара не могут быть отрицательными.");
    normalised.cost_price = cost.toFixed(2);
    normalised.price = sale.toFixed(2);
  }
  if (module === "services") {
    const cost = normaliseNumber(values.cost_price);
    const price = normaliseNumber(values.price);
    if (cost < 0 || price <= 0) throw new Error("Укажите цену услуги больше нуля и неотрицательную себестоимость.");
    normalised.cost_price = cost.toFixed(2);
    normalised.price = price.toFixed(2);
    normalised.profit_amount = (price - cost).toFixed(2);
  }
  if (module === "finance") {
    const amount = normaliseNumber(values.amount);
    if (amount <= 0) throw new Error("Сумма операции должна быть больше нуля.");
    normalised.amount = `${values.type === "Расход" ? "−" : "+"}${new Intl.NumberFormat("ru-RU").format(amount)} ₽`;
  }
  return normalised;
}

function databaseRecord(row) {
  const data = { ...row.data, _record_id: row.id, _created_at: row.created_at };
  data._module = row.module;
  if (row.module === "customers") {
    data.added_on = new Date(row.created_at).toLocaleDateString("ru-RU");
  }
  if (row.module === "branches") {
    data.branch = data.branch || data.name || "";
  }
  if (row.module === "orders") {
    data.number = String(row.order_number);
    data.amount = String(row.total ?? 0);
    const hasCost = data.cost_amount !== undefined && data.cost_amount !== null && data.cost_amount !== "";
    data.cost_amount = hasCost ? Number(data.cost_amount) : null;
    data.profit_amount = hasCost ? Number(row.total || 0) - data.cost_amount : null;
    data.paid_amount = String(row.paid_total ?? 0);
    data.cash_paid_total = Number(row.cash_paid_total || 0);
    data.cashless_paid_total = Number(row.cashless_paid_total || 0);
    data.payment_method = data.cash_paid_total > 0 && data.cashless_paid_total > 0
      ? "split"
      : row.payment_method || "";
    data.payment_status = row.payment_status || "Не оплачено";
    data.status = row.status || "Новый";
    data._total = Number(row.total || 0);
    data._paid_total = Number(row.paid_total || 0);
  } else {
    data.status = row.status || data.status;
    data._total = Number(row.total || 0);
  }
  return data;
}

export function money(value) {
  const amount = Number(value || 0);
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(Number.isFinite(amount) ? amount : 0)} ₽`;
}

export class CRMRepository {
  constructor(client, member) {
    this.client = client;
    this.member = member;
  }

  canManageTeam() {
    return this.hasPermission("team.manage");
  }

  isOwner() {
    return this.member.role === "owner";
  }

  hasPermission(permission) {
    return this.isOwner() || this.member.permissions?.[permission] === true;
  }

  canView(module) {
    return this.hasPermission(`${module}.view`)
      || this.hasPermission(`${module}.create`)
      || this.hasPermission(`${module}.edit`)
      || this.hasPermission(`${module}.delete`)
      || this.hasPermission(`${module}.export`)
      || (module === "orders" && (this.canPayOrders() || this.canPrintReceipt()))
      || (module === "team" && this.hasPermission("team.manage"))
      || (module === "settings" && this.hasPermission("settings.receipt"))
      || (module === "billing" && this.hasPermission("billing.manage"));
  }

  canCreate(module) {
    return this.hasPermission(`${module}.create`);
  }

  canEdit(module) {
    return this.hasPermission(`${module}.edit`);
  }

  canDelete(module) {
    return this.hasPermission(`${module}.delete`);
  }

  canImport(module) {
    return ["orders", "customers", "inventory", "services"].includes(module)
      && this.canView(module)
      && this.canCreate(module)
      && this.hasPermission(`${module}.import`);
  }

  canExport(module) {
    return this.canView(module) && this.hasPermission(`${module}.export`);
  }

  canPayOrders() {
    return this.hasPermission("orders.pay");
  }

  canPrintReceipt() {
    return this.hasPermission("orders.receipt");
  }

  async list(module, branchId) {
    if (!ACTIVE_MODULES.includes(module)) return [];
    if (!this.canView(module)) throw new Error("У вас нет права просматривать этот раздел.");
    const parameters = new URLSearchParams({
      select: "*",
      module: `eq.${module}`,
      order: module === "orders" ? "order_number.desc" : "created_at.desc",
      limit: "1000",
    });
    if (module !== "branches" && branchId && branchId !== "all") {
      parameters.set("branch_id", `eq.${branchId}`);
    }
    const rows = (await this.client.selectMany("crm_records", parameters.toString())).map(databaseRecord);
    return module === "orders" && branchId === "all"
      ? rows.sort((left, right) => Number(right.number) - Number(left.number))
      : rows;
  }

  async dashboard(branchId) {
    const [orders, finance, customers, tasks, branches, inventory] = await Promise.all([
      this.canView("orders") ? this.list("orders", branchId) : [],
      this.canView("finance") ? this.list("finance", branchId) : [],
      this.canView("customers") ? this.list("customers", branchId) : [],
      this.canView("tasks") ? this.list("tasks", branchId) : [],
      this.canView("branches") ? this.list("branches") : [],
      this.canView("inventory") ? this.list("inventory", branchId) : [],
    ]);
    return { orders, finance, customers, tasks, branches, inventory };
  }

  async create(module, values, branchId) {
    if (!ACTIVE_MODULES.includes(module)) throw new Error("Эта категория недоступна.");
    if (!this.canCreate(module)) throw new Error("У вас нет права создавать записи в этом разделе.");
    const normalised = normaliseCreateValues(module, values);
    const result = await this.client.rpc("create_crm_record", {
      p_module: module,
      p_data: normalised,
      p_branch_id: branchId && branchId !== "all" ? branchId : null,
    });
    return databaseRecord(result);
  }

  async importRecords(module, rows, branchId) {
    if (!this.canImport(module)) throw new Error("Для импорта нужны права просмотра, создания и импорта в этом разделе.");
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500) {
      throw new Error("Импорт должен содержать от 1 до 500 записей.");
    }
    return this.client.rpc("create_crm_records_batch", {
      p_module: module,
      p_records: rows.map((row) => normaliseCreateValues(module, row)),
      p_branch_id: branchId && branchId !== "all" ? branchId : null,
    });
  }

  async update(record, module, values, branchId) {
    if (!ACTIVE_MODULES.includes(module)) throw new Error("Не удалось определить тип записи.");
    if (!this.canEdit(module)) throw new Error("У вас нет права изменять записи в этом разделе.");
    const updated = { ...record, ...values };
    delete updated._record_id;
    delete updated._created_at;
    delete updated._module;
    delete updated.number;
    delete updated._total;
    delete updated._paid_total;
    const patch = { data: updated };
    if (module === "orders" && values.cost_amount !== undefined) {
      const hasCost = values.cost_amount !== null && String(values.cost_amount).trim() !== "";
      const cost = hasCost ? normaliseNumber(values.cost_amount, Number.NaN) : null;
      if (hasCost && (!Number.isFinite(cost) || cost < 0)) throw new Error("Себестоимость не может быть отрицательной.");
      patch.data.cost_amount = hasCost ? cost.toFixed(2) : null;
      patch.data.profit_amount = hasCost ? normaliseNumber(values.amount ?? record.amount) - cost : null;
    }
    if (module === "orders" && values.amount !== undefined) {
      const total = normaliseNumber(values.amount);
      if (total <= 0) throw new Error("Цена для клиента должна быть больше нуля.");
      if (total < normaliseNumber(record.paid_amount)) throw new Error("Сумма заказа не может быть меньше уже внесённой оплаты.");
      patch.data.amount = total.toFixed(2);
      const cost = values.cost_amount !== undefined ? values.cost_amount : record.cost_amount;
      patch.data.profit_amount = cost === null || cost === undefined || cost === ""
        ? null
        : total - normaliseNumber(cost);
      patch.data.payment_status = total === 0 ? "Не оплачено" : record.payment_status;
    }
    if (module === "inventory") {
      for (const key of ["cost_price", "price"]) {
        if (values[key] === undefined) continue;
        const amount = normaliseNumber(values[key], Number.NaN);
        if (!Number.isFinite(amount) || amount < 0) throw new Error("Цены товара не могут быть отрицательными.");
        patch.data[key] = amount.toFixed(2);
      }
    }
    if (module === "services") {
      const price = normaliseNumber(values.price ?? record.price, Number.NaN);
      const cost = normaliseNumber(values.cost_price ?? record.cost_price, Number.NaN);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(cost) || cost < 0) {
        throw new Error("Укажите цену услуги больше нуля и неотрицательную себестоимость.");
      }
      patch.data.price = price.toFixed(2);
      patch.data.cost_price = cost.toFixed(2);
      patch.data.profit_amount = (price - cost).toFixed(2);
    }
    const response = await this.client.update("crm_records", record._record_id, {
      ...patch,
      branch_id: module === "branches"
        ? null
        : !branchId || branchId === "all"
          ? record.branch_id || null
          : branchId,
    });
    return databaseRecord(response);
  }

  async changeStatus(record, module, status) {
    if (!this.canEdit(module)) throw new Error("У вас нет права изменять статусы записей в этом разделе.");
    if (!["orders", "tasks", "calendar", "services", "team", "branches", "automation", "documents", "reports"].includes(module)) {
      throw new Error("Для этого раздела изменение статуса отключено.");
    }
    const updated = { ...record, status };
    delete updated._record_id;
    delete updated._created_at;
    delete updated._module;
    delete updated.number;
    delete updated._total;
    delete updated._paid_total;
    const response = await this.client.update("crm_records", record._record_id, { data: updated });
    return databaseRecord(response);
  }

  async deleteRecord(record) {
    if (!this.canDelete(record._module)) throw new Error("У вас нет права удалять записи в этом разделе.");
    if (record._module === "branches" && !this.hasPermission("branches.delete")) throw new Error("У вас нет права удалять филиалы.");
    if (record._module === "branches") {
      const branches = await this.list("branches");
      const target = branches.find((branch) => branch._record_id !== record._record_id);
      if (!target) {
        throw new Error("Нельзя удалить последний филиал. Сначала создайте другой филиал, чтобы перенести туда записи и сотрудников.");
      }
      return this.client.rpc("delete_crm_branch", {
        p_branch_id: record._record_id,
        p_target_branch_id: target._record_id,
      });
    }
    await this.client.delete("crm_records", record._record_id);
    return null;
  }

  async recordPayment(record, cashAmount, cashlessAmount) {
    if (!this.canPayOrders()) throw new Error("У вас нет права принимать оплату по заказам.");
    const cash = normaliseNumber(cashAmount, Number.NaN);
    const cashless = normaliseNumber(cashlessAmount, Number.NaN);
    if (!Number.isFinite(cash) || !Number.isFinite(cashless) || cash < 0 || cashless < 0 || cash + cashless <= 0) {
      throw new Error("Введите корректную положительную сумму оплаты.");
    }
    const payment = await this.client.rpc("record_order_payment_split", {
      p_order_id: record._record_id,
      p_cash_amount: cash.toFixed(2),
      p_cashless_amount: cashless.toFixed(2),
    });
    if (!payment?.order) throw new Error("Не удалось зарегистрировать платёж: сервер не вернул обновлённый заказ.");
    return {
      order: databaseRecord(payment.order),
      transactions: (payment.transactions || []).map(databaseRecord),
    };
  }

  async users() {
    try {
      const response = await this.client.invoke("manage-users", { action: "list" });
      if (!this.isOwner()) return response;
      const members = await this.client.selectMany(
        "organization_members",
        "select=user_id,permissions&order=created_at.asc",
      );
      const membersById = new Map(members.map((member) => [member.user_id, member.permissions]));
      return {
        ...response,
        users: (response.users || []).map((user) => ({
          ...user,
          permissions: membersById.get(user.user_id) ?? user.permissions,
        })),
      };
    } catch (error) {
      if (error instanceof TypeError || error.message.includes("Failed to fetch")) {
        throw new Error("Не удалось связаться с Edge Function manage-users. Проверьте интернет, CORS и публикацию функции в вашем Supabase-проекте.");
      }
      if (error.message.includes("Requested function was not found") || error.message.includes("Function not found")) {
        throw new Error("Функция manage-users ещё не опубликована в Supabase. Создайте и разверните её по инструкции в README.md.");
      }
      throw error;
    }
  }

  async members() {
    return this.client.selectMany(
      "organization_members",
      "select=user_id,organization_id,full_name,role,status,branch_id,created_at&order=created_at.asc",
    );
  }

  async inviteUser(user) {
    if (!this.canManageTeam()) throw new Error("У вас нет права управлять сотрудниками.");
    return this.client.invoke("manage-users", { action: "create", ...user });
  }

  async repairUser(user) {
    if (!this.isOwner()) throw new Error("Восстановить доступ может только владелец компании.");
    return this.client.invoke("manage-users", { action: "repair", ...user });
  }

  async updateUser(userId, action) {
    if (!this.canManageTeam()) throw new Error("У вас нет права управлять сотрудниками.");
    return this.client.invoke("manage-users", { action, user_id: userId });
  }

  async updatePermissions(userId, permissions) {
    if (!this.isOwner()) throw new Error("Настраивать права сотрудников может только владелец компании.");
    return this.client.rpc("update_member_permissions", {
      p_user_id: userId,
      p_permissions: permissions,
    });
  }

  async saveReceiptTemplate(template) {
    if (!this.hasPermission("settings.receipt")) throw new Error("У вас нет права настраивать талон приёма.");
    const result = await this.client.rpc("update_receipt_template", { p_template: template });
    return result;
  }

  async receiptTemplate() {
    return this.client.selectOne("organizations", "select=receipt_template,id");
  }

  async ordersByPayment(branchId) {
    const orders = await this.list("orders", branchId);
    return {
      cash: orders.filter((order) => order.payment_method === "cash"),
      cashless: orders.filter((order) => order.payment_method === "cashless"),
      unpaid: orders.filter((order) => Number(order.amount || 0) > Number(order.paid_amount || 0)),
    };
  }

  async search(query, branchId) {
    const rows = await this.client.rpc("search_crm_records", {
      p_query: String(query).slice(0, 100),
      p_branch_id: branchId && branchId !== "all" ? branchId : null,
    });
    return (Array.isArray(rows) ? rows : rows ? [rows] : []).map(databaseRecord);
  }
}

export const recordValue = {
  label(value) {
    const amount = normaliseNumber(value);
    return amount.toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  },
  number(value) {
    return normaliseNumber(value);
  },
  modules: ACTIVE_MODULES,
  filterValue: encodeFilterValue,
};
