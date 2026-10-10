export const permissionModules = [
  ["dashboard", "Обзор"],
  ["orders", "Заказы"],
  ["customers", "Клиенты"],
  ["tasks", "Задачи"],
  ["calendar", "Запись и календарь"],
  ["inventory", "Склад и товары"],
  ["services", "Услуги"],
  ["finance", "Финансы"],
  ["documents", "Документы"],
  ["reports", "Отчёты"],
  ["automation", "Автоматизация"],
  ["team", "Сотрудники"],
  ["branches", "Филиалы"],
  ["settings", "Настройки"],
  ["billing", "Подписка и баланс"],
];

export const permissionActions = [
  ["view", "Просмотр"],
  ["create", "Создание"],
  ["edit", "Изменение"],
  ["delete", "Удаление"],
  ["import", "Импорт"],
  ["export", "Экспорт"],
];

export const specialPermissions = [
  ["orders.pay", "Принимать оплату по заказам"],
  ["orders.receipt", "Печатать талон приёма"],
  ["team.manage", "Создавать, блокировать и удалять сотрудников"],
  ["settings.receipt", "Настраивать шаблон талона"],
  ["billing.manage", "Управлять подпиской и балансом"],
];

export const permissionKeys = [
  ...permissionModules.flatMap(([module]) => permissionActions.map(([action]) => `${module}.${action}`)),
  ...specialPermissions.map(([key]) => key),
];

export function defaultPermissions() {
  return Object.fromEntries(permissionModules.map(([module]) => [`${module}.view`, true]));
}
