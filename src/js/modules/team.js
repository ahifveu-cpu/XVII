import { escapeHTML, icon } from "../components/icons.js";

const roleNames = {
  owner: "Владелец",
  admin: "Администратор",
  manager: "Менеджер",
  technician: "Мастер",
  cashier: "Кассир",
};

export function renderTeam(users, { canManage, canRepair, branches }) {
  const rows = users.map((user) => `
    <tr data-user-id="${escapeHTML(user.user_id)}">
      <td><div class="identity-cell"><span class="avatar avatar-purple">${escapeHTML((user.full_name || user.email || "?").trim().slice(0, 2).toUpperCase())}</span><span><strong>${escapeHTML(user.full_name || "Без имени")}${user.is_self ? " · вы" : ""}</strong><small>${escapeHTML(user.email)}</small></span></div></td>
      <td><span class="role-label">${escapeHTML(roleNames[user.role] || user.role)}</span></td>
      <td>${escapeHTML(branches.get(user.branch_id) || "Все филиалы")}</td>
      <td><span class="status-pill ${user.status === "active" ? "status-green" : "status-red"}"><span class="status-dot"></span>${user.status === "active" ? "Активен" : "Заблокирован"}</span></td>
      <td>${new Date(user.created_at).toLocaleDateString("ru-RU")}</td>
      <td>${canManage ? `<button class="icon-button user-actions" type="button" data-user-menu="${escapeHTML(user.user_id)}" aria-label="Управление сотрудником">${icon("more")}</button>` : ""}</td>
    </tr>`).join("");

  return `
    <div class="page-heading workspace-heading">
      <div><div class="eyebrow"><span class="eyebrow-dot"></span> УЧЁТНЫЕ ЗАПИСИ И ДОСТУПЫ</div><h1>Сотрудники и роли</h1><p>Добавляйте коллег и управляйте доступом к общей базе компании.</p></div>
      <div class="heading-actions">${canRepair ? `<button class="button button-secondary" data-action="repair-user">${icon("tool")} Восстановить доступ</button>` : ""}${canManage ? `<button class="button button-primary" data-action="invite-user">${icon("plus")} Добавить сотрудника</button>` : ""}</div>
    </div>
    <div class="team-security-banner">${icon("users")}<span><strong>Общая облачная база XVII.</strong> Права доступа проверяются на стороне базы при каждом действии.</span></div>
    <section class="panel table-panel">
      <div class="panel-heading"><div><h2>Учётные записи</h2><p>${users.length} ${users.length === 1 ? "сотрудник" : "сотрудников"} вашей организации · пароли передаются только через защищённый Supabase Auth</p></div></div>
      <div class="table-scroll"><table class="data-table workspace-table team-table"><thead><tr><th>СОТРУДНИК</th><th>РОЛЬ</th><th>ФИЛИАЛ</th><th>ДОСТУП</th><th>ДОБАВЛЕН</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${users.length ? `<div class="table-footer"><span>Владелец компании защищён от случайной блокировки и удаления.</span></div>` : `<div class="empty-state">${icon("users")}<strong>Сотрудников пока нет</strong><p>Пригласите коллегу, чтобы работать с общей базой.</p></div>`}
    </section>`;
}

export function rolesFor(currentRole) {
  return [
    ...(currentRole === "owner" ? [{ value: "admin", label: "Администратор" }] : []),
    { value: "manager", label: "Менеджер" },
    { value: "technician", label: "Мастер" },
    { value: "cashier", label: "Кассир" },
  ];
}

export function describeUser(user) {
  return user.full_name || user.email || user.user_id;
}
