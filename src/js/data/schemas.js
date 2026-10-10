export const pageLabels = {
  dashboard: "Обзор",
  orders: "Заказы",
  customers: "Клиенты",
  tasks: "Задачи",
  calendar: "Запись и календарь",
  inventory: "Склад",
  services: "Услуги",
  finance: "Финансы",
  documents: "Документы",
  team: "Сотрудники",
  branches: "Филиалы",
  settings: "Настройки",
  billing: "Подписка и баланс"
};

export const modules = {
  orders: {
    title: "Заказы",
    addLabel: "Новый заказ",
    subtitle: "Принимайте, редактируйте и отслеживайте заказы сервисного центра.",
    columns: [
      { key: "number", label: "Номер", kind: "order-number" },
      { key: "customer", label: "Клиент" },
      { key: "date", label: "Дата заказа", kind: "date" },
      { key: "service", label: "Услуга" },
      { key: "product", label: "Товар / запчасть" },
      { key: "category", label: "Категория" },
      { key: "device", label: "Устройство" },
      { key: "status", label: "Статус", kind: "status" },
      { key: "assignee", label: "Мастер" },
      { key: "due", label: "Срок", kind: "date" },
      { key: "amount", label: "Цена клиенту", kind: "money" },
      { key: "cost_amount", label: "Себестоимость", kind: "money" },
      { key: "profit_amount", label: "Прибыль", kind: "money" },
      { key: "paid_amount", label: "Оплачено", kind: "money" },
      { key: "cash_paid_total", label: "Оплачено наличными", kind: "money" },
      { key: "cashless_paid_total", label: "Оплачено безналично", kind: "money" },
      { key: "payment_method", label: "Способ оплаты" },
      { key: "payment_status", label: "Оплата" }
    ]
  },
  customers: {
    title: "Клиенты",
    addLabel: "Добавить клиента",
    subtitle: "Вся информация о клиентах и их обращениях в одном месте.",
    columns: [
      { key: "name", label: "Клиент", kind: "identity" },
      { key: "phone", label: "Телефон" },
      { key: "email", label: "Электронная почта" },
      { key: "notes", label: "Заметки" },
      { key: "added_on", label: "Добавлен", kind: "date" }
    ]
  },
  inventory: {
    title: "Склад",
    addLabel: "Добавить товар",
    subtitle: "Контролируйте товары, остатки и минимальный запас.",
    columns: [
      { key: "name", label: "Товар", kind: "identity" },
      { key: "sku", label: "Артикул" },
      { key: "category", label: "Категория" },
      { key: "stock_quantity", label: "Остаток", kind: "quantity" },
      { key: "min_stock", label: "Мин. остаток", kind: "quantity" },
      { key: "unit", label: "Ед. измерения" },
      { key: "cost_price", label: "Себестоимость", kind: "money" },
      { key: "price", label: "Цена продажи", kind: "money" },
      { key: "location", label: "Расположение" }
    ]
  },
  services: {
    title: "Услуги",
    addLabel: "Добавить услугу",
    subtitle: "Управляйте перечнем и ценами услуг сервисного центра.",
    columns: [
      { key: "name", label: "Услуга", kind: "identity" },
      { key: "category", label: "Категория" },
      { key: "price", label: "Цена", kind: "money" },
      { key: "cost_price", label: "Себестоимость", kind: "money" },
      { key: "profit_amount", label: "Прибыль", kind: "money" },
      { key: "duration", label: "Срок выполнения" },
      { key: "description", label: "Описание" },
      { key: "status", label: "Статус", kind: "status" }
    ]
  },
  finance: {
    title: "Финансы",
    addLabel: "Добавить операцию",
    subtitle: "Учитывайте поступления и расходы по способу оплаты.",
    columns: [
      { key: "category", label: "Операция", kind: "identity" },
      { key: "type", label: "Тип" },
      { key: "date", label: "Дата", kind: "date" },
      { key: "payment", label: "Способ оплаты" },
      { key: "amount", label: "Сумма", kind: "signed-money" }
    ]
  },
  documents: {
    title: "Документы",
    addLabel: "Добавить документ",
    subtitle: "Формируйте и храните документы по реальным заказам.",
    columns: [
      { key: "document", label: "Документ", kind: "identity" },
      { key: "type", label: "Тип" },
      { key: "number", label: "Номер" },
      { key: "date", label: "Дата", kind: "date" },
      { key: "status", label: "Статус", kind: "status" }
    ]
  },
  branches: {
    title: "Филиалы",
    addLabel: "Добавить филиал",
    subtitle: "Настраивайте подразделения и доступ сотрудников.",
    columns: [
      { key: "branch", label: "Филиал", kind: "identity" },
      { key: "address", label: "Адрес" },
      { key: "phone", label: "Телефон" },
      { key: "manager", label: "Ответственный" },
      { key: "status", label: "Статус", kind: "status" }
    ]
  },
  team: {
    title: "Сотрудники",
    addLabel: "Добавить сотрудника",
    subtitle: "Управляйте доступом пользователей CRM.",
    columns: [
      { key: "name", label: "Сотрудник", kind: "identity" },
      { key: "email", label: "Электронная почта" },
      { key: "phone", label: "Телефон" },
      { key: "role", label: "Роль" },
      { key: "branch", label: "Филиал" },
      { key: "status", label: "Доступ", kind: "status" }
    ]
  }
};

modules.tasks = {
  title: "Задачи",
  addLabel: "Добавить задачу",
  subtitle: "Назначайте поручения команде и отслеживайте их выполнение.",
  columns: [
    { key: "task", label: "Задача", kind: "identity" },
    { key: "assignee", label: "Ответственный" },
    { key: "due", label: "Срок", kind: "date" },
    { key: "priority", label: "Приоритет" },
    { key: "status", label: "Статус", kind: "status" }
  ]
};

modules.calendar = {
  title: "Запись и календарь",
  addLabel: "Добавить запись",
  subtitle: "Планируйте визиты клиентов и загрузку мастеров.",
  columns: [
    { key: "customer", label: "Клиент", kind: "identity" },
    { key: "phone", label: "Телефон" },
    { key: "service", label: "Услуга" },
    { key: "date", label: "Дата", kind: "date" },
    { key: "time", label: "Время" },
    { key: "assignee", label: "Мастер" },
    { key: "status", label: "Статус", kind: "status" }
  ]
};
